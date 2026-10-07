#!/usr/bin/env bash
# Tests for deploy/server/provision.sh. Run: bash deploy/server/tests/provision.test.sh
# `aws` is a stateful fake (tests/fake_aws.py); nothing reaches AWS. Covers the fresh account
# answered "no" and "yes", the exact commands run, and the second run being a no-op.
set -uo pipefail
# shellcheck source=deploy/server/tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
install_fake_aws

ACCOUNT=455986776194
TOPIC="arn:aws:sns:us-east-1:$ACCOUNT:comp-alerts"
TAGS="Key=Name,Value=comp-server Key=Project,Value=comp"
SPEC_TAGS="Tags=[{Key=Name,Value=comp-server},{Key=Project,Value=comp}]"
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
GROUPS_=(/comp/api /comp/app /comp/portal /comp/cloudflared)
has_line() { grep -qxF -- "$2" "$1"; } # has_line <file> <exact line>

# ---------------------------------------------------------------- fresh account, all declined
provision "$(lines_of no 40)" "$TMP/no.out" --alert-email "$TEST_EMAIL"
status=$?
check "declined: exits non-zero" test "$status" -ne 0
check "declined: creates nothing" bash -c "! grep -qE '$MUTATING' '$FAKE_AWS_LOG'"
check "declined: asks once per independent create (10)" \
  test "$(grep -c 'Type yes to run it' "$TMP/no.out")" -eq 10
check "declined: checks the account first" \
  test "$(head -n 1 "$FAKE_AWS_LOG")" = "aws sts get-caller-identity --query Account --output text --region us-east-2"
for item in "IAM role comp-server (declined)" \
  "policy AmazonSSMManagedInstanceCore on role comp-server (needs IAM role comp-server)" \
  "instance profile comp-server (declined)" "security group comp-server (declined)" \
  "log group /comp/cloudflared (declined)" "30-day retention on /comp/api (needs log group /comp/api)" \
  "instance comp-server (needs role comp-server in instance profile comp-server, security group comp-server)" \
  "email subscription to comp-alerts (needs SNS topic comp-alerts)" \
  "alarm comp-app-health (needs health check comp-app, SNS topic comp-alerts)"; do
  check "declined: lists '$item'" grep -qF -- "  - $item" "$TMP/no.out"
done
check "declined: no AMI lookup for an instance it cannot launch" \
  bash -c "! grep -q 'ssm get-parameter' '$FAKE_AWS_LOG'"

# ---------------------------------------------------------------- fresh account, all confirmed
rm -f "$FAKE_AWS_STATE"
before="$(cd "$ROOT" && git status --porcelain)"
HOME="$TMP/home" provision "$(lines_of yes 40)" "$TMP/yes.out" --alert-email "$TEST_EMAIL"
status=$?
cp -f "$FAKE_AWS_LOG" "$TMP/yes.log"
check "confirmed: exits zero" test "$status" -eq 0
EXPECTED_OPS="$(
  printf '%s\n' "sts get-caller-identity" "iam get-role" "iam create-role" "iam attach-role-policy" \
    "iam put-role-policy" "iam get-instance-profile" "iam create-instance-profile" \
    "iam add-role-to-instance-profile" "ec2 describe-security-groups" "ec2 create-security-group"
  for _ in "${GROUPS_[@]}"; do
    printf '%s\n' "logs describe-log-groups" "logs create-log-group" "logs put-retention-policy"
  done
  printf '%s\n' "ec2 describe-instances" "ssm get-parameter" "ec2 run-instances" \
    "sns get-topic-attributes" "sns create-topic" "sns subscribe"
  for _ in api app; do
    printf '%s\n' "route53 list-health-checks" "route53 create-health-check" \
      "route53 change-tags-for-resource" "cloudwatch describe-alarms" "cloudwatch put-metric-alarm"
  done
)"
check "confirmed: checks before every create, in order" test "$(ops_of "$TMP/yes.log")" = "$EXPECTED_OPS"
check "confirmed: printed commands are exactly the ones run" test \
  "$(sed -n 's/^  \(aws .*\)/\1/p' "$TMP/yes.out")" = "$(mutations_in "$TMP/yes.log")"
check "confirmed: us-east-1 only for SNS and CloudWatch" bash -c "
  ! grep -vE -- '--region us-east-2\$' '$TMP/yes.log' | grep -vE '^aws (sns|cloudwatch) .*--region us-east-1\$'"
