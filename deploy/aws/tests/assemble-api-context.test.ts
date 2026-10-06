import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Runs assemble-api-context.sh against a fixture monorepo shaped like the api build stage:
// a dev tree with build output (repo) and a production-only install of the same lockfile
// (prod), whose workspace links point at packages that the runtime image does not have.

const SCRIPT = join(import.meta.dir, '../assemble-api-context.sh');
const REAL_ESBUILD = join(import.meta.dir, '../../../node_modules/.bin/esbuild');
const PACKAGES = ['auth', 'billing', 'company', 'db', 'email', 'integration-platform', 'utils'];

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function put({ path, content }: { path: string; content: string }): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

type Layout = 'standard' | 'composite' | 'none';

function makeFixture({ layout }: { layout: Layout }): { repo: string; prod: string; out: string } {
  const root = mkdtempSync(join(tmpdir(), 'assemble-'));
  tempRoots.push(root);
  const repo = join(root, 'repo');
  const prod = join(root, 'prod');
  const api = join(repo, 'apps/api');
  put({ path: join(api, 'package.json'), content: '{"name":"@trycompai/api"}' });
  put({ path: join(api, 'prisma/client.js'), content: 'stale committed client' });
  put({ path: join(api, 'prisma/schema/schema.prisma'), content: 'generator client {}' });
  put({ path: join(api, 'prisma/schema/user.prisma'), content: 'model User {}' });
  put({ path: join(api, 'src/main.ts'), content: 'source' });
  put({ path: join(api, 'src/soa/seedJson/ISO/config.json'), content: '[]' });
  const distRoot = layout === 'composite' ? join(api, 'dist/apps/api') : join(api, 'dist');
  if (layout !== 'none') put({ path: join(distRoot, 'src/main.js'), content: 'built main' });
  put({ path: join(distRoot, 'prisma/client.js'), content: 'built client' });
  put({ path: join(repo, 'node_modules/.prisma/client/index.js'), content: 'generated' });
  mkdirSync(join(repo, 'node_modules/.bin'), { recursive: true });
  symlinkSync(REAL_ESBUILD, join(repo, 'node_modules/.bin/esbuild'));

  for (const name of PACKAGES) {
    const dir = join(repo, 'packages', name);
    if (name === 'utils') {
      put({
        path: join(dir, 'package.json'),
        content: JSON.stringify({
          name: '@trycompai/utils',
          main: 'src/index.ts',
          exports: { '.': './src/index.ts', './devices': './src/devices.ts' },
        }),
      });
      put({ path: join(dir, 'src/index.ts'), content: "export * from './devices';\n" });
      put({
        path: join(dir, 'src/devices.ts'),
        content: 'export function pick<T>(items: T[]): T | undefined { return items[0]; }\n',
      });
    } else {
      put({ path: join(dir, 'package.json'), content: JSON.stringify({ name: `@trycompai/${name}` }) });
      put({ path: join(dir, 'dist/index.js'), content: `module.exports = '${name}';` });
      put({ path: join(dir, 'src/index.ts'), content: 'source' });
    }
    mkdirSync(join(prod, 'node_modules/@trycompai'), { recursive: true });
    symlinkSync(`../../packages/${name}`, join(prod, 'node_modules/@trycompai', name));
  }
  symlinkSync('../../packages/tsconfig', join(prod, 'node_modules/@trycompai/tsconfig'));
  put({ path: join(prod, 'node_modules/zod/index.js'), content: 'zod' });
  put({ path: join(prod, 'apps/api/node_modules/ai/index.js'), content: 'api-only ai' });
  put({ path: join(prod, 'packages/email/node_modules/resend/index.js'), content: 'email resend' });
  return { repo, prod, out: join(root, 'out') };
}

function assemble({ repo, prod, out }: { repo: string; prod: string; out: string }) {
  const result = Bun.spawnSync(['bash', SCRIPT, '--repo', repo, '--prod', prod, '--out', out]);
  return { code: result.exitCode, stderr: result.stderr.toString() };
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('assemble-api-context.sh', () => {
  test('assembles the standard dist layout into a runnable tree', () => {
    const fixture = makeFixture({ layout: 'standard' });
    const { code, stderr } = assemble(fixture);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    const api = join(fixture.out, 'apps/api');
    expect(read(join(api, 'src/main.js'))).toBe('built main');
    expect(read(join(api, 'prisma/client.js'))).toBe('built client');
    expect(readdirSync(join(api, 'prisma/schema')).sort()).toEqual(['schema.prisma', 'user.prisma']);
    expect(read(join(api, 'src/soa/seedJson/ISO/config.json'))).toBe('[]');
    expect(existsSync(join(api, 'src/main.ts'))).toBe(false);
    expect(read(join(api, 'package.json'))).toContain('@trycompai/api');
    expect(read(join(api, 'node_modules/ai/index.js'))).toBe('api-only ai');
    expect(read(join(fixture.out, 'node_modules/zod/index.js'))).toBe('zod');
    expect(read(join(fixture.out, 'node_modules/.prisma/client/index.js'))).toBe('generated');
  });

  test('accepts the composite dist layout', () => {
    const fixture = makeFixture({ layout: 'composite' });
    expect(assemble(fixture).code).toBe(0);
    expect(read(join(fixture.out, 'apps/api/src/main.js'))).toBe('built main');
  });

  test('replaces every workspace link with a real package and drops links it does not ship', () => {
    const fixture = makeFixture({ layout: 'standard' });
    expect(assemble(fixture).code).toBe(0);
    const scope = join(fixture.out, 'node_modules/@trycompai');
    expect(readdirSync(scope).sort()).toEqual([...PACKAGES].sort());
    for (const name of PACKAGES) {
      expect(lstatSync(join(scope, name)).isSymbolicLink()).toBe(false);
      expect(existsSync(join(scope, name, 'package.json'))).toBe(true);
    }
    expect(read(join(scope, 'db/dist/index.js'))).toContain('db');
    expect(existsSync(join(scope, 'db/src'))).toBe(false);
    expect(read(join(scope, 'email/node_modules/resend/index.js'))).toBe('email resend');
  });

  test('ships utils as CommonJS that node can require from the api directory', () => {
    const fixture = makeFixture({ layout: 'standard' });
    expect(assemble(fixture).code).toBe(0);
    const run = Bun.spawnSync(
      ['node', '-e', "console.log(require('@trycompai/utils/devices').pick([7]))"],
      { cwd: join(fixture.out, 'apps/api') },
    );
    expect(run.stderr.toString()).toBe('');
    expect(run.stdout.toString().trim()).toBe('7');
  });

  test('fails when src/main.js is missing from dist', () => {
    const { code, stderr } = assemble(makeFixture({ layout: 'none' }));
    expect(code).not.toBe(0);
    expect(stderr).toContain('src/main.js');
  });

  test('fails when a workspace package has no build output', () => {
    const fixture = makeFixture({ layout: 'standard' });
    rmSync(join(fixture.repo, 'packages/auth/dist'), { recursive: true });
    const { code, stderr } = assemble(fixture);
    expect(code).not.toBe(0);
    expect(stderr).toContain('packages/auth/dist');
  });

  test('fails when the generated prisma client is missing', () => {
    const fixture = makeFixture({ layout: 'standard' });
    rmSync(join(fixture.repo, 'node_modules/.prisma'), { recursive: true });
    const { code, stderr } = assemble(fixture);
    expect(code).not.toBe(0);
    expect(stderr).toContain('.prisma');
  });
});
