import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Entry points that write to the database without going through the Prisma CLI (and so
// without prisma.config.ts's guard) must refuse production themselves, before any client
// is created or any query runs.
const PACKAGE_ROOT = resolve(import.meta.dir, '..', '..');
const read = (path: string) => readFileSync(resolve(PACKAGE_ROOT, path), 'utf8');

describe('database-writing entry points refuse production first', () => {
  it('prisma/seed/seed.ts calls the guard before it builds its client', () => {
    const source = read('prisma/seed/seed.ts');
    const guard = source.indexOf('refuseProductionEntryPoint({');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(source.indexOf('new PrismaPg('));
    expect(guard).toBeLessThan(source.indexOf('new PrismaClient('));
  });

  it('src/scripts/backfill-framework-versions.ts calls the guard before the backfill runs', () => {
    const source = read('src/scripts/backfill-framework-versions.ts');
    const main = source.indexOf('if (require.main === module)');
    const guard = source.indexOf('refuseProductionEntryPoint({', main);
    expect(main).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(main);
    expect(guard).toBeLessThan(source.indexOf('backfillFrameworkVersions()', main));
  });

  it('src/scripts/apply-csf-crosswalk.ts only rewrites committed JSON and never opens the database', () => {
    const source = read('src/scripts/apply-csf-crosswalk.ts');
    expect(source).not.toMatch(/from ['"](\.\.\/client|@prisma\/client|@prisma\/adapter-pg)['"]/);
    expect(source).not.toMatch(/\bdb\.|PrismaClient/);
  });
});
