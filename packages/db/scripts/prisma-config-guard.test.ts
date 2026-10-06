import { describe, expect, it } from 'bun:test';
import { dirname, join, resolve } from 'node:path';
import { loadProductionTarget } from './production-target-guard';

// Each prisma.config.ts is loaded in-process by the Prisma CLI, so its process.argv is
// the CLI's. Running the config file itself with Bun reproduces that argv without
// starting Prisma: nothing here connects to any database.
//
// The committed target holds only the ref's hash, so no test can build the production
// URL. These cases prove each config runs the guard with a URL the guard cannot verify
// (it fails closed); production matching itself is covered in src/production-target.test.ts.
const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');
const CONFIGS = [
  'packages/db/prisma.config.ts',
  'apps/app/prisma.config.ts',
  'apps/portal/prisma.config.ts',
  'apps/framework-editor/prisma.config.ts',
];

const target = loadProductionTarget();
const UNVERIFIABLE_URL = 'not a url';
const OTHER_PROJECT_ON_POOLER = `postgresql://postgres.zyxwvutsrqponmlkjihg:pw@${target.poolerHost}:5432/postgres`;
const LOCAL_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/comp_dev';

function loadConfig({
  config,
  args,
  env,
}: {
  config: string;
  args: string[];
  env: Record<string, string>;
}): { exitCode: number; stderr: string } {
  const path = join(REPO_ROOT, config);
  const result = Bun.spawnSync(['bun', path, ...args], {
    cwd: dirname(path),
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { exitCode: result.exitCode, stderr: result.stderr.toString() };
}

for (const config of CONFIGS) {
  describe(config, () => {
    for (const args of [
      ['migrate', 'dev'],
      ['db', 'push', '--accept-data-loss'],
      ['migrate', 'deploy'],
      ['migrate', 'resolve', '--applied', '20261005000000_x'],
      ['db', 'execute', '--stdin'],
    ]) {
      it(`runs the guard for \`prisma ${args.join(' ')}\` and exits 1 when it refuses`, () => {
        const { exitCode, stderr } = loadConfig({
          config,
          args,
          env: { DATABASE_URL: UNVERIFIABLE_URL },
        });
        expect(exitCode).toBe(1);
        expect(stderr).toContain('database_url_unverifiable');
      });
    }

    it('allows it with COMP_I_AM_TOUCHING_PROD=1', () => {
      const { exitCode } = loadConfig({
        config,
        args: ['migrate', 'deploy'],
        env: { DATABASE_URL: UNVERIFIABLE_URL, COMP_I_AM_TOUCHING_PROD: '1' },
      });
      expect(exitCode).toBe(0);
    });

    it('does not take the shared regional pooler host alone for production', () => {
      const { exitCode, stderr } = loadConfig({
        config,
        args: ['migrate', 'dev'],
        env: { DATABASE_URL: OTHER_PROJECT_ON_POOLER },
      });
      expect(exitCode).toBe(0);
      expect(stderr).toBe('');
    });

    it('allows it for a local host', () => {
      const { exitCode, stderr } = loadConfig({
        config,
        args: ['migrate', 'reset', '--force'],
        env: { DATABASE_URL: LOCAL_URL },
      });
      expect(exitCode).toBe(0);
      expect(stderr).toBe('');
    });

    it('allows `generate` and `migrate status` without checking the URL', () => {
      for (const args of [['generate'], ['migrate', 'status']]) {
        expect(loadConfig({ config, args, env: { DATABASE_URL: UNVERIFIABLE_URL } }).exitCode).toBe(
          0,
        );
      }
    });
  });
}
