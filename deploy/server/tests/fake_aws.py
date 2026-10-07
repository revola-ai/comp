#!/usr/bin/env python3
"""A stateful stand-in for the aws CLI, for the provision, release and interrupt tests in
deploy/server/tests. It answers only the calls provision.sh, release.sh and render-env.sh make,
keeps what was "created" in the JSON file $FAKE_AWS_STATE (a second run sees the first run's
resources) and appends every argv, shell-quoted, to $FAKE_AWS_LOG. It ignores --query: each
operation answers with the text the caller asks for; the tests pin every call's exact argv.

Knobs (environment):
  FAKE_AWS_ACCOUNT             the account get-caller-identity reports (default 455986776194)
  FAKE_AWS_DENY                "service operation" that fails with AccessDenied
  FAKE_AWS_PROFILE_NOT_READY   run-instances fails this many times with the IAM-propagation error
  FAKE_AWS_WARN                every successful call also writes a warning to stderr
  FAKE_AWS_PAGED               list answers come back as text pages, the first one empty
  FAKE_AWS_SECRET              the file get-secret-value answers with (render-env.sh)
  FAKE_SSM_ROOT                ssm send-command runs its commands right away, locally, with
                               /bin/sh and COMP_ROOT=<this> (the server's /opt/comp)
  FAKE_SSM_TRUNCATE            keep this many characters of a command's output (SSM keeps 24000)
  FAKE_SSM_PENDING_POLLS       get-command-invocation answers InProgress this many times first
  FAKE_SSM_END                 "<n>:<Status>:<StatusDetails>:<ResponseCode>": command n (from 0)
                               ends that way instead, with no output (timed out, cancelled...)
  FAKE_SSM_CANCEL              cancel-command: "ok" (default; it ends Cancelled, no output) or
                               "late" (it had ended already)
  FAKE_AWS_INTERRUPT           "<SIG>@<trigger>,...": once per trigger, sends SIG (INT, TERM, HUP)
                               to the process group (release.sh, as a Ctrl-C would) and dies of it
                               unanswered; a trigger is "<service> <operation>" (send-command
                               runs the command first) or a polled command id ("fake-command-0")
Nothing here talks to AWS.
"""
import json
import os
import shlex
import signal
import subprocess
import sys
import time
from typing import NoReturn

argv = sys.argv[1:]
with open(os.environ['FAKE_AWS_LOG'], 'a') as log:
    log.write(shlex.join(['aws', *argv]) + '\n')

STATE_PATH = os.environ['FAKE_AWS_STATE']
EMPTY = {
    'role': False, 'attached': [], 'inline': None, 'profile': False, 'profile_roles': [],
    'security_groups': [], 'log_groups': {}, 'instances': [], 'run_attempts': 0,
    'topic': False, 'subscriptions': {}, 'health_checks': [], 'alarms': {}, 'commands': {},
}
state = dict(EMPTY)
if os.path.exists(STATE_PATH):
    with open(STATE_PATH) as handle:
        state.update(json.load(handle))


def pages(items: list[str]) -> str:
    """Text output of a list: one line, or with FAKE_AWS_PAGED one page per item after an empty one."""
    if os.environ.get('FAKE_AWS_PAGED'):
        return '\n'.join(['', *items])
    return '\t'.join(items)


def save():
    with open(STATE_PATH, 'w') as handle:
        json.dump(state, handle, indent=1)


def opt(name: str, default: str = '') -> str:
    """An optional flag's value."""
    return argv[argv.index(name) + 1] if name in argv else default


def required_opt(name: str) -> str:
    """A flag the real CLI requires for this operation; a call without it is a test bug."""
    if name not in argv:
        error('ParamValidation', ' '.join(argv[:2]), f'missing {name}')
    return argv[argv.index(name) + 1]


def opts(name):
    if name not in argv:
        return []
    values = []
    for value in argv[argv.index(name) + 1:]:
        if value.startswith('--'):
            break
        values.append(value)
    return values


