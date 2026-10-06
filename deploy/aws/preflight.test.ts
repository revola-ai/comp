import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.ts';
import { runPreflight } from './preflight.ts';

// Spawning a freshly written script can take a second on a scanned machine; allow for it.
setDefaultTimeout(30_000);

// Every external tool is a fake executable on a PATH that contains nothing else.
// Behaviour is steered by STUB_* variables; every call is appended to calls.log.
const AWS_STUB = `#!/bin/sh
echo "aws $*" >> "$STUB_DIR/calls.log"
case "$1 $2" in
  "sts get-caller-identity") [ -n "$STUB_ACCOUNT" ] || exit 255; echo "$STUB_ACCOUNT" ;;
  "configure get") [ -n "$STUB_REGION" ] || exit 1; echo "$STUB_REGION" ;;
  "ec2 describe-route-tables")
    for arg in "$@"; do
      case "$arg" in
        Name=association.subnet-id,Values=*)
          subnet="\${arg#*Values=}"
          # PATH holds only the stubs, so use shell builtins (no cat).
          [ -f "$STUB_DIR/rt-$subnet.json" ] && { IFS= read -r line < "$STUB_DIR/rt-$subnet.json"; echo "$line"; exit 0; } ;;
      esac
    done
    echo '{"RouteTables":[]}' ;;
  *) echo "unexpected aws call: $*" >&2; exit 2 ;;
esac
`;
const BUN_STUB = `#!/bin/sh
echo "bun $*" >> "$STUB_DIR/calls.log"
case "$*" in
  *whoami*) [ "$STUB_TRIGGER" = "out" ] && { echo "not logged in" >&2; exit 1; } ;;
esac
exit 0
`;
const PLAIN_STUB = (name: string) =>
  `#!/bin/sh\necho "${name} $*" >> "$STUB_DIR/calls.log"\nexit 0\n`;

const NAT_ROUTES = {
  RouteTables: [
    {
      Routes: [
        { DestinationCidrBlock: '10.0.0.0/16', GatewayId: 'local', State: 'active' },
        {
          DestinationCidrBlock: '0.0.0.0/0',
          NatGatewayId: 'nat-0123456789abcdef0',
          State: 'active',
        },
      ],
    },
  ],
};

const saved = { ...process.env };
let stubDir = '';

function install({ tool, body }: { tool: string; body: string }): void {
  const file = join(stubDir, tool);
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}

function calls(): string {
  try {
    return readFileSync(join(stubDir, 'calls.log'), 'utf8');
  } catch {
    return '';
  }
}

beforeEach(() => {
  stubDir = mkdtempSync(join(tmpdir(), 'preflight-'));
  install({ tool: 'aws', body: AWS_STUB });
  install({ tool: 'bun', body: BUN_STUB });
  for (const tool of ['git', 'curl', 'docker']) install({ tool, body: PLAIN_STUB(tool) });
  for (const subnet of config.subnetIds) {
    writeFileSync(join(stubDir, `rt-${subnet}.json`), JSON.stringify(NAT_ROUTES));
  }
  process.env = {
    HOME: saved.HOME ?? '',
    PATH: stubDir,
    STUB_DIR: stubDir,
    STUB_ACCOUNT: config.accountId,
    STUB_REGION: config.region,
    CLOUDFLARE_API_TOKEN: 'cf-token-value',
  };
});

afterEach(() => {
  process.env = { ...saved };
  rmSync(stubDir, { recursive: true, force: true });
});

