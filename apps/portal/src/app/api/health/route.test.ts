import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GET } from './route';

// The ALB health check hits this route. It must never touch the database,
// auth or request headers, so a database or auth outage does not cycle tasks.
const MODULE_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;

describe('GET /api/health (portal liveness)', () => {
  it('answers 200 {status: ok}', async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('imports nothing but next/server (no database, auth or next/headers)', () => {
    const source = readFileSync(resolve(__dirname, 'route.ts'), 'utf8');
    const imports = [...source.matchAll(MODULE_SPECIFIER)].map((match) => match[1]);
    expect(imports).toEqual(['next/server']);
  });
});
