import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// apps/app's e2e setup pushes the schema with --accept-data-loss from packages/db,
// where an env file can hold the shared production URL. prisma.config.ts guards it at
// the root; the script also goes through the guard explicitly.
const SETUP_E2E = resolve(
  import.meta.dir,
  '..',
  '..',
  '..',
  'apps',
  'app',
  'scripts',
  'setup-e2e.sh',
);

describe('apps/app/scripts/setup-e2e.sh', () => {
  it('runs every prisma db push through scripts/prod-guard.ts', () => {
    const pushes = readFileSync(SETUP_E2E, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('#') && /prisma\s+db\s+push/.test(line));
    expect(pushes.length).toBeGreaterThan(0);
    for (const line of pushes) {
      expect(line.trim().startsWith('bun scripts/prod-guard.ts bunx prisma db push')).toBe(true);
    }
  });
});