def error(code: str, operation: str, message: str = 'not found') -> NoReturn:
    print(f'An error occurred ({code}) when calling the {operation} operation: {message}',
          file=sys.stderr)
    sys.exit(254)


def out(text: str = '') -> NoReturn:
    print(text)
    if os.environ.get('FAKE_AWS_WARN'):
        print('warning: fake CLI notice on a successful call', file=sys.stderr)
    save()
    sys.exit(0)


service, operation = argv[0], argv[1]


def interrupt(trigger: str) -> None:
    """Delivers the signal FAKE_AWS_INTERRUPT names for <trigger>, once per trigger."""
    for item in filter(None, os.environ.get('FAKE_AWS_INTERRUPT', '').split(',')):
        name, _, wanted = item.partition('@')
        if wanted != trigger or item in state.setdefault('interrupted', []):
            continue
        state['interrupted'].append(item)
        save()
        signal.signal(number := getattr(signal, f'SIG{name}'), signal.SIG_DFL)
        os.killpg(os.getpgrp(), number)
        time.sleep(5)  # the signal ends this process first
        sys.exit(1)


if service != 'ssm' or operation != 'send-command':
    interrupt(f'{service} {operation}')
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
        state['attached'].append(required_opt('--policy-arn'))
        out()
    if operation == 'get-role-policy':
        if state['inline'] is None:
            error('NoSuchEntity', 'GetRolePolicy', 'The role policy with name comp-server cannot be found.')
        out(json.dumps(state['inline'], indent=4))
    if operation == 'put-role-policy':
        state['inline'] = json.loads(required_opt('--policy-document'))
        out()
    if operation == 'get-instance-profile':
        if not state['profile']:
            error('NoSuchEntity', 'GetInstanceProfile', 'Instance Profile comp-server cannot be found.')
        out('\t'.join(state['profile_roles']))
    if operation == 'create-instance-profile':
        state['profile'] = True
        out()
    if operation == 'add-role-to-instance-profile':
        state['profile_roles'].append(required_opt('--role-name'))
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
        out(pages(state['instances']))
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

# ---------------------------------------------------------------- ssm run-command, secrets
if (service, operation) == ('secretsmanager', 'get-secret-value'):
    with open(os.environ['FAKE_AWS_SECRET']) as handle:
        print(handle.read())
    sys.exit(0)  # read-only: leaves the state file to the caller (an SSM command runs this)

if (service, operation) == ('ssm', 'send-command'):
    if required_opt('--document-name') != 'AWS-RunShellScript':
        error('InvalidDocument', 'SendCommand', 'only AWS-RunShellScript is faked')
    required_opt('--timeout-seconds')
    parameters = json.loads(required_opt('--parameters'))
    if not parameters.get('executionTimeout'):
        error('InvalidParameters', 'SendCommand', 'set executionTimeout explicitly')
    script = '\n'.join(parameters['commands'])
    run = subprocess.run(['/bin/sh', '-c', script], capture_output=True, text=True,
                         env={**os.environ, 'COMP_ROOT': os.environ['FAKE_SSM_ROOT']})
    keep = int(os.environ.get('FAKE_SSM_TRUNCATE', '24000'))
    command_id = f"fake-command-{len(state['commands'])}"
    state['commands'][command_id] = {
        'instance': required_opt('--instance-ids'), 'code': run.returncode, 'polls': 0,
        'stdout': run.stdout[:keep], 'stderr': run.stderr[:8000],
        'comment': opt('--comment'), 'cancelled': False,
    }
    interrupt('ssm send-command')
    out(command_id)

if (service, operation) == ('ssm', 'cancel-command'):
    command = state['commands'].get(required_opt('--command-id'))
    if command is None or command['instance'] != required_opt('--instance-ids'):
        error('InvalidCommandId', 'CancelCommand', 'no such command')
    command['cancelled'] = os.environ.get('FAKE_SSM_CANCEL', 'ok') == 'ok'
    out()

