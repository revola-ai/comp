import { afterEach, describe, expect, it, vi } from 'vitest';

// Tests and `next build` import route modules without DATABASE_URL: importing the
// client must never throw; only instrumentation.ts fails eagerly at server boot, and a
// query without configuration fails at first use with the named error.
describe('app Prisma client without DATABASE_URL', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('imports without throwing and fails at first use with database_url_missing', async () => {
    vi.stubEnv('DATABASE_URL', '');
    vi.resetModules();
    const { db } = await import('@db/server');
    expect(() => db.user).toThrow(/database_url_missing/);
  });
});
