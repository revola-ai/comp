import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import { runPreflight } from './preflight.ts';
import {
  AWS_STUB,
  calls,
  failureMessage,
  install,
  NAT_ROUTES,
  stubDirectory,
  useStubbedTools,
} from './tests/preflight-stubs.ts';

// Spawning a freshly written script can take a second on a scanned machine; allow for it.
setDefaultTimeout(30_000);
useStubbedTools();

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
    rmSync(join(stubDirectory(), 'git'));
    expect(await failureMessage(['aws'])).toContain('missing tool: git');
  });

  test('a missing docker is named only when docker is needed', async () => {
    rmSync(join(stubDirectory(), 'docker'));
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
      join(stubDirectory(), `rt-${bad}.json`),
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
      join(stubDirectory(), `rt-${bad}.json`),
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
    rmSync(join(stubDirectory(), `rt-${bad}.json`));
    // No explicit association: preflight must fall back to the VPC main route table.
    const main = JSON.stringify(NAT_ROUTES);
    writeFileSync(join(stubDirectory(), 'rt-main.json'), main);
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
