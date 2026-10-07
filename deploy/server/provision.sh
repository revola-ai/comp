#!/usr/bin/env bash
# Creates the AWS side of the comp tunnel server (docs/plans/2026-10-07-server-tunnel-hosting.md),
# from a laptop with credentials for account 455986776194:
#
#   deploy/server/provision.sh [--alert-email ADDRESS]
#
# In us-east-2: the IAM role and instance profile comp-server (Session Manager; reads the
# comp/production/* secrets; writes to the /comp/* log groups), the security group comp-server
# (no inbound rules), the log groups /comp/{api,app,portal,cloudflared} (30-day retention) and
# the instance (t4g.xlarge, latest AL2023 arm64, private subnet, no public IP, no key pair,
# IMDSv2 with hop limit 1, 60 GB encrypted gp3, termination protection, user-data.sh). Route 53
# health checks on the api and app hosts, with alarms in us-east-1 mailed through the SNS topic
# comp-alerts to ADDRESS (asked for when not given; never written to a file).
#
# Every resource is looked up first and left alone when it exists, so a second run changes
# nothing. Each create prints its exact command and runs only when you type "yes"; anything
# else skips it (and whatever depends on it), and the run then exits non-zero listing them.
# It refuses other accounts and regions. It handles no secret.
set -euo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACCOUNT=455986776194
REGION=us-east-2
ALERT_REGION=us-east-1 # Route 53 health-check metrics exist only there
NAME=comp-server
PROJECT=comp
VPC_ID=vpc-06b67bec700b38a10
SUBNET_ID=subnet-08095a4ada58a9eef # private, with a NAT gateway
INSTANCE_TYPE=t4g.xlarge
VOLUME_GB=60
AMI_PARAMETER=/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64
LOG_GROUPS=(/comp/api /comp/app /comp/portal /comp/cloudflared)
LOG_RETENTION_DAYS=30
ALERT_EMAIL=""
export AWS_PAGER=""

usage() {
  echo "usage: $(basename "$0") [--alert-email ADDRESS]"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --alert-email)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      ALERT_EMAIL="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

# shellcheck source=deploy/server/lib/provision-common.sh
source "$SERVER_DIR/lib/provision-common.sh"
# shellcheck source=deploy/server/lib/provision-server.sh
source "$SERVER_DIR/lib/provision-server.sh"
# shellcheck source=deploy/server/lib/provision-alerts.sh
source "$SERVER_DIR/lib/provision-alerts.sh"

# Every call passes --region; a different default in the shell means the operator expects
# another region, so stop rather than guess.
for variable in AWS_REGION AWS_DEFAULT_REGION; do
  value="${!variable:-}"
  if [[ -n "$value" && "$value" != "$REGION" ]]; then
    die "$variable is $value; provision.sh only works in $REGION (unset it or set it to $REGION)"
  fi
done
for tool in aws python3; do
  command -v "$tool" >/dev/null || die "$tool is not installed"
done

if [[ -z "$ALERT_EMAIL" ]]; then
  printf 'Email address for the comp alarms (used in AWS only, never saved): '
  read -r ALERT_EMAIL || true
  [[ -t 0 ]] || echo
fi
[[ -n "$ALERT_EMAIL" ]] || die "an alert email address is required (--alert-email ADDRESS)"
if [[ ! "$ALERT_EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$ ]]; then
  die "'$ALERT_EMAIL' is not an email address"
fi

query "the caller identity" sts get-caller-identity --query Account --output text --region "$REGION"
[[ "$OUT" == "$ACCOUNT" ]] || die "these credentials are for account $OUT, not $ACCOUNT; refusing"

cat <<PLAN
Provisioning the comp tunnel server in account $ACCOUNT, $REGION (alarms and their topic in $ALERT_REGION).
Whatever exists is left alone; each missing piece is created only when you type yes at its command:
  * IAM role and instance profile $NAME (Session Manager, comp/production/* secrets, /comp/* logs)
  * security group $NAME in $VPC_ID, with no inbound rules
  * log groups ${LOG_GROUPS[*]} ($LOG_RETENTION_DAYS-day retention)
  * instance $NAME ($INSTANCE_TYPE, $SUBNET_ID, no public IP, no key pair, user-data.sh)
  * SNS topic $TOPIC_NAME with an email subscription to $ALERT_EMAIL
  * Route 53 health checks and alarms for https://api.comp.revola.ai/v1/health and https://app.comp.revola.ai/
PLAN

ensure_role
ensure_ssm_policy
ensure_role_policy
ensure_profile
ensure_profile_link
ensure_security_group
for group in "${LOG_GROUPS[@]}"; do
  ensure_log_group "$group"
done
ensure_instance
ensure_topic
ensure_subscription
ensure_uptime_alerts api api.comp.revola.ai /v1/health
ensure_uptime_alerts app app.comp.revola.ai /

if [[ -n "$INSTANCE_ID" ]]; then
  echo
  echo "The server is $INSTANCE_ID. Open a shell on it with:"
  echo "    aws ssm start-session --target $INSTANCE_ID --region $REGION"
  echo "First boot runs user-data.sh for a few minutes; 'sudo cloud-init status --wait' waits for it."
fi
if [[ -n "$REMIND_CONFIRMATION" ]]; then
  echo
  echo "Alarms reach nobody until you click the confirmation link in the email sent to $ALERT_EMAIL"
  echo "(subject 'AWS Notification - Subscription Confirmation')."
fi
finish_run
