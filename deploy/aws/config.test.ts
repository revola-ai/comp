import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import productionTarget from '../../packages/db/production-target.json' with { type: 'json' };
import { config, loadConfig } from './config.ts';

const validTarget = {
  projectRefSha256: 'a'.repeat(64),
  poolerHost: 'aws-0-x.pooler.supabase.com',
};
const tempRoots: string[] = [];

type Manifest = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

function makeRepo({ api, app }: { api: Manifest; app: Manifest }): string {
  const root = mkdtempSync(join(tmpdir(), 'deploy-config-'));
  tempRoots.push(root);
  for (const [name, manifest] of [
    ['api', api],
    ['app', app],
  ] as const) {
    mkdirSync(join(root, 'apps', name), { recursive: true });
    writeFileSync(join(root, 'apps', name, 'package.json'), JSON.stringify(manifest));
  }
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('config values', () => {
  test('equal the global constraints', () => {
    expect(config.accountId).toBe('455986776194');
    expect(config.region).toBe('us-east-2');
    expect(config.clusterName).toBe('revola-cluster');
    expect(config.albName).toBe('revola-production-alb');
    expect(config.albDnsName).toBe('revola-production-alb-1399285125.us-east-2.elb.amazonaws.com');
    expect(config.albSecurityGroupId).toBe('sg-0eb10c6d5c5fd239b');
    expect(config.vpcId).toBe('vpc-06b67bec700b38a10');
    expect(config.subnetIds).toEqual([
      'subnet-08095a4ada58a9eef',
      'subnet-0284c89a912e76d71',
      'subnet-0d4308baa95e7f157',
    ]);
    expect(config.hosts).toEqual({
      api: 'api.comp.revola.ai',
      app: 'app.comp.revola.ai',
      portal: 'portal.comp.revola.ai',
    });
    expect(config.cookieDomain).toBe('.comp.revola.ai');
    expect(config.releaseBucket).toBe('comp-release-records-455986776194');
    expect(config.lockTable).toBe('comp-release-lock');
    expect(config.terraformStateBucket).toBe('comp-terraform-state-455986776194');
  });

  test('the cookie domain covers every host', () => {
    for (const host of Object.values(config.hosts)) {
      expect(host.endsWith(config.cookieDomain)).toBe(true);
    }
  });

  test('the production identity equals packages/db/production-target.json (ref as a hash)', () => {
    expect(config.productionDbRefSha256).toBe(productionTarget.projectRefSha256);
    expect(config.productionPoolerHost).toBe(productionTarget.poolerHost);
    expect(config).not.toHaveProperty('productionDbRef');
  });

  test('validates the target with the shared packages/db schema, not a copy', () => {
    const source = readFileSync(join(import.meta.dir, 'config.ts'), 'utf8');
    expect(source).toContain("from '../../packages/db/scripts/production-target.ts'");
    expect(source).not.toMatch(/projectRefSha256:\s*z\./);
    expect(source).not.toMatch(/poolerHost:\s*z\./);
  });

  test('the Trigger CLI version is the repo pin', () => {
    expect(config.triggerCliVersion).toBe('4.4.3');
  });

  test('is deeply frozen', () => {
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.hosts)).toBe(true);
    expect(Object.isFrozen(config.subnetIds)).toBe(true);
  });
});

describe('loadConfig', () => {
  test('reads the Trigger CLI version from both apps when they agree', () => {
    const repoRoot = makeRepo({
      api: {
        devDependencies: { 'trigger.dev': '4.4.3' },
        dependencies: { '@trigger.dev/sdk': '4.4.3' },
      },
      app: {
        devDependencies: { 'trigger.dev': '4.4.3' },
        dependencies: { '@trigger.dev/react-hooks': '4.4.3' },
      },
    });
    expect(loadConfig({ repoRoot, productionTarget: validTarget }).triggerCliVersion).toBe('4.4.3');
  });

  test('throws naming both files when api and app disagree', () => {
    const repoRoot = makeRepo({
      api: { devDependencies: { 'trigger.dev': '4.4.3' } },
      app: { devDependencies: { 'trigger.dev': '4.4.4' } },
    });
    expect(() => loadConfig({ repoRoot, productionTarget: validTarget })).toThrow(
      /apps\/api\/package\.json.*4\.4\.3.*apps\/app\/package\.json.*4\.4\.4/s,
    );
  });

  test('throws when one app pins two different Trigger versions', () => {
    const repoRoot = makeRepo({
      api: {
        devDependencies: { 'trigger.dev': '4.4.3' },
        dependencies: { '@trigger.dev/sdk': '4.4.2' },
      },
      app: { devDependencies: { 'trigger.dev': '4.4.3' } },
    });
    expect(() => loadConfig({ repoRoot, productionTarget: validTarget })).toThrow(
      /apps\/api\/package\.json/,
    );
  });

  test('throws when a Trigger version is a range instead of a pin', () => {
    const repoRoot = makeRepo({
      api: { devDependencies: { 'trigger.dev': '^4.4.3' } },
      app: { devDependencies: { 'trigger.dev': '^4.4.3' } },
    });
    expect(() => loadConfig({ repoRoot, productionTarget: validTarget })).toThrow(/trigger/i);
  });

  test('throws when an app has no Trigger.dev dependency', () => {
    const repoRoot = makeRepo({
      api: { devDependencies: { 'trigger.dev': '4.4.3' } },
      app: { devDependencies: {} },
    });
    expect(() => loadConfig({ repoRoot, productionTarget: validTarget })).toThrow(
      /apps\/app\/package\.json/,
    );
  });

  test('rejects a malformed project ref hash', () => {
    const repoRoot = makeRepo({
      api: { devDependencies: { 'trigger.dev': '4.4.3' } },
      app: { devDependencies: { 'trigger.dev': '4.4.3' } },
    });
    expect(() =>
      loadConfig({
        repoRoot,
        productionTarget: { ...validTarget, projectRefSha256: 'Not-A-Hash' },
      }),
    ).toThrow(/projectRefSha256/);
  });

  test('rejects a target that carries the plain project ref', () => {
    const repoRoot = makeRepo({
      api: { devDependencies: { 'trigger.dev': '4.4.3' } },
      app: { devDependencies: { 'trigger.dev': '4.4.3' } },
    });
    expect(() =>
      loadConfig({
        repoRoot,
        productionTarget: { ...validTarget, projectRef: 'abcdefghij0123456789' },
      }),
    ).toThrow();
  });

  test('rejects a pooler host outside pooler.supabase.com', () => {
    const repoRoot = makeRepo({
      api: { devDependencies: { 'trigger.dev': '4.4.3' } },
      app: { devDependencies: { 'trigger.dev': '4.4.3' } },
    });
    expect(() =>
      loadConfig({ repoRoot, productionTarget: { ...validTarget, poolerHost: 'db.example.com' } }),
    ).toThrow(/poolerHost/);
  });
});
