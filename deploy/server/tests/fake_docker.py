#!/usr/bin/env python3
"""A stateful stand-in for the docker CLI, used by deploy/server/tests/release*.test.sh.

It answers only the calls the server-side scripts of deploy/server/release.sh make, keeps the
images, the stack's containers and the database's migration state in the JSON file
$FAKE_DOCKER_STATE and appends every call to $FAKE_DOCKER_LOG as
"[TAG=<TAG>] [REGISTRY=<REGISTRY>] docker <argv, shell-quoted>".

State: images (refs, "comp-api:<tag>"), containers ({service: image ref} of the comp
project), migrations ("up-to-date", "pending", "failed", "ahead" (the database has a migration
this checkout lacks: Prisma 7.6's historiesDiverge output) or "unreachable").
Knobs (environment):
  FAKE_DOCKER_FAIL_UP       `compose up` with this TAG replaces the containers, then fails
  FAKE_DOCKER_FAIL_BUILD    `buildx bake` of this target fails
  FAKE_DOCKER_FAIL_TRIGGER  `trigger.dev deploy` in this apps/<project> fails
  FAKE_DOCKER_FAIL_PRUNE    `builder prune` fails
Nothing here runs a container.
"""
import json
import os
import shlex
import subprocess
import sys
from typing import NoReturn

argv = sys.argv[1:]
prefix = [f'{name}={os.environ[name]}' for name in ('TAG', 'REGISTRY') if name in os.environ]
with open(os.environ['FAKE_DOCKER_LOG'], 'a') as log:
    log.write(' '.join([*prefix, shlex.join(['docker', *argv])]) + '\n')

STATE_PATH = os.environ['FAKE_DOCKER_STATE']
state = {'images': [], 'containers': {}, 'migrations': 'up-to-date'}
if os.path.exists(STATE_PATH):
    with open(STATE_PATH) as handle:
        state.update(json.load(handle))

STACK = ('api', 'app', 'portal')
TUNNEL_IMAGE = 'docker.io/cloudflare/cloudflared:2026.10.0@sha256:fake'


def done(text: str = '', code: int = 0) -> NoReturn:
    if text:
        print(text)
    with open(STATE_PATH, 'w') as handle:
        json.dump(state, handle, indent=1)
    sys.exit(code)


def fail(message: str, code: int = 1) -> NoReturn:
    print(message, file=sys.stderr)
    done(code=code)


def env_file(name: str) -> None:
    """compose reads every env_file of a service it starts; a missing one is an error."""
    path = os.path.join(os.environ.get('COMP_ENV_DIR', '/opt/comp/env'), f'{name}.env')
    if not os.path.exists(path):
        fail(f'env file {path} not found: stat {path}: no such file or directory')


def tag() -> str:
    value = os.environ.get('TAG', '')
    if not value:
        fail('error while interpolating services.api.image: required variable TAG is missing a value')
    return value


def compose(args: list[str]) -> NoReturn:
    if args[:1] != ['-f'] or len(args) < 3:
        fail('fake docker: compose needs -f <file> first')
    args = args[2:]
    profiles = []
    while args[:1] == ['--profile']:
        profiles.append(args[1])
        args = args[2:]
    current = tag()
    command, rest = args[0], args[1:]
    if command == 'up':
        if rest != ['-d', '--no-build', '--wait', '--wait-timeout', '600']:
            fail(f'fake docker: unexpected up flags {rest}')
        for name in (*STACK, 'cloudflared'):
            env_file(name)
        missing = [f'comp-{name}:{current}' for name in STACK if f'comp-{name}:{current}' not in state['images']]
        if missing:
            fail(f'Error response from daemon: No such image: {missing[0]}')
        state['containers'] = {name: f'comp-{name}:{current}' for name in STACK}
        state['containers']['cloudflared'] = TUNNEL_IMAGE
        if os.environ.get('FAKE_DOCKER_FAIL_UP') == current:
            fail('container comp-api-1 is unhealthy')
        done('Container comp-api-1 Healthy\nContainer comp-app-1 Healthy\nContainer comp-portal-1 Healthy')
    if command == 'stop':
        state['containers'] = {}
        done('Container comp-api-1 Stopped')
    if command == 'run':
        run(profiles, rest)
    fail(f'fake docker: compose {command} is not known')


def run(profiles: list[str], args: list[str]) -> NoReturn:
    if profiles != ['tools'] or args[:3] != ['--rm', '-T', '--no-deps']:
        fail(f'fake docker: one-off runs need --profile tools run --rm -T --no-deps, got {profiles} {args}')
    args = args[3:]
    env, workdir = {}, ''
    while args and args[0] in ('-e', '-w'):
        if args[0] == '-e':
            key, _, value = args[1].partition('=')
            env[key] = value
        else:
            workdir = args[1]
        args = args[2:]
    service, argv_in, command = args[0], args[1:], ' '.join(args[1:])
    if f'comp-migrate:{tag()}' not in state['images']:
        fail(f'Error response from daemon: No such image: comp-migrate:{tag()}')
    env_file(service)
    if service == 'migrate':
        verified_url(argv_in)
        migrate(command, env)
    if service == 'trigger':
        project = workdir.rsplit('/', 1)[-1]
        if 'trigger.dev@' not in command or 'deploy --env prod' not in command:
            fail(f'fake docker: unexpected trigger command {command}')
        if os.environ.get('FAKE_DOCKER_FAIL_TRIGGER') == project:
            fail(f'Error: deploy of {project} failed (fake)')
        done(f'Successfully deployed version 20261007.1 of {project} (fake)')
    fail(f'fake docker: unknown tools service {service}')