check "confirmed: SNS and CloudWatch always in us-east-1" bash -c "
  ! grep -E '^aws (sns|cloudwatch) ' '$TMP/yes.log' | grep -v -- '--region us-east-1\$'"
check "confirmed: never asks for an inbound rule" bash -c "! grep -qE 'authorize-security-group|ingress' '$TMP/yes.log'"
check "confirmed: never uses a key pair" bash -c "! grep -q -- '--key-name' '$TMP/yes.log'"

expect() { check "confirmed: runs $1" has_line "$TMP/yes.log" "$2"; }
expect "create-role" "aws iam create-role --role-name comp-server --assume-role-policy-document '$TRUST' --description 'Comp tunnel server (deploy/server/provision.sh)' --tags $TAGS --region us-east-2"
expect "attach SSM core" "aws iam attach-role-policy --role-name comp-server --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore --region us-east-2"
expect "create-instance-profile" "aws iam create-instance-profile --instance-profile-name comp-server --tags $TAGS --region us-east-2"
expect "add-role-to-instance-profile" "aws iam add-role-to-instance-profile --instance-profile-name comp-server --role-name comp-server --region us-east-2"
expect "create-security-group" "aws ec2 create-security-group --group-name comp-server --description 'Comp tunnel server: no inbound rules' --vpc-id vpc-06b67bec700b38a10 --tag-specifications 'ResourceType=security-group,$SPEC_TAGS' --query GroupId --output text --region us-east-2"
for group in "${GROUPS_[@]}"; do
  expect "create-log-group $group" "aws logs create-log-group --log-group-name $group --tags Name=$group,Project=comp --region us-east-2"
  expect "30-day retention $group" "aws logs put-retention-policy --log-group-name $group --retention-in-days 30 --region us-east-2"
done
expect "run-instances" "aws ec2 run-instances --image-id ami-0fakeal2023arm64 --instance-type t4g.xlarge --subnet-id subnet-08095a4ada58a9eef --security-group-ids sg-0fake0000 --no-associate-public-ip-address --iam-instance-profile Name=comp-server --metadata-options HttpEndpoint=enabled,HttpTokens=required,HttpPutResponseHopLimit=1 --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=60,VolumeType=gp3,Encrypted=true,DeleteOnTermination=true}' --disable-api-termination --user-data file://$SERVER_DIR/user-data.sh --tag-specifications 'ResourceType=instance,$SPEC_TAGS' 'ResourceType=volume,$SPEC_TAGS' 'ResourceType=network-interface,$SPEC_TAGS' --count 1 --query 'Instances[0].InstanceId' --output text --region us-east-2"
expect "the AMI lookup" "aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 --query Parameter.Value --output text --region us-east-2"
expect "create-topic" "aws sns create-topic --name comp-alerts --tags Key=Name,Value=comp-alerts Key=Project,Value=comp --query TopicArn --output text --region us-east-1"
expect "subscribe" "aws sns subscribe --topic-arn $TOPIC --protocol email --notification-endpoint $TEST_EMAIL --region us-east-1"
check "confirmed: api health check" grep -qE "^aws route53 create-health-check --caller-reference comp-api-[0-9]+ --health-check-config '\{\"Type\":\"HTTPS\",\"FullyQualifiedDomainName\":\"api.comp.revola.ai\",\"Port\":443,\"ResourcePath\":\"/v1/health\",\"EnableSNI\":true,\"RequestInterval\":30,\"FailureThreshold\":3\}' --query HealthCheck.Id --output text --region us-east-2$" "$TMP/yes.log"
check "confirmed: app health check (the Access redirect counts as healthy)" grep -qE "^aws route53 create-health-check --caller-reference comp-app-[0-9]+ --health-check-config '\{\"Type\":\"HTTPS\",\"FullyQualifiedDomainName\":\"app.comp.revola.ai\",\"Port\":443,\"ResourcePath\":\"/\",\"EnableSNI\":true,\"RequestInterval\":30,\"FailureThreshold\":3\}' --query HealthCheck.Id --output text --region us-east-2$" "$TMP/yes.log"
expect "health check tags" "aws route53 change-tags-for-resource --resource-type healthcheck --resource-id fake-check-0 --add-tags Key=Name,Value=comp-api Key=Project,Value=comp --region us-east-2"
expect "the api alarm" "aws cloudwatch put-metric-alarm --alarm-name comp-api-health --alarm-description 'https://api.comp.revola.ai/v1/health is failing (Route 53 health check, deploy/server/provision.sh)' --namespace AWS/Route53 --metric-name HealthCheckStatus --dimensions Name=HealthCheckId,Value=fake-check-0 --statistic Minimum --period 60 --evaluation-periods 2 --datapoints-to-alarm 2 --threshold 1 --comparison-operator LessThanThreshold --treat-missing-data breaching --alarm-actions $TOPIC --ok-actions $TOPIC --tags Key=Name,Value=comp-api-health Key=Project,Value=comp --region us-east-1"
check "confirmed: the app alarm watches the app check" grep -qF -- \
  "--alarm-name comp-app-health --alarm-description 'https://app.comp.revola.ai/ is failing" "$TMP/yes.log"
