import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ queryRaw: vi.fn() }));

vi.mock('@db/server', () => ({
  db: { $queryRaw: mocks.queryRaw },
}));

import { GET } from './route';

// Captured once (2026-10-06) from a real failed TLS handshake against the
// Supabase us-east-2 session pooler through PrismaClient + @prisma/adapter-pg,
// with throwaway credentials and `ssl: { ca: <self-generated throwaway CA>,
// rejectUnauthorized: true }`; see the fixture's `procedure` field.
const fixture = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../../../../packages/db/src/__fixtures__/supabase-tls-failure.json'),
    'utf8',
  ),
) as {
  prismaAdapterPgQueryRaw: {
    code: string;
    meta: { driverAdapterError: { name: string; message: string; cause: unknown } };
  };
};

function capturedPrismaTlsError(): Error {
  const captured = fixture.prismaAdapterPgQueryRaw;
  const driverAdapterError = new Error(captured.meta.driverAdapterError.message, {
    cause: captured.meta.driverAdapterError.cause,
  });
  driverAdapterError.name = captured.meta.driverAdapterError.name;
  return Object.assign(new Error('Raw query failed'), {
    name: 'PrismaClientKnownRequestError',
    code: captured.code,
    meta: { driverAdapterError },
  });
}

describe('GET /api/health (app readiness)', () => {
  beforeEach(() => {
    mocks.queryRaw.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('runs SELECT 1 and answers 200 {status: ok}', async () => {
    mocks.queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    const [strings] = mocks.queryRaw.mock.calls[0] as [TemplateStringsArray];
    expect(strings.join('?').trim()).toBe('SELECT 1');
  });

  it('answers 503 tls_<CODE> for the captured Supabase TLS failure', async () => {
    mocks.queryRaw.mockRejectedValue(capturedPrismaTlsError());
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: 'unavailable',
      reason: 'tls_SELF_SIGNED_CERT_IN_CHAIN',
    });
  });

  it('answers 503 with the Prisma code and no connection details', async () => {
    mocks.queryRaw.mockRejectedValue(
      Object.assign(new Error("Can't reach database server at db.internal:5432"), {
        code: 'P1001',
      }),
    );
    const response = await GET();
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ status: 'unavailable', reason: 'P1001' });
    expect(text).not.toContain('db.internal');
  });

  it('answers 503 timeout when SELECT 1 outlives two seconds', async () => {
    vi.useFakeTimers();
    try {
      mocks.queryRaw.mockReturnValue(new Promise(() => undefined));
      const pending = GET();
      await vi.advanceTimersByTimeAsync(2000);
      const response = await pending;
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: 'unavailable', reason: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers 503 unknown for an uncoded failure', async () => {
    mocks.queryRaw.mockRejectedValue(new Error('connection to 10.0.0.5 failed'));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'unavailable', reason: 'unknown' });
  });
});
