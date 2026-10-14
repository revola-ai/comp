import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.ts';
import { renderConfigEnv, writeConfigEnv } from './write-config-env.ts';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sourceAndPrint({ file, names }: { file: string; names: string[] }): string[] {
  const script = `set -eu; . "$1"; shift; for n in "$@"; do eval "printf '%s\\n' \\"\\$$n\\""; done`;
  const result = Bun.spawnSync(['bash', '-c', script, 'bash', file, ...names]);
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trimEnd().split('\n');
}

describe('renderConfigEnv', () => {
  test('emits one KEY=value line per setting with no quoting needed', () => {
    const text = renderConfigEnv({ config });
    expect(text).toContain('COMP_ACCOUNT_ID=455986776194\n');
    expect(text).toContain('COMP_REGION=us-east-2\n');
    expect(text).toContain('COMP_HOST_API=api.comp.revola.ai\n');
    expect(text).toContain('COMP_COOKIE_DOMAIN=.comp.revola.ai\n');
    expect(text).toContain(`COMP_TRIGGER_CLI_VERSION=${config.triggerCliVersion}\n`);
    expect(text).toContain(`COMP_SUBNET_IDS=${config.subnetIds.join(',')}\n`);
    expect(text).toContain(`COMP_PROD_DB_REF_SHA256=${config.productionDbRefSha256}\n`);
    expect(text).not.toMatch(/^COMP_PROD_DB_REF=/m);
    expect(text).not.toMatch(/['"$` ]/);
  });

  test('refuses a value a shell would need to quote', () => {
    expect(() => renderConfigEnv({ config: { ...config, clusterName: 'a b; rm -rf /' } })).toThrow(
      /COMP_CLUSTER_NAME/,
    );
  });
});

describe('writeConfigEnv', () => {
  test('writes a file a shell can source back to the same values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-config-env-'));
    tempRoots.push(dir);
    const file = join(dir, 'config.env');
    writeConfigEnv({ path: file, config });
    expect(readFileSync(file, 'utf8')).toBe(renderConfigEnv({ config }));
    expect(
      sourceAndPrint({
        file,
        names: ['COMP_ACCOUNT_ID', 'COMP_SUBNET_IDS', 'COMP_RELEASE_BUCKET'],
      }),
    ).toEqual(['455986776194', config.subnetIds.join(','), 'comp-release-records-455986776194']);
  });
});