check "confirmed: the app alarm uses the app check id" grep -qF -- \
  "--dimensions Name=HealthCheckId,Value=fake-check-1 " "$TMP/yes.log"

check "role policy: exactly two statements" test "$(fake_state "len(s['inline']['Statement'])")" = 2
check "role policy: reads only comp/production/* secrets" test \
  "$(fake_state "[(x['Action'], x['Resource']) for x in s['inline']['Statement'] if x['Sid'] == 'ReadCompSecrets']")" = \
  "[('secretsmanager:GetSecretValue', 'arn:aws:secretsmanager:us-east-2:$ACCOUNT:secret:comp/production/*')]"
check "role policy: writes only the four comp log groups" test \
  "$(fake_state "[(x['Action'], x['Resource']) for x in s['inline']['Statement'] if x['Sid'] == 'WriteCompLogs']")" = \
  "[(['logs:CreateLogStream', 'logs:PutLogEvents'], ['arn:aws:logs:us-east-2:$ACCOUNT:log-group:/comp/api:*', 'arn:aws:logs:us-east-2:$ACCOUNT:log-group:/comp/app:*', 'arn:aws:logs:us-east-2:$ACCOUNT:log-group:/comp/portal:*', 'arn:aws:logs:us-east-2:$ACCOUNT:log-group:/comp/cloudflared:*'])]"
check "confirmed: reminds to confirm the subscription email" \
  grep -qF "click the confirmation link in the email sent to $TEST_EMAIL" "$TMP/yes.out"
check "confirmed: says how to reach the server" \
  grep -qF "aws ssm start-session --target i-0fake000000000000 --region us-east-2" "$TMP/yes.out"
check "confirmed: writes no file in the working directory" test -z "$(ls -A "$TMP/cwd")"
check "confirmed: writes no file in HOME" bash -c "! test -e '$TMP/home' || test -z \"\$(ls -A '$TMP/home')\""
check "confirmed: changes nothing in the repository" test "$(cd "$ROOT" && git status --porcelain)" = "$before"

# ---------------------------------------------------------------- second run
provision "" "$TMP/again.out" --alert-email "$TEST_EMAIL"
status=$?
check "second run: exits zero" test "$status" -eq 0
check "second run: creates nothing" bash -c "! grep -qE '$MUTATING' '$FAKE_AWS_LOG'"
check "second run: asks nothing" bash -c "! grep -q 'Type yes' '$TMP/again.out'"
check "second run: still reminds about the pending subscription" \
  grep -qF "click the confirmation link in the email sent to $TEST_EMAIL" "$TMP/again.out"
check "second run: no AMI lookup" bash -c "! grep -q 'ssm get-parameter' '$FAKE_AWS_LOG'"
python3 - "$FAKE_AWS_STATE" <<'PY'
import json, sys
path = sys.argv[1]
state = json.load(open(path))
state['subscriptions'] = {k: 'arn:aws:sns:us-east-1:455986776194:comp-alerts:fake-sub' for k in state['subscriptions']}
json.dump(state, open(path, 'w'))
PY
provision "" "$TMP/confirmed.out" --alert-email "$TEST_EMAIL"
check "confirmed subscription: no reminder" bash -c "! grep -q 'confirmation link' '$TMP/confirmed.out'"

# ---------------------------------------------------------------- committed files
check "provision.sh and its helpers are shellcheck clean" \
  bash -c "cd '$ROOT' && shellcheck -x deploy/server/provision.sh"
for file in "$SERVER_DIR/provision.sh" "$SERVER_DIR"/lib/*.sh "$SERVER_DIR/user-data.sh"; do
  check "$(basename "$file") is at most 300 lines" test "$(wc -l <"$file")" -le 300
done

finish