def verified_url(argv_in: list[str]) -> None:
    """Runs the container's own URL rewrite (everything before `exec bunx`) with real node and
    the rendered migrate.env, as the container would; its stderr is what compose would show."""
    if argv_in[:2] != ['sh', '-c'] or 'exec bunx prisma' not in argv_in[2]:
        fail(f'fake docker: migrate runs sh -c "<url rewrite> exec bunx prisma ...", got {argv_in}')
    path = os.path.join(os.environ.get('COMP_ENV_DIR', '/opt/comp/env'), 'migrate.env')
    with open(path) as handle:
        values = dict(line.split('=', 1) for line in handle.read().splitlines() if '=' in line)
    check = argv_in[2].split('exec bunx prisma')[0] + \
        'case "$DATABASE_URL" in *sslaccept=strict*) ;; *) exit 3 ;; esac'
    run = subprocess.run(['sh', '-c', check], capture_output=True, text=True,
                         env={**os.environ, **values, 'DATABASE_SSL_CA': '/app/certs/supabase-ca.crt'})
    if run.returncode != 0:
        fail(run.stderr + run.stdout)


def migrate(command: str, env: dict[str, str]) -> NoReturn:
    if 'sslaccept' not in command:
        fail('fake docker: prisma runs without the verified-TLS url')
    status = state['migrations']
    if status == 'unreachable':
        fail("Error: P1001: Can't reach database server")
    if command.endswith('prisma migrate status'):
        if status == 'pending':
            done('Following migration have not yet been applied:\n20261001000000_add_widget\n\n'
                 'To apply migrations in production run prisma migrate deploy.', 1)
        if status == 'failed':
            done('Following migration have failed:\n20261001000000_add_widget', 1)
        if status == 'ahead':
            done('Your local migration history and the migrations table from your database are different:\n\n'
                 'The last common migration is: 20260901000000_init\n\n'
                 'The migration have not yet been applied:\n20261001000000_add_widget\n\n'
                 'The migration from the database are not found locally in prisma/migrations:\n'
                 '20261005000000_newer_widget', 1)
        done('Database schema is up to date!')
    if command.endswith('prisma migrate deploy'):
        if env.get('COMP_I_AM_TOUCHING_PROD') != '1':
            fail('refusing `prisma migrate deploy`: production_target_refused')
        state['migrations'] = 'up-to-date'
        done('Applying migration `20261001000000_add_widget`\nAll migrations have been successfully applied.')
    fail(f'fake docker: unexpected migrate command {command}')


if argv[:2] == ['image', 'inspect']:
    if argv[2] in state['images']:
        done('[{}]')
    fail(f'Error response from daemon: No such image: {argv[2]}')
if argv[:2] == ['buildx', 'bake']:
    if argv[2:5] != ['-f', 'deploy/aws/docker-bake.hcl', '--load'] or len(argv) != 6:
        fail(f'fake docker: unexpected bake {argv}')
    if os.environ.get('REGISTRY', 'unset') != '':
        fail('fake docker: bake without REGISTRY= would push')
    target = argv[5]
    if os.environ.get('FAKE_DOCKER_FAIL_BUILD') == target:
        fail(f'ERROR: target {target}: failed to solve (fake)')
    state['images'].append(f'comp-{target}:{tag()}')
    done(f'#1 [{target}] built (fake)')
if argv[:1] == ['compose']:
    compose(argv[1:])
if argv[:1] == ['ps']:
    if argv[-1] == '{{.Image}}':
        done('\n'.join(state['containers'].values()))
    done('\n'.join(f'comp-{name}-1\t{image}\tUp 3 minutes (healthy)' for name, image in state['containers'].items()))
if argv[:3] == ['image', 'ls', '--format']:
    done('\n'.join(state['images']))
if argv[:2] == ['image', 'rm']:
    ref = argv[2]
    if ref not in state['images']:
        fail(f'Error response from daemon: No such image: {ref}')
    if ref in state['containers'].values():
        fail(f'Error response from daemon: conflict: unable to remove repository reference "{ref}"')
    state['images'].remove(ref)
    done(f'Untagged: {ref}')
if argv[:2] == ['builder', 'prune']:
    if os.environ.get('FAKE_DOCKER_FAIL_PRUNE'):
        fail('ERROR: failed to prune build cache (fake)')
    done('Total:\t1.5GB')
fail(f'fake docker: {shlex.join(argv)} is not known')
