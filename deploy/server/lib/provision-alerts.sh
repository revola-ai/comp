# shellcheck shell=bash
# Uptime alerts for deploy/server/provision.sh (sourced, never run on its own): Route 53 health
# checks on the public hosts and CloudWatch alarms on them, mailed through the SNS topic
# comp-alerts. Health checks are global, but their metrics exist only in us-east-1, so the
# alarms and the topic live there ($ALERT_REGION).

TOPIC_NAME=comp-alerts
TOPIC="SNS topic $TOPIC_NAME"
TOPIC_ARN="arn:aws:sns:$ALERT_REGION:$ACCOUNT:$TOPIC_NAME"
REMIND_CONFIRMATION=""
declare -A HEALTH_CHECK_ID=()

ensure_topic() {
  if probe "$TOPIC" sns get-topic-attributes --topic-arn "$TOPIC_ARN" \
    --query Attributes.TopicArn --output text --region "$ALERT_REGION"; then
    READY[$TOPIC]=1
    return 0
  fi
  create Create "$TOPIC" sns create-topic --name "$TOPIC_NAME" \
    --tags "Key=Name,Value=$TOPIC_NAME" "Key=Project,Value=$PROJECT" \
    --query TopicArn --output text --region "$ALERT_REGION"
}

# The address is used only in these AWS calls (and shown on screen); it is never written to a
# file. SNS mails a confirmation link, and the subscription delivers nothing until it is clicked.
ensure_subscription() {
  local label="email subscription to $TOPIC_NAME"
  needs "$label" "$TOPIC" || return 0
  if [[ -z "${CREATED[$TOPIC]:-}" ]]; then
    query "$label" sns list-subscriptions-by-topic --topic-arn "$TOPIC_ARN" \
      --query "Subscriptions[?Protocol=='email' && Endpoint=='$ALERT_EMAIL'].SubscriptionArn" \
      --output text --region "$ALERT_REGION"
    if [[ -n "$OUT" ]]; then
      READY[$label]=1
      if [[ "$OUT" == *PendingConfirmation* ]]; then REMIND_CONFIRMATION=1; fi
      return 0
    fi
  fi
  create Subscribe "$label" sns subscribe --topic-arn "$TOPIC_ARN" --protocol email \
    --notification-endpoint "$ALERT_EMAIL" --region "$ALERT_REGION"
  if [[ -n "${READY[$label]:-}" ]]; then REMIND_CONFIRMATION=1; fi
}

# ensure_health_check <short> <host> <path>: an HTTPS check every 30 seconds on a liveness route.
# Route 53 counts 2xx and 3xx as healthy, so the app and portal routes need a Cloudflare Access
# bypass: otherwise Access answers its login redirect at the edge even when the server is down.
ensure_health_check() {
  local short="$1" host="$2" path="$3" label="health check comp-$1" config
  local -a ids
  query "$label" route53 list-health-checks \
    --query "HealthChecks[?HealthCheckConfig.FullyQualifiedDomainName=='$host' && HealthCheckConfig.ResourcePath=='$path'].Id" \
    --output text --region "$REGION"
  words ids
  if ((${#ids[@]} > 1)); then
    PROBLEMS+=("${#ids[@]} health checks watch https://$host$path (${ids[*]}); there must be one")
    return 0
  fi
  if ((${#ids[@]} == 1)); then
    HEALTH_CHECK_ID[$short]="${ids[0]}"
    READY[$label]=1
    return 0
  fi
  config="{\"Type\":\"HTTPS\",\"FullyQualifiedDomainName\":\"$host\",\"Port\":443,\"ResourcePath\":\"$path\",\"EnableSNI\":true,\"RequestInterval\":30,\"FailureThreshold\":3}"
  # A caller reference can never be reused, even after the check is deleted.
  create Create "$label" route53 create-health-check --caller-reference "comp-$short-$(date +%s)" \
    --health-check-config "$config" --query HealthCheck.Id --output text --region "$REGION"
  if [[ -n "${READY[$label]:-}" ]]; then HEALTH_CHECK_ID[$short]="$OUT"; fi
}

ensure_health_check_tags() { # ensure_health_check_tags <short>: Name and Project, as elsewhere
  local short="$1" check="health check comp-$1" label="tags on health check comp-$1"
  needs "$label" "$check" || return 0
  if [[ -z "${CREATED[$check]:-}" ]]; then
    query "$label" route53 list-tags-for-resource --resource-type healthcheck \
      --resource-id "${HEALTH_CHECK_ID[$short]}" \
      --query "ResourceTagSet.Tags[?Key=='Project'].Value" --output text --region "$REGION"
    if [[ "$OUT" == "$PROJECT" ]]; then
      READY[$label]=1
      return 0
    fi
  fi
  create Add "$label" route53 change-tags-for-resource --resource-type healthcheck \
    --resource-id "${HEALTH_CHECK_ID[$short]}" \
    --add-tags "Key=Name,Value=comp-$short" "Key=Project,Value=$PROJECT" --region "$REGION"
}

# ensure_alarm <short> <url>: alarms after two failing minutes (and when the metric stops), and
# mails again when the check recovers. An alarm on another check (one deleted and recreated)
# is offered as an update.
ensure_alarm() {
  local short="$1" url="$2" name="comp-$1-health" label="alarm comp-$1-health" verb=Create
  local alarm watched
  needs "$label" "health check comp-$short" "$TOPIC" || return 0
  query "$label" cloudwatch describe-alarms --alarm-names "$name" \
    --query "MetricAlarms[].[AlarmName,Dimensions[?Name=='HealthCheckId'].Value|[0]]" \
    --output text --region "$ALERT_REGION"
  if [[ -n "$OUT" ]]; then
    read -r alarm watched <<<"$OUT"
    if [[ "$alarm" == "$name" && "$watched" == "${HEALTH_CHECK_ID[$short]}" ]]; then
      READY[$label]=1
      return 0
    fi
    verb=Update
  fi
  create "$verb" "$label" cloudwatch put-metric-alarm --alarm-name "$name" \
    --alarm-description "$url is failing (Route 53 health check, deploy/server/provision.sh)" \
    --namespace AWS/Route53 --metric-name HealthCheckStatus \
    --dimensions "Name=HealthCheckId,Value=${HEALTH_CHECK_ID[$short]}" \
    --statistic Minimum --period 60 --evaluation-periods 2 --datapoints-to-alarm 2 \
    --threshold 1 --comparison-operator LessThanThreshold --treat-missing-data breaching \
    --alarm-actions "$TOPIC_ARN" --ok-actions "$TOPIC_ARN" \
    --tags "Key=Name,Value=$name" "Key=Project,Value=$PROJECT" --region "$ALERT_REGION"
}

ensure_uptime_alerts() { # ensure_uptime_alerts <short> <host> <path>, for one public host
  ensure_health_check "$1" "$2" "$3"
  ensure_health_check_tags "$1"
  ensure_alarm "$1" "https://$2$3"
}
