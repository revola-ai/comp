import { APP_MACHINE_ROUTES, type MachineRouteDisposition } from '@/lib/machine-routes';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Cloudflare Access sits in front of the whole app host. A route that
 * authenticates without a user session (bearer token, shared secret, signed
 * token, test-mode flag) is either opened with an Access Bypass and keeps its
 * own check, documented as unsupported (stays behind Access), or removed.
 * This test keeps APP_MACHINE_ROUTES, which Task 8 turns into Access bypass
 * paths, complete.
 */

const APP_DIR = resolve(__dirname, '..');

const SESSION_CHECK =
  /auth\.api\.getSession|getFullSession|requireApiPermission|requireRoutePermission|serverApi\./;
const MACHINE_AUTH =
  /\.get\(\s*['"]authorization['"]\s*\)|\bBearer\b|timingSafeEqual|E2E_TEST_MODE|process\.env\.[A-Z_]*SECRET|env\.[A-Z_]*SECRET|verifyUnsubscribeToken|x-api-key|x-service-token/;

function listRouteFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listRouteFiles(full);
    return entry.name === 'route.ts' ? [full] : [];
  });
}

/** `api/qa/approve-org/route.ts` -> `/api/qa/approve-org`; route groups are dropped. */
function toUrlPath(file: string): string {
  const segments = relative(APP_DIR, file)
    .split('/')
    .slice(0, -1)
    .filter((segment) => !/^\(.*\)$/.test(segment));
  return `/${segments.join('/')}`;
}

const routes = listRouteFiles(APP_DIR).map((file) => ({
  path: toUrlPath(file),
  source: readFileSync(file, 'utf8'),
}));

const machineRoutes = routes.filter(
  ({ source }) => MACHINE_AUTH.test(source) && !SESSION_CHECK.test(source),
);

describe('APP_MACHINE_ROUTES', () => {
  it('finds the known machine routes (scanner sanity check)', () => {
    const found = machineRoutes.map(({ path }) => path);
    expect(found).toEqual(
      expect.arrayContaining([
        '/api/revalidate/path',
        '/api/user-frameworks',
        '/api/retool/reset-org',
      ]),
    );
  });

  it('lists every app route that authenticates without a session', () => {
    const listed = new Set(APP_MACHINE_ROUTES.map((route) => route.path));
    const missing = machineRoutes.map(({ path }) => path).filter((path) => !listed.has(path));
    expect(missing).toEqual([]);
  });

  it.each(APP_MACHINE_ROUTES.map((route) => [route.path, route]))(
    '%s exists (or is marked removed) and has a complete disposition',
    (path, route) => {
      const file = join(APP_DIR, ...path.split('/').filter(Boolean), 'route.ts');
      const dispositions: MachineRouteDisposition[] = ['access-bypass', 'unsupported', 'removed'];
      expect(dispositions).toContain(route.disposition);
      expect(route.reason.length).toBeGreaterThan(20);
      expect(existsSync(file)).toBe(route.disposition !== 'removed');
    },
  );

  it('every Access bypass keeps its own check and names the 4xx it returns without a secret', () => {
    const bypasses = APP_MACHINE_ROUTES.filter((route) => route.disposition === 'access-bypass');
    expect(bypasses.map((route) => route.path)).toContain('/api/revalidate/path');
    for (const route of bypasses) {
      expect(route.auth).not.toBe('none');
      expect(route.rejectsWithoutSecret).toBeGreaterThanOrEqual(400);
      expect(route.rejectsWithoutSecret).toBeLessThan(500);
      expect(route.methods.length).toBeGreaterThan(0);
    }
  });

  it('paths are unique, absolute and free of wildcards', () => {
    const paths = APP_MACHINE_ROUTES.map((route) => route.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) expect(path).toMatch(/^\/api\/[a-z0-9/-]+$/);
  });
});
