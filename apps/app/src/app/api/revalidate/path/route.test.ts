import { revalidatePath } from 'next/cache';
import { NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: { REVALIDATION_SECRET: 'configured-revalidation-secret' as string | undefined },
}));

vi.mock('@/env.mjs', () => ({ env: mocks.env }));

import { POST } from './route';

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/revalidate/path', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const SECRET = 'configured-revalidation-secret';

describe('POST /api/revalidate/path', () => {
  beforeEach(() => {
    mocks.env.REVALIDATION_SECRET = SECRET;
  });

  it('revalidates a relative path with the right secret', async () => {
    const res = await POST(post({ path: '/org_1', type: 'layout', secret: SECRET }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revalidated: true });
    expect(revalidatePath).toHaveBeenCalledWith('/org_1', 'layout');
  });

  it('compares the secret with timingSafeEqual, never with === or !==', () => {
    // vitest cannot intercept node builtins imported by app modules, so this
    // is asserted on the source; the behavior tests below cover the outcome.
    const source = readFileSync(resolve(__dirname, 'route.ts'), 'utf8');
    expect(source).toMatch(/timingSafeEqual\(/);
    expect(source).not.toMatch(
      /(secret|SECRET)\s*[!=]==|[!=]==\s*(env\.)?(secret|REVALIDATION_SECRET)/,
    );
  });

  it('rejects a wrong secret of any length without throwing', async () => {
    for (const secret of ['nope', `${SECRET}x`, SECRET.slice(0, -1)]) {
      const res = await POST(post({ path: '/org_1', secret }));
      expect(res.status).toBe(401);
    }
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('rejects a missing or empty secret', async () => {
    expect((await POST(post({ path: '/org_1' }))).status).toBe(401);
    expect((await POST(post({ path: '/org_1', secret: '' }))).status).toBe(401);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('rejects every request when the configured secret is empty', async () => {
    mocks.env.REVALIDATION_SECRET = '';
    const res = await POST(post({ path: '/org_1', secret: '' }));

    expect(res.status).toBe(401);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    'https://app.comp.revola.ai/org_1',
    '//evil.example.com/org_1',
    'org_1',
    '/\\evil.example.com',
    '',
  ])('rejects the non-relative path %j', async (path) => {
    const res = await POST(post({ path, secret: SECRET }));

    expect(res.status).toBe(400);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('rejects an unknown revalidation type', async () => {
    const res = await POST(post({ path: '/org_1', type: 'everything', secret: SECRET }));
    expect(res.status).toBe(400);
  });

  it('rejects a malformed body as unauthenticated, before any validation detail', async () => {
    const req = new NextRequest('http://localhost/api/revalidate/path', {
      method: 'POST',
      body: '{not json',
    });
    expect((await POST(req)).status).toBe(401);
  });
});
