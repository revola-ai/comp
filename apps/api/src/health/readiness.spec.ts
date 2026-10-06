import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// $queryRaw records its SQL; $transaction is the one round trip the probe makes.
type RecordedQuery = { sql: string; values: unknown[] };
const mockTransaction = jest.fn<Promise<unknown>, [RecordedQuery[]]>();
jest.mock('@db', () => ({
  db: {
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      sql: strings.join('?').trim(),
      values,
    }),
    $transaction: (ops: RecordedQuery[]) => mockTransaction(ops),
  },
}));

import { READINESS_TIMEOUT_MS } from '@trycompai/db';
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

function deferred() {
  let resolve: (value: unknown) => void = () => undefined;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const flush = () => new Promise((settle) => setTimeout(settle, 1));

describe('checkApiReadiness', () => {
  beforeEach(() => mockTransaction.mockReset());

  it('runs SELECT 1 in one transaction whose statement_timeout is the readiness timeout', async () => {
    mockTransaction.mockResolvedValue([[{ set_config: '2000' }], [{ '?column?': 1 }]]);
    await expect(checkApiReadiness()).resolves.toEqual({ status: 'ok' });
    const [ops] = mockTransaction.mock.calls[0];
    expect(ops).toEqual([
      {
        sql: "SELECT set_config('statement_timeout', ?, true)",
        values: [String(READINESS_TIMEOUT_MS)],
      },
      { sql: 'SELECT 1', values: [] },
    ]);
  });

  it('answers timeout when the query outlives the timeout', async () => {
    const stalled = deferred();
    mockTransaction.mockReturnValue(stalled.promise);
    await expect(checkApiReadiness({ timeoutMs: 10 })).resolves.toEqual({
      status: 'unavailable',
      reason: 'timeout',
    });
    stalled.resolve([]);
    await flush();
  });

  it('shares one in-flight query between five overlapping probes', async () => {
    const stalled = deferred();
    mockTransaction.mockReturnValue(stalled.promise);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => checkApiReadiness({ timeoutMs: 10 })),
    );
    expect(results).toEqual(
      Array(5).fill({ status: 'unavailable', reason: 'timeout' }),
    );
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    stalled.resolve([]);
    await flush();
  });

  it('answers the Prisma code for a Prisma-coded failure', async () => {
    mockTransaction.mockRejectedValue(
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
    mockTransaction.mockRejectedValue(capturedPrismaTlsError());
    await expect(checkApiReadiness()).resolves.toEqual({
      status: 'unavailable',
      reason: 'tls_SELF_SIGNED_CERT_IN_CHAIN',
    });
  });
});