if (service, operation) == ('ssm', 'get-command-invocation'):
    command = state['commands'].get(required_opt('--command-id'))
    if command is None or command['instance'] != required_opt('--instance-id'):
        error('InvocationDoesNotExist', 'GetCommandInvocation', 'no such invocation')
    interrupt(required_opt('--command-id'))
    command['polls'] += 1
    pending = command['polls'] <= int(os.environ.get('FAKE_SSM_PENDING_POLLS', '1'))
    status = 'InProgress' if pending else ('Success' if command['code'] == 0 else 'Failed')
    details, code = status, -1 if pending else command['code']
    stdout, stderr = ('', '') if pending else (command['stdout'], command['stderr'])
    end = os.environ.get('FAKE_SSM_END', '').split(':')
    if not pending and len(end) == 4 and required_opt('--command-id') == f'fake-command-{end[0]}':
        status, details, code, stdout, stderr = end[1], end[2], int(end[3]), '', ''
    if command.get('cancelled'):
        status, details, code, stdout, stderr = 'Cancelled', 'Cancelled', -1, '', ''
    out(json.dumps({
        'Status': status, 'StatusDetails': details, 'ResponseCode': code,
        'StandardOutputContent': stdout, 'StandardErrorContent': stderr,
    }))

if service == 'logs':
    if operation == 'describe-log-groups':
        name = required_opt('--log-group-name-prefix')
        if name not in state['log_groups']:
            out()
        retention = state['log_groups'][name]
        out(f"{name}\t{'None' if retention is None else retention}")
    if operation == 'create-log-group':
        state['log_groups'][required_opt('--log-group-name')] = None
        out()
    if operation == 'put-retention-policy':
        state['log_groups'][required_opt('--log-group-name')] = int(required_opt('--retention-in-days'))
        out()

# ---------------------------------------------------------------- sns, route53, cloudwatch
if service == 'sns':
    if operation == 'get-topic-attributes':
        if not state['topic'] or required_opt('--topic-arn') != TOPIC_ARN:
            error('NotFound', 'GetTopicAttributes', 'Topic does not exist')
        out(TOPIC_ARN)
    if operation == 'create-topic':
        state['topic'] = True
        out(TOPIC_ARN)
    if operation == 'list-subscriptions-by-topic':
        query = opt('--query', '')
        out('\t'.join(arn for email, arn in state['subscriptions'].items() if f"'{email}'" in query))
    if operation == 'subscribe':
        state['subscriptions'][required_opt('--notification-endpoint')] = 'PendingConfirmation'
        out('pending confirmation')

if service == 'route53':
    if operation == 'list-health-checks':
        query = opt('--query', '')
        out(pages([check['id'] for check in state['health_checks']
                   if f"'{check['fqdn']}'" in query and f"'{check['path']}'" in query]))
    if operation == 'create-health-check':
        config = json.loads(required_opt('--health-check-config'))
        check_id = f"fake-check-{len(state['health_checks'])}"
        state['health_checks'].append({'id': check_id, 'fqdn': config['FullyQualifiedDomainName'],
                                       'path': config['ResourcePath'], 'config': config, 'tags': {}})
        out(check_id)
    if operation in ('list-tags-for-resource', 'change-tags-for-resource'):
        check = next(c for c in state['health_checks'] if c['id'] == required_opt('--resource-id'))
        if operation == 'list-tags-for-resource':
            out(check['tags'].get('Project', ''))
        for tag in opts('--add-tags'):
            key, value = (part.split('=', 1)[1] for part in tag.split(','))
            check['tags'][key] = value
        out()

if service == 'cloudwatch':
    if operation == 'describe-alarms':  # name and HealthCheckId, one line per alarm
        out('\n'.join(f"{name}\t{state['alarms'][name]}" for name in opts('--alarm-names')
                      if name in state['alarms']))
    if operation == 'put-metric-alarm':
        dimension = required_opt('--dimensions')
        state['alarms'][required_opt('--alarm-name')] = dimension.split('Value=', 1)[1]
        out()

error('FakeNotImplemented', f'{service} {operation}', 'the fake aws does not know this call')
