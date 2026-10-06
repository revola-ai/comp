import { describe, expect, it } from 'bun:test';
import { dirname, join, resolve } from 'node:path';
import { loadProductionTarget } from './production-target-guard';

// Each prisma.config.ts is loaded in-process by the Prisma CLI, so its process.argv is
// the CLI's. Running the config file itself with Bun reproduces that argv without
// starting Prisma: nothing here connects to any database.
const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');
const CONFIGS = [
  'packages/db/prisma.config.ts',
  'apps/app/prisma.config.ts',
  'apps/portal/prisma.config.ts',
  'apps/framework-editor/prisma.config.ts',
];

const target = loadProductionTarget();
const PROD_URL = `postgresql://postgres.${target.projectRef}:pw@${target.poolerHost}:5432/postgres`;
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
    it('refuses `migrate dev` against the production target, without printing it', () => {
      const { exitCode, stderr } = loadConfig({
        config,
        args: ['migrate', 'dev'],
        env: { DATABASE_URL: PROD_URL },
      });
      expect(exitCode).toBe(1);
      expect(stderr).toContain('production_target_refused');
      expect(stderr.includes(target.poolerHost)).toBe(false);
      expect(stderr.includes(target.projectRef)).toBe(false);
    });

    it('refuses `db push --accept-data-loss` against the production target', () => {
      const { exitCode } = loadConfig({
        config,
        args: ['db', 'push', '--accept-data-loss'],
        env: { DATABASE_URL: PROD_URL },
      });
      expect(exitCode).toBe(1);
    });

    it('allows it with COMP_I_AM_TOUCHING_PROD=1', () => {
      const { exitCode } = loadConfig({
        config,
        args: ['migrate', 'dev'],
        env: { DATABASE_URL: PROD_URL, COMP_I_AM_TOUCHING_PROD: '1' },
      });
      expect(exitCode).toBe(0);
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

    it('allows `generate` and `migrate deploy` against the production target', () => {
      for (const args of [['generate'], ['migrate', 'deploy']]) {
        expect(loadConfig({ config, args, env: { DATABASE_URL: PROD_URL } }).exitCode).toBe(0);
      }
    });
  });
}
