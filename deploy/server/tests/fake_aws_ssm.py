"""The SSM Run Command and Secrets Manager calls of the fake aws CLI (tests/fake_aws.py), which
imports this module for them: send-command runs the command's script at once, locally, and keeps
its output in the fake's state for get-command-invocation to answer; cancel-command marks it
cancelled; get-secret-value answers with $FAKE_AWS_SECRET (render-env.sh, run by a command).

Knobs (environment):
  FAKE_AWS_SECRET              the file get-secret-value answers with (render-env.sh)
  FAKE_SSM_ROOT                ssm send-command runs its commands right away, locally, with
                               /bin/sh and COMP_ROOT=<this> (the server's /opt/comp)
  FAKE_SSM_TRUNCATE            keep this many characters of a command's output (SSM keeps 24000)
  FAKE_SSM_PENDING_POLLS       get-command-invocation answers InProgress this many times first
  FAKE_SSM_END                 "<n>:<Status>:<StatusDetails>:<ResponseCode>": command n (from 0)
                               ends that way instead, with no output (timed out, cancelled...)
  FAKE_SSM_CANCEL              cancel-command: "ok" (default; it ends Cancelled, no output) or
                               "late" (it had ended already)
  FAKE_SSM_POLL_ERRORS         "<n>" or "<n>@<command id>": the first n get-command-invocation
                               calls (of that command) fail with a ThrottlingException
  FAKE_SSM_NOT_YET             get-command-invocation of each new command answers
                               InvocationDoesNotExist this many times first, as SSM may right
                               after send-command
A send-command can be interrupted (FAKE_AWS_INTERRUPT in tests/fake_aws.py) as "ssm send-command"
(the first) or "ssm send-command fake-command-<n>" (that one), after its command ran.
"""
import json
import os
import subprocess
import sys


def handle(fake) -> None:
    """Answers the call when it is one of this module's; returns otherwise."""
    if (fake.service, fake.operation) == ('secretsmanager', 'get-secret-value'):
        with open(os.environ['FAKE_AWS_SECRET']) as handle_:
            print(handle_.read())
        sys.exit(0)  # read-only: leaves the state file to the caller (an SSM command runs this)
    if fake.service != 'ssm':
        return
    {'send-command': send, 'cancel-command': cancel,
     'get-command-invocation': invocation}.get(fake.operation, lambda _: None)(fake)


def send(fake) -> None:
    if fake.required_opt('--document-name') != 'AWS-RunShellScript':
        fake.error('InvalidDocument', 'SendCommand', 'only AWS-RunShellScript is faked')
    fake.required_opt('--timeout-seconds')
    parameters = json.loads(fake.required_opt('--parameters'))
    if not parameters.get('executionTimeout'):
        fake.error('InvalidParameters', 'SendCommand', 'set executionTimeout explicitly')
    script = '\n'.join(parameters['commands'])
    run = subprocess.run(['/bin/sh', '-c', script], capture_output=True, text=True,
                         env={**os.environ, 'COMP_ROOT': os.environ['FAKE_SSM_ROOT']})
    keep = int(os.environ.get('FAKE_SSM_TRUNCATE', '24000'))
    command_id = f"fake-command-{len(fake.state['commands'])}"
    fake.state['commands'][command_id] = {
        'instance': fake.required_opt('--instance-ids'), 'code': run.returncode, 'polls': 0,
        'stdout': run.stdout[:keep], 'stderr': run.stderr[:8000],
        'comment': fake.opt('--comment'), 'cancelled': False,
    }
    fake.interrupt('ssm send-command')
    fake.interrupt(f'ssm send-command {command_id}')
    fake.out(command_id)


def cancel(fake) -> None:
    command = fake.state['commands'].get(fake.required_opt('--command-id'))
    if command is None or command['instance'] != fake.required_opt('--instance-ids'):
        fake.error('InvalidCommandId', 'CancelCommand', 'no such command')
    command['cancelled'] = os.environ.get('FAKE_SSM_CANCEL', 'ok') == 'ok'
    fake.out()


def invocation(fake) -> None:
    command_id = fake.required_opt('--command-id')
    count, _, which = os.environ.get('FAKE_SSM_POLL_ERRORS', '0').partition('@')
    if which in ('', command_id) and fake.state.setdefault('poll_errors', 0) < int(count):
        fake.state['poll_errors'] += 1
        fake.save()
        fake.error('ThrottlingException', 'GetCommandInvocation', 'Rate exceeded')
    command = fake.state['commands'].get(command_id)
    if command is None or command['instance'] != fake.required_opt('--instance-id'):
        fake.error('InvocationDoesNotExist', 'GetCommandInvocation', 'no such invocation')
    if command.setdefault('not_yet', 0) < int(os.environ.get('FAKE_SSM_NOT_YET', '0')):
        command['not_yet'] += 1
        fake.save()
        fake.error('InvocationDoesNotExist', 'GetCommandInvocation', 'no such invocation')
    fake.interrupt(command_id)
    command['polls'] += 1
    pending = command['polls'] <= int(os.environ.get('FAKE_SSM_PENDING_POLLS', '1'))
    status = 'InProgress' if pending else ('Success' if command['code'] == 0 else 'Failed')
    details, code = status, -1 if pending else command['code']
    stdout, stderr = ('', '') if pending else (command['stdout'], command['stderr'])
    end = os.environ.get('FAKE_SSM_END', '').split(':')
    if not pending and len(end) == 4 and command_id == f'fake-command-{end[0]}':
        status, details, code, stdout, stderr = end[1], end[2], int(end[3]), '', ''
    if command.get('cancelled'):
        status, details, code, stdout, stderr = 'Cancelled', 'Cancelled', -1, '', ''
    fake.out(json.dumps({
        'Status': status, 'StatusDetails': details, 'ResponseCode': code,
        'StandardOutputContent': stdout, 'StandardErrorContent': stderr,
    }))
