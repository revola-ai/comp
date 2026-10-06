import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mockQueryRaw = jest.fn();
jest.mock('@db', () => ({
  db: { $queryRaw: (...args: unknown[]) => mockQueryRaw(...args) },
}));

import { checkApiReadiness } from './readiness';

// Captured once (2026-10-06) from a real failed TLS handshake against the
// Supabase us-east-2 session pooler through PrismaClient + @prisma/adapter-pg,
// with throwaway credentials and `ssl: { ca: <self-generated throwaway CA>,
// rejectUnauthorized: true }`, so verification failed before authentication.
// The fixture keeps only the error shape (see its `procedure` field).
const fixture = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      '../../../../packages/db/src/__fixtures__/supabase-tls-failure.json',
    ),
    'utf8',
  ),
) as {
  prismaAdapterPgQueryRaw: {
    code: string;
    meta: {
      driverAdapterError: { name: string; message: string; cause: unknown };
    };
  };
};

function capturedPrismaTlsError(): Error {
  const captured = fixture.prismaAdapterPgQueryRaw;
  const driverAdapterError = new Error(
    captured.meta.driverAdapterError.message,
    { cause: captured.meta.driverAdapterError.cause },
  );
  driverAdapterError.name = captured.meta.driverAdapterError.name;
  const error = new Error('Raw query failed');
  error.name = 'PrismaClientKnownRequestError';
  return Object.assign(error, {
    code: captured.code,
    meta: { driverAdapterError },
  });
}

describe('checkApiReadiness', () => {
  beforeEach(() => mockQueryRaw.mockReset());

  it('runs SELECT 1 and answers ok', async () => {
    mockQueryRaw.mockResolvedValue([{ '?column?': 1 }]);
    await expect(checkApiReadiness()).resolves.toEqual({ status: 'ok' });
    const [strings] = mockQueryRaw.mock.calls[0] as [TemplateStringsArray];
    expect(strings.join('?').trim()).toBe('SELECT 1');
  });

  it('answers timeout when the query outlives the timeout', async () => {
    mockQueryRaw.mockReturnValue(new Promise(() => undefined));
    await expect(checkApiReadiness({ timeoutMs: 10 })).resolves.toEqual({
      status: 'unavailable',
      reason: 'timeout',
    });
  });

  it('answers the Prisma code for a Prisma-coded failure', async () => {
    mockQueryRaw.mockRejectedValue(
      Object.assign(new Error("Can't reach database server at db:5432"), {
        code: 'P1001',
      }),
    );
    await expect(checkApiReadiness()).resolves.toEqual({
      status: 'unavailable',
      reason: 'P1001',
    });
  });

  it('answers tls_<CODE> for the captured Supabase TLS failure', async () => {
    mockQueryRaw.mockRejectedValue(capturedPrismaTlsError());
    await expect(checkApiReadiness()).resolves.toEqual({
      status: 'unavailable',
      reason: 'tls_SELF_SIGNED_CERT_IN_CHAIN',
    });
  });
});
