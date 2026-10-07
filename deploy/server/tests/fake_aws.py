#!/usr/bin/env python3
"""A stateful stand-in for the aws CLI, used by deploy/server/tests/provision*.test.sh.

It answers only the calls deploy/server/provision.sh makes, keeps what was "created" in the
JSON file $FAKE_AWS_STATE (so a second run sees the first run's resources) and appends every
argv, shell-quoted, to $FAKE_AWS_LOG. It ignores --query: each operation answers with the text
provision.sh asks for, and the tests pin every call's exact argv, so the two stay in step.

Knobs (environment):
  FAKE_AWS_ACCOUNT             the account get-caller-identity reports (default 455986776194)
  FAKE_AWS_DENY                "service operation" that fails with AccessDenied
  FAKE_AWS_PROFILE_NOT_READY   run-instances fails this many times with the IAM-propagation error
Nothing here talks to AWS.
"""
import json
import os
import shlex
import sys

argv = sys.argv[1:]
with open(os.environ['FAKE_AWS_LOG'], 'a') as log:
    log.write(shlex.join(['aws', *argv]) + '\n')

STATE_PATH = os.environ['FAKE_AWS_STATE']
EMPTY = {
    'role': False, 'attached': [], 'inline': None, 'profile': False, 'profile_roles': [],
    'security_groups': [], 'log_groups': {}, 'instances': [], 'run_attempts': 0,
    'topic': False, 'subscriptions': {}, 'health_checks': [], 'alarms': {},
}
state = dict(EMPTY)
if os.path.exists(STATE_PATH):
    with open(STATE_PATH) as handle:
        state.update(json.load(handle))


def save():
    with open(STATE_PATH, 'w') as handle:
        json.dump(state, handle, indent=1)


def opt(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default


def opts(name):
    if name not in argv:
        return []
    values = []
    for value in argv[argv.index(name) + 1:]:
        if value.startswith('--'):
            break
        values.append(value)
    return values


def error(code, operation, message='not found'):
    print(f'An error occurred ({code}) when calling the {operation} operation: {message}',
          file=sys.stderr)
    sys.exit(254)


def out(text=''):
    print(text)
    save()
    sys.exit(0)


service, operation = argv[0], argv[1]
if os.environ.get('FAKE_AWS_DENY') == f'{service} {operation}':
    error('AccessDenied', operation, 'User is not authorized to perform this action')

ACCOUNT = os.environ.get('FAKE_AWS_ACCOUNT', '455986776194')
TOPIC_ARN = f'arn:aws:sns:us-east-1:{ACCOUNT}:comp-alerts'

if (service, operation) == ('sts', 'get-caller-identity'):
    out(ACCOUNT)

# ---------------------------------------------------------------- iam
if service == 'iam':
    if operation == 'get-role':
        if not state['role']:
            error('NoSuchEntity', 'GetRole', 'The role with name comp-server cannot be found.')
        out(f'arn:aws:iam::{ACCOUNT}:role/comp-server')
    if operation == 'create-role':
        state['role'] = True
        out()
    if operation == 'list-attached-role-policies':
        out('\t'.join(state['attached']))
    if operation == 'attach-role-policy':
        state['attached'].append(opt('--policy-arn'))
        out()
    if operation == 'get-role-policy':
        if state['inline'] is None:
            error('NoSuchEntity', 'GetRolePolicy', 'The role policy with name comp-server cannot be found.')
        out(json.dumps(state['inline'], indent=4))
    if operation == 'put-role-policy':
        state['inline'] = json.loads(opt('--policy-document'))
        out()
    if operation == 'get-instance-profile':
        if not state['profile']:
            error('NoSuchEntity', 'GetInstanceProfile', 'Instance Profile comp-server cannot be found.')
        out('\t'.join(state['profile_roles']))
    if operation == 'create-instance-profile':
        state['profile'] = True
        out()
    if operation == 'add-role-to-instance-profile':
        state['profile_roles'].append(opt('--role-name'))
        out()

# ---------------------------------------------------------------- ec2, ssm, logs
if service == 'ec2':
    if operation == 'describe-security-groups':
        out('\n'.join(f"{group['id']}\t{group['inbound']}" for group in state['security_groups']))
    if operation == 'create-security-group':
        group_id = f"sg-0fake{len(state['security_groups']):04d}"
        state['security_groups'].append({'id': group_id, 'inbound': 0})
        out(group_id)
    if operation == 'describe-instances':
        out('\t'.join(state['instances']))
    if operation == 'run-instances':
        state['run_attempts'] += 1
        if state['run_attempts'] <= int(os.environ.get('FAKE_AWS_PROFILE_NOT_READY', '0')):
            save()
            error('InvalidParameterValue', 'RunInstances',
                  'Value (comp-server) for parameter iamInstanceProfile.name is invalid. '
                  'Invalid IAM Instance Profile name')
        instance_id = f"i-0fake{len(state['instances']):012d}"
        state['instances'].append(instance_id)
        out(instance_id)

if (service, operation) == ('ssm', 'get-parameter'):
    out('ami-0fakeal2023arm64')

if service == 'logs':
    if operation == 'describe-log-groups':
        name = opt('--log-group-name-prefix')
        if name not in state['log_groups']:
            out()
        retention = state['log_groups'][name]
        out(f"{name}\t{'None' if retention is None else retention}")
    if operation == 'create-log-group':
        state['log_groups'][opt('--log-group-name')] = None
        out()
    if operation == 'put-retention-policy':
        state['log_groups'][opt('--log-group-name')] = int(opt('--retention-in-days'))
        out()

# ---------------------------------------------------------------- sns, route53, cloudwatch
if service == 'sns':
    if operation == 'get-topic-attributes':
        if not state['topic'] or opt('--topic-arn') != TOPIC_ARN:
            error('NotFound', 'GetTopicAttributes', 'Topic does not exist')
        out(TOPIC_ARN)
    if operation == 'create-topic':
        state['topic'] = True
        out(TOPIC_ARN)
    if operation == 'list-subscriptions-by-topic':
        query = opt('--query', '')
        out('\t'.join(arn for email, arn in state['subscriptions'].items() if f"'{email}'" in query))
    if operation == 'subscribe':
        state['subscriptions'][opt('--notification-endpoint')] = 'PendingConfirmation'
        out('pending confirmation')

if service == 'route53':
    if operation == 'list-health-checks':
        query = opt('--query', '')
        out('\t'.join(check['id'] for check in state['health_checks']
                      if f"'{check['fqdn']}'" in query and f"'{check['path']}'" in query))
    if operation == 'create-health-check':
        config = json.loads(opt('--health-check-config'))
        check_id = f"fake-check-{len(state['health_checks'])}"
        state['health_checks'].append({'id': check_id, 'fqdn': config['FullyQualifiedDomainName'],
                                       'path': config['ResourcePath'], 'config': config, 'tags': {}})
        out(check_id)
    if operation in ('list-tags-for-resource', 'change-tags-for-resource'):
        check = next(c for c in state['health_checks'] if c['id'] == opt('--resource-id'))
        if operation == 'list-tags-for-resource':
            out(check['tags'].get('Project', ''))
        for tag in opts('--add-tags'):
            key, value = (part.split('=', 1)[1] for part in tag.split(','))
            check['tags'][key] = value
        out()

if service == 'cloudwatch':
    if operation == 'describe-alarms':
        out('\t'.join(name for name in opts('--alarm-names') if name in state['alarms']))
    if operation == 'put-metric-alarm':
        state['alarms'][opt('--alarm-name')] = argv
        out()

error('FakeNotImplemented', f'{service} {operation}', 'the fake aws does not know this call')