async function failureMessage(needs: Parameters<typeof runPreflight>[0]['needs']): Promise<string> {
  try {
    await runPreflight({ needs });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('runPreflight resolved but was expected to fail');
}

describe('runPreflight', () => {
  test('passes when everything is in order', async () => {
    await runPreflight({ needs: ['aws', 'cloudflare', 'trigger', 'docker'] });
  });

  test('checks every subnet route table in the configured region', async () => {
    await runPreflight({ needs: ['aws'] });
    for (const subnet of config.subnetIds) expect(calls()).toContain(subnet);
    expect(calls()).toContain(`--region ${config.region}`);
  });

  test('a wrong account names it and makes no other AWS call', async () => {
    process.env.STUB_ACCOUNT = '111111111111';
    const message = await failureMessage(['aws']);
    expect(message).toContain(
      'wrong AWS account 111111111111, expected 455986776194; set AWS_PROFILE=',
    );
    expect(calls()).not.toContain('ec2 ');
  });

  test('unusable credentials are named', async () => {
    delete process.env.STUB_ACCOUNT;
    expect(await failureMessage(['aws'])).toContain('aws sts get-caller-identity failed');
  });

  test('a wrong region is named', async () => {
    process.env.STUB_REGION = 'us-west-2';
    expect(await failureMessage(['aws'])).toContain(
      'wrong AWS region us-west-2, expected us-east-2; set AWS_REGION=us-east-2',
    );
  });

  test('AWS_REGION wins over the configured region', async () => {
    process.env.STUB_REGION = 'us-west-2';
    process.env.AWS_REGION = 'us-east-2';
    await runPreflight({ needs: ['aws'] });
  });

  test('an unset region is named', async () => {
    delete process.env.STUB_REGION;
    expect(await failureMessage(['aws'])).toContain('wrong AWS region <unset>');
  });

  test('a missing tool is named', async () => {
    rmSync(join(stubDir, 'git'));
    expect(await failureMessage(['aws'])).toContain('missing tool: git');
  });

  test('a missing docker is named only when docker is needed', async () => {
    rmSync(join(stubDir, 'docker'));
    await runPreflight({ needs: ['aws'] });
    expect(await failureMessage(['docker'])).toContain('missing tool: docker');
  });

  test('a missing CLOUDFLARE_API_TOKEN is named only when cloudflare is needed', async () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    await runPreflight({ needs: ['aws'] });
    const message = await failureMessage(['cloudflare']);
    expect(message).toContain('CLOUDFLARE_API_TOKEN is not set');
    expect(message).not.toContain('cf-token-value');
  });

  test('a Trigger.dev login that is missing is named', async () => {
    process.env.STUB_TRIGGER = 'out';
    await runPreflight({ needs: ['aws'] });
    const message = await failureMessage(['trigger']);
    expect(message).toContain('Trigger.dev is not logged in');
    expect(message).toContain(`trigger.dev@${config.triggerCliVersion} login`);
  });

  test('a subnet without a NAT route is named', async () => {
    const bad = config.subnetIds[1] as string;
    writeFileSync(
      join(stubDir, `rt-${bad}.json`),
      JSON.stringify({
        RouteTables: [
          {
            Routes: [{ DestinationCidrBlock: '10.0.0.0/16', GatewayId: 'local', State: 'active' }],
          },
        ],
      }),
    );
    const message = await failureMessage(['aws']);
    expect(message).toContain(`subnet ${bad} has no active NAT route`);
    expect(message).not.toContain(`subnet ${config.subnetIds[0]} has no`);
    expect(message).not.toContain(`subnet ${config.subnetIds[2]} has no`);
  });

  test('a blackholed NAT route does not count', async () => {
    const bad = config.subnetIds[0] as string;
    writeFileSync(
      join(stubDir, `rt-${bad}.json`),
      JSON.stringify({
        RouteTables: [
          {
            Routes: [
              {
                DestinationCidrBlock: '0.0.0.0/0',
                NatGatewayId: 'nat-0123456789abcdef0',
                State: 'blackhole',
              },
            ],
          },
        ],
      }),
    );
    expect(await failureMessage(['aws'])).toContain(`subnet ${bad} has no active NAT route`);
  });

  test('a subnet on the main route table is checked through the VPC main table', async () => {
    const bad = config.subnetIds[2] as string;
    rmSync(join(stubDir, `rt-${bad}.json`));
    // No explicit association: preflight must fall back to the VPC main route table.
    const main = JSON.stringify(NAT_ROUTES);
    writeFileSync(join(stubDir, 'rt-main.json'), main);
    const body = AWS_STUB.replace(
      '    echo \'{"RouteTables":[]}\' ;;',
      '    case "$*" in *association.main*) IFS= read -r line < "$STUB_DIR/rt-main.json"; echo "$line" ;; *) echo \'{"RouteTables":[]}\' ;; esac ;;',
    );
    install({ tool: 'aws', body });
    await runPreflight({ needs: ['aws'] });
    expect(calls()).toContain('association.main');
  });

  test('reports every failure at once', async () => {
    process.env.STUB_REGION = 'us-west-2';
    delete process.env.CLOUDFLARE_API_TOKEN;
    const message = await failureMessage(['aws', 'cloudflare']);
    expect(message).toContain('wrong AWS region');
    expect(message).toContain('CLOUDFLARE_API_TOKEN is not set');
  });
});

describe('preflight CLI', () => {
  test('prints the failure and exits non-zero', () => {
    process.env.STUB_ACCOUNT = '111111111111';
    const result = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, 'preflight.ts'), '--needs', 'aws'],
      {
        env: process.env,
      },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      'wrong AWS account 111111111111, expected 455986776194',
    );
  });

  test('exits zero when everything is in order', () => {
    const result = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, 'preflight.ts'), '--needs', 'aws,docker'],
      {
        env: process.env,
      },
    );
    expect(result.exitCode).toBe(0);
  });

  test('rejects an unknown need', () => {
    const result = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, 'preflight.ts'), '--needs', 'gcp'],
      {
        env: process.env,
      },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain('gcp');
  });
});
