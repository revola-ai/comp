#!/usr/bin/env bash
# Tests for deploy/server/compose.yaml. Run: bash deploy/server/tests/compose.test.sh
# Validates the stack with `docker compose config` against env files rendered from a fake
# secret (stubbed `aws`). No image is built or pulled and no container is started.
set -uo pipefail
# shellcheck source=deploy/server/tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
install_aws_stub

COMPOSE_FILE="$SERVER_DIR/compose.yaml"
TAG_VALUE="0123456789ab"
write_fixture "$TMP/secret.json"
render "$TMP/env" "$TMP/render.log" || { cat "$TMP/render.log"; exit 1; }

compose() { COMP_ENV_DIR="$TMP/env" TAG="$TAG_VALUE" docker compose -f "$COMPOSE_FILE" "$@"; }

check "docker compose config validates" compose config --quiet
compose config --format json >"$TMP/config.json" 2>"$TMP/config.err"
check "config renders as JSON" test -s "$TMP/config.json"

unset_tag() { ! COMP_ENV_DIR="$TMP/env" env -u TAG docker compose -f "$COMPOSE_FILE" config --quiet 2>"$TMP/notag.err"; }
check "refuses to run without TAG" unset_tag
check "the TAG error says what TAG is" grep -qF "12-character git sha" "$TMP/notag.err"

for target in app portal; do
  (cd "$ROOT" && bun deploy/aws/public-env.ts env "$target") >"$TMP/public-$target.txt"
done

# Assertions on the resolved model; each failing check prints "FAIL <name>".
python3 - "$TMP/config.json" "$ROOT" "$TAG_VALUE" "$TMP" "$TRICKY_VALUE" <<'PY' >"$TMP/model.log"
import ipaddress, json, re, sys

config_path, root, tag, tmp, tricky = sys.argv[1:6]
config = json.load(open(config_path))
services = config['services']
results = []

def check(name, condition):
    results.append(('ok  ' if condition else 'FAIL') + ' ' + name)

def env_names(path):
    return sorted(line.split('=', 1)[0] for line in open(path).read().splitlines() if line)

APPS = {
    'api': ('/v1/health', 3333),
    'app': ('/api/health/live', 3000),
    'portal': ('/api/health', 3000),
}
check('services are exactly api, app, portal and cloudflared',
      sorted(services) == ['api', 'app', 'cloudflared', 'portal'])

networks = config.get('networks', {})
check('one network', len(networks) == 1)
network_name, network = next(iter(networks.items()))
ipam = network.get('ipam', {}).get('config', [{}])
subnet = ipaddress.ip_network(ipam[0].get('subnet', '0.0.0.0/32'))
dynamic = ipaddress.ip_network(ipam[0].get('ip_range', '0.0.0.0/32'))
check('the network is a bridge', network.get('driver') == 'bridge')
check('the network has a fixed private subnet', subnet.is_private and subnet.prefixlen >= 16)
check('dynamic addresses come from a range inside the subnet', dynamic.subnet_of(subnet))

memory_total = 0
for name, service in services.items():
    check(f'{name}: publishes no port', not service.get('ports'))
    check(f'{name}: restarts unless stopped', service.get('restart') == 'unless-stopped')
    check(f'{name}: only on the stack network', list(service.get('networks', {})) == [network_name])
    logging = service.get('logging', {})
    options = logging.get('options', {})
    check(f'{name}: logs to CloudWatch', logging.get('driver') == 'awslogs')
    check(f'{name}: log group /comp/{name}', options.get('awslogs-group') == f'/comp/{name}')
    check(f'{name}: logs in us-east-2', options.get('awslogs-region') == 'us-east-2')
    check(f'{name}: logging never blocks the app', options.get('mode') == 'non-blocking')
    limit = int(service.get('mem_limit') or 0)
    check(f'{name}: has a memory limit', limit > 0)
    memory_total += limit
    expected_env = env_names(f'{tmp}/env/{name}.env')
    check(f'{name}: environment is exactly its env file', sorted(service.get('environment', {})) == expected_env)

# 16 GB host: the four containers stay under 6 GiB so an image build has the rest.
check('memory limits total at most 6 GiB', 0 < memory_total <= 6 * 1024 ** 3)

for name, (path, port) in APPS.items():
    service = services[name]
    build = service.get('build', {})
    check(f'{name}: image comp-{name}:<TAG>', service.get('image') == f'comp-{name}:{tag}')
    check(f'{name}: builds from the repository root', build.get('context') == root)
    check(f'{name}: builds deploy/aws/Dockerfile', build.get('dockerfile') == 'deploy/aws/Dockerfile')
    check(f'{name}: builds the {name} target', build.get('target') == name)
    check(f'{name}: never pulls its image', service.get('pull_policy') == 'never')
    test = ' '.join(service.get('healthcheck', {}).get('test', []))
    check(f'{name}: healthcheck GETs {path}', f'http://127.0.0.1:{port}{path}' in test)

for name in ('app', 'portal'):
    expected = dict(line.split('=', 1) for line in open(f'{tmp}/public-{name}.txt').read().split())
    args = services[name].get('build', {}).get('args', {})
    check(f'{name}: build args equal deploy/aws/public-env.ts', args == expected)
check('api: no build args', not services['api'].get('build', {}).get('args'))

api_env = services['api'].get('environment', {})
check('api: raw env values survive compose unchanged',
      (api_env.get('DATABASE_URL') or '').replace('$$', '$') == tricky)
for name in ('app', 'portal'):
    check(f'{name}: no INTERNAL_API_TOKEN', 'INTERNAL_API_TOKEN' not in services[name].get('environment', {}))

tunnel = services['cloudflared']
check('cloudflared: image pinned by digest',
      re.fullmatch(r'docker\.io/cloudflare/cloudflared:\d{4}\.\d+\.\d+@sha256:[0-9a-f]{64}', tunnel.get('image', '')) is not None)
check('cloudflared: runs the tunnel', tunnel.get('command') == ['tunnel', 'run'])
check('cloudflared: builds nothing', 'build' not in tunnel)
static = tunnel.get('networks', {}).get(network_name, {}) or {}
address = static.get('ipv4_address')
check('cloudflared: has a static address', address is not None)
if address:
    ip = ipaddress.ip_address(address)
    check('cloudflared: address inside the subnet', ip in subnet)
    check('cloudflared: address outside the dynamic range', ip not in dynamic)
    check('api trusts exactly the cloudflared address', api_env.get('TRUSTED_EDGE_PROXY_IPS') == address)

print('\n'.join(results))
PY
python_status=$?
cat "$TMP/model.log"
check "model assertions ran" test "$python_status" -eq 0
check "every model assertion passed" bash -c "! grep -q '^FAIL' '$TMP/model.log'"
check "compose file holds no secret value" bash -c "! grep -q fakesecret '$COMPOSE_FILE'"

finish
