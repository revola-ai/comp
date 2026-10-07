# shellcheck shell=bash
# The server's own resources for deploy/server/provision.sh (sourced, never run on its own):
# IAM role and instance profile, security group, log groups and the instance. Uses the
# constants and helpers of provision.sh and lib/provision-common.sh.

ROLE="IAM role $NAME"
PROFILE="instance profile $NAME"
PROFILE_LINK="role $NAME in instance profile $NAME"
SECURITY_GROUP="security group $NAME"
SECURITY_GROUP_ID=""
INSTANCE_ID=""
PROFILE_ROLES=""

IAM_TAGS=("Key=Name,Value=$NAME" "Key=Project,Value=$PROJECT")
SPEC_TAGS="Tags=[{Key=Name,Value=$NAME},{Key=Project,Value=$PROJECT}]"
SSM_POLICY_ARN=arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
TRUST_POLICY='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

role_policy() { # the inline policy: read comp/production/* secrets, write to the comp log groups
  local group resources=""
  for group in "${LOG_GROUPS[@]}"; do
    resources+="${resources:+,}\"arn:aws:logs:$REGION:$ACCOUNT:log-group:$group:*\""
  done
  printf '%s' '{"Version":"2012-10-17","Statement":[' \
    '{"Sid":"ReadCompSecrets","Effect":"Allow","Action":"secretsmanager:GetSecretValue",' \
    "\"Resource\":\"arn:aws:secretsmanager:$REGION:$ACCOUNT:secret:comp/production/*\"}," \
    '{"Sid":"WriteCompLogs","Effect":"Allow","Action":["logs:CreateLogStream","logs:PutLogEvents"],' \
    "\"Resource\":[$resources]}]}"
}

ensure_role() {
  if probe "$ROLE" iam get-role --role-name "$NAME" --query Role.Arn --output text --region "$REGION"; then
    READY[$ROLE]=1
    return 0
  fi
  create Create "$ROLE" iam create-role --role-name "$NAME" \
    --assume-role-policy-document "$TRUST_POLICY" \
    --description "Comp tunnel server (deploy/server/provision.sh)" \
    --tags "${IAM_TAGS[@]}" --region "$REGION"
}

ensure_ssm_policy() { # Session Manager, the only way onto the server
  local label="policy AmazonSSMManagedInstanceCore on role $NAME"
  needs "$label" "$ROLE" || return 0
  if [[ -z "${CREATED[$ROLE]:-}" ]]; then
    query "$label" iam list-attached-role-policies --role-name "$NAME" \
      --query 'AttachedPolicies[].PolicyArn' --output text --region "$REGION"
    if [[ "$OUT" == *"$SSM_POLICY_ARN"* ]]; then
      READY[$label]=1
      return 0
    fi
  fi
  create Attach "$label" iam attach-role-policy --role-name "$NAME" \
    --policy-arn "$SSM_POLICY_ARN" --region "$REGION"
}

ensure_role_policy() { # created when missing, rewritten when it differs from role_policy
  local label="inline policy $NAME on role $NAME" verb=Create policy
  policy="$(role_policy)"
  needs "$label" "$ROLE" || return 0
  if [[ -z "${CREATED[$ROLE]:-}" ]] && probe "$label" iam get-role-policy --role-name "$NAME" \
    --policy-name "$NAME" --query PolicyDocument --output json --region "$REGION"; then
    if same_json "$OUT" "$policy"; then
      READY[$label]=1
      return 0
    fi
    verb=Update
  fi
  create "$verb" "$label" iam put-role-policy --role-name "$NAME" --policy-name "$NAME" \
    --policy-document "$policy" --region "$REGION"
}

ensure_profile() {
  if probe "$PROFILE" iam get-instance-profile --instance-profile-name "$NAME" \
    --query 'InstanceProfile.Roles[].RoleName' --output text --region "$REGION"; then
    PROFILE_ROLES="$OUT"
    READY[$PROFILE]=1
    return 0
  fi
  create Create "$PROFILE" iam create-instance-profile --instance-profile-name "$NAME" \
    --tags "${IAM_TAGS[@]}" --region "$REGION"
}

ensure_profile_link() { # an instance profile holds at most one role
  needs "$PROFILE_LINK" "$ROLE" "$PROFILE" || return 0
  if [[ "$PROFILE_ROLES" == "$NAME" ]]; then
    READY[$PROFILE_LINK]=1
    return 0
  fi
  if [[ -n "$PROFILE_ROLES" ]]; then
    PROBLEMS+=("$PROFILE holds role(s) $PROFILE_ROLES instead of $NAME")
    return 0
  fi
  create Place "$PROFILE_LINK" iam add-role-to-instance-profile --instance-profile-name "$NAME" \
    --role-name "$NAME" --region "$REGION"
}

ensure_security_group() { # no inbound rule is ever added; the default egress rule stays
  local id inbound
  query "$SECURITY_GROUP" ec2 describe-security-groups \
    --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=$NAME" \
    --query 'SecurityGroups[].[GroupId,length(IpPermissions)]' --output text --region "$REGION"
  if [[ -n "$OUT" ]]; then
    read -r id inbound <<<"$OUT"
    SECURITY_GROUP_ID="$id"
    if [[ "$inbound" != 0 ]]; then
      PROBLEMS+=("$SECURITY_GROUP ($id) has $inbound inbound rule(s); remove them (the server takes no inbound traffic)")
      return 0
    fi
    READY[$SECURITY_GROUP]=1
    return 0
  fi
  create Create "$SECURITY_GROUP" ec2 create-security-group --group-name "$NAME" \
    --description "Comp tunnel server: no inbound rules" --vpc-id "$VPC_ID" \
    --tag-specifications "ResourceType=security-group,$SPEC_TAGS" \
    --query GroupId --output text --region "$REGION"
  if [[ -n "${READY[$SECURITY_GROUP]:-}" ]]; then SECURITY_GROUP_ID="$OUT"; fi
}

ensure_log_group() { # ensure_log_group <name>: the group, with the retention set
  local group="$1" label="log group $1" retention_label="$LOG_RETENTION_DAYS-day retention on $1"
  local retention=""
  query "$label" logs describe-log-groups --log-group-name-prefix "$group" \
    --query "logGroups[?logGroupName=='$group'].[logGroupName,retentionInDays]" \
    --output text --region "$REGION"
  if [[ -n "$OUT" ]]; then
    READY[$label]=1
    retention="${OUT##*$'\t'}"
  else
    create Create "$label" logs create-log-group --log-group-name "$group" \
      --tags "Name=$group,Project=$PROJECT" --region "$REGION"
  fi
  needs "$retention_label" "$label" || return 0
  if [[ "$retention" == "$LOG_RETENTION_DAYS" ]]; then
    READY[$retention_label]=1
    return 0
  fi
  create Set "$retention_label" logs put-retention-policy --log-group-name "$group" \
    --retention-in-days "$LOG_RETENTION_DAYS" --region "$REGION"
}

ensure_instance() {
  local label="instance $NAME" ami
  local -a ids
  query "$label" ec2 describe-instances \
    --filters "Name=tag:Name,Values=$NAME" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[].InstanceId' --output text --region "$REGION"
  read -ra ids <<<"$OUT"
  if ((${#ids[@]} > 1)); then
    PROBLEMS+=("${#ids[@]} instances are tagged Name=$NAME (${ids[*]}); there must be one")
    return 0
  fi
  if ((${#ids[@]} == 1)); then
    INSTANCE_ID="${ids[0]}"
    READY[$label]=1
    return 0
  fi
  needs "$label" "$PROFILE_LINK" "$SECURITY_GROUP" || return 0
  query "the latest Amazon Linux 2023 arm64 AMI" ssm get-parameter --name "$AMI_PARAMETER" \
    --query Parameter.Value --output text --region "$REGION"
  ami="$OUT"
  # A new instance profile takes a few seconds to reach EC2.
  local RETRY_ON="Invalid IAM Instance Profile"
  create Launch "$label" ec2 run-instances --image-id "$ami" --instance-type "$INSTANCE_TYPE" \
    --subnet-id "$SUBNET_ID" --security-group-ids "$SECURITY_GROUP_ID" \
    --no-associate-public-ip-address --iam-instance-profile "Name=$NAME" \
    --metadata-options HttpEndpoint=enabled,HttpTokens=required,HttpPutResponseHopLimit=1 \
    --block-device-mappings "DeviceName=/dev/xvda,Ebs={VolumeSize=$VOLUME_GB,VolumeType=gp3,Encrypted=true,DeleteOnTermination=true}" \
    --disable-api-termination --user-data "file://$SERVER_DIR/user-data.sh" \
    --tag-specifications "ResourceType=instance,$SPEC_TAGS" "ResourceType=volume,$SPEC_TAGS" \
    "ResourceType=network-interface,$SPEC_TAGS" \
    --count 1 --query 'Instances[0].InstanceId' --output text --region "$REGION"
  if [[ -n "${READY[$label]:-}" ]]; then INSTANCE_ID="$OUT"; fi
}
