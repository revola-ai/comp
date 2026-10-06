import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  checkDatabaseReadiness,
  createReadinessCheck,
  READINESS_TIMEOUT_MS,
  readinessReason,
} from './readiness';

// The fixture was captured once (2026-10-06) from a real failed TLS handshake
// against the Supabase us-east-2 session pooler: a `pg` Client and a PrismaClient
// over @prisma/adapter-pg, both with throwaway credentials and
// `ssl: { ca: <self-generated throwaway CA>, rejectUnauthorized: true }`, so
// verification failed before authentication. Only the error shape was kept.
const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dir, '__fixtures__/supabase-tls-failure.json'), 'utf8'),
) as {
  pgClientConnect: { code: string; message: string };
  prismaAdapterPgQueryRaw: {
    code: string;
    meta: { driverAdapterError: { name: string; message: string; cause: unknown } };
  };
};

function pgTlsError(): Error {
  const error = new Error(fixture.pgClientConnect.message);
  return Object.assign(error, { code: fixture.pgClientConnect.code });
}

function prismaTlsError(): Error {
  const captured = fixture.prismaAdapterPgQueryRaw;
  const driverAdapterError = new Error(captured.meta.driverAdapterError.message, {
    cause: captured.meta.driverAdapterError.cause,
  });
  driverAdapterError.name = captured.meta.driverAdapterError.name;
  const error = new Error('Raw query failed');
  error.name = 'PrismaClientKnownRequestError';
  return Object.assign(error, {
    code: captured.code,
    clientVersion: '7.6.0',
    meta: { driverAdapterError },
  });
}

describe('readinessReason', () => {
  it('maps the captured pg TLS failure to tls_<CODE>', () => {
    expect(readinessReason(pgTlsError())).toBe('tls_SELF_SIGNED_CERT_IN_CHAIN');
  });

  it('maps the captured Prisma adapter TLS failure to tls_<CODE>, not its P2010 wrapper code', () => {
    expect(readinessReason(prismaTlsError())).toBe('tls_SELF_SIGNED_CERT_IN_CHAIN');
  });

  it('walks the cause chain for a Node TLS code', () => {
    const tls = Object.assign(new Error('unable to verify the first certificate'), {
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    });
    const wrapped = new Error('outer', { cause: new Error('middle', { cause: tls }) });
    expect(readinessReason(wrapped)).toBe('tls_UNABLE_TO_VERIFY_LEAF_SIGNATURE');
  });

  it('recognises Node ERR_TLS_ codes', () => {
    const error = Object.assign(new Error('Hostname/IP does not match'), {
      code: 'ERR_TLS_CERT_ALTNAME_INVALID',
    });
    expect(readinessReason(error)).toBe('tls_ERR_TLS_CERT_ALTNAME_INVALID');
  });

  it.each([
    ['self-signed certificate', 'DEPTH_ZERO_SELF_SIGNED_CERT'],
    ['self signed certificate', 'DEPTH_ZERO_SELF_SIGNED_CERT'],
    ['unable to verify the first certificate', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'],
    ['unable to get local issuer certificate', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'],
    ['certificate has expired', 'CERT_HAS_EXPIRED'],
    [
      "Hostname/IP does not match certificate's altnames: Host: db. is not in the cert's altnames",
      'ERR_TLS_CERT_ALTNAME_INVALID',
    ],
    ['Invalid subject alternative name string', 'ERR_TLS_CERT_ALTNAME_FORMAT'],
  ])('maps the adapter TLS reason %p to its Node code', (reason, code) => {
    const error = Object.assign(new Error('Raw query failed'), {
      code: 'P2010',
      meta: {
        driverAdapterError: new Error('TlsConnectionError', {
          cause: { kind: 'TlsConnectionError', reason },
        }),
      },
    });
    expect(readinessReason(error)).toBe(`tls_${code}`);
  });

  it('reports tls_UNKNOWN for an adapter TLS failure whose reason it does not recognise', () => {
    const error = Object.assign(new Error('Raw query failed'), {
      code: 'P2010',
      meta: {
        driverAdapterError: new Error('TlsConnectionError', {
          cause: {
            kind: 'TlsConnectionError',
            reason: 'The server does not support SSL connections',
          },
        }),
      },
    });
    expect(readinessReason(error)).toBe('tls_UNKNOWN');
  });

  it('falls back to the Prisma code when no TLS code is present', () => {
    const error = Object.assign(new Error("Can't reach database server at db.example:5432"), {
      code: 'P1001',
    });
    expect(readinessReason(error)).toBe('P1001');
  });

  it('reads the Prisma initialization errorCode', () => {
    const error = Object.assign(new Error('init failed'), { errorCode: 'P1000' });
    expect(readinessReason(error)).toBe('P1000');
  });

  it('answers unknown for anything else and never echoes the message', () => {
    expect(readinessReason(new Error('connect to 10.0.0.5 failed for user postgres'))).toBe(
      'unknown',
    );
    expect(readinessReason('a string')).toBe('unknown');
    expect(readinessReason(undefined)).toBe('unknown');
    expect(readinessReason(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(
      'unknown',
    );
  });

  it('terminates on a cyclic cause chain', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    Object.assign(a, { cause: b });
    expect(readinessReason(a)).toBe('unknown');
  });
});

describe('checkDatabaseReadiness', () => {
  it('uses a 2-second timeout by default', () => {
    expect(READINESS_TIMEOUT_MS).toBe(2000);
  });

  it('answers ok when the probe resolves', async () => {
    expect(await checkDatabaseReadiness({ probe: async () => [{ '?column?': 1 }] })).toEqual({
      status: 'ok',
    });
  });

  it('answers timeout when the probe outlives the timeout', async () => {
    const probe = () => new Promise<never>(() => undefined);
    expect(await checkDatabaseReadiness({ probe, timeoutMs: 20 })).toEqual({
      status: 'unavailable',
      reason: 'timeout',
    });
  });

  it('answers the mapped reason when the probe rejects', async () => {
    expect(
      await checkDatabaseReadiness({
        probe: () => Promise.reject(prismaTlsError()),
      }),
    ).toEqual({ status: 'unavailable', reason: 'tls_SELF_SIGNED_CERT_IN_CHAIN' });
  });

  it('answers the mapped reason when the probe throws synchronously', async () => {
    const probe = (): Promise<unknown> => {
      throw Object.assign(new Error('boom'), { code: 'P1017' });
    };
    expect(await checkDatabaseReadiness({ probe })).toEqual({
      status: 'unavailable',
      reason: 'P1017',
    });
  });

  it('does not leak an unhandled rejection when the probe fails after the timeout', async () => {
    let rejectLater: (error: Error) => void = () => undefined;
    const probe = () =>
      new Promise<never>((_resolve, reject) => {
        rejectLater = reject;
      });
    const result = await checkDatabaseReadiness({ probe, timeoutMs: 5 });
    rejectLater(new Error('late'));
    await new Promise((settle) => setTimeout(settle, 5));
    expect(result).toEqual({ status: 'unavailable', reason: 'timeout' });
  });
});

describe('createReadinessCheck (single flight)', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

  function stalledProbe() {
    let calls = 0;
    let settle: (value: unknown) => void = () => undefined;
    let fail: (error: Error) => void = () => undefined;
    const probe = () => {
      calls += 1;
      return new Promise((resolve, reject) => {
        settle = resolve;
        fail = reject;
      });
    };
    return {
      probe,
      calls: () => calls,
      settle: (value: unknown) => settle(value),
      fail: (error: Error) => fail(error),
    };
  }

  it('lets five concurrent checks during a stalled query share one underlying query', async () => {
    const stalled = stalledProbe();
    const check = createReadinessCheck({ probe: stalled.probe });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => check({ timeoutMs: 10 })),
    );
    expect(stalled.calls()).toBe(1);
    expect(results).toEqual(Array(5).fill({ status: 'unavailable', reason: 'timeout' }));
  });

  it('joins a later check to the query still in flight instead of queueing another', async () => {
    const stalled = stalledProbe();
    const check = createReadinessCheck({ probe: stalled.probe });
    await check({ timeoutMs: 5 });
    await check({ timeoutMs: 5 });
    expect(stalled.calls()).toBe(1);
  });

  it('issues a new query once the previous one has settled', async () => {
    const stalled = stalledProbe();
    const check = createReadinessCheck({ probe: stalled.probe });
    await check({ timeoutMs: 5 });
    stalled.settle([{ '?column?': 1 }]);
    await tick();
    const next = check({ timeoutMs: 50 });
    await tick(); // the probe starts on the next microtask
    stalled.settle([{ '?column?': 1 }]);
    expect(await next).toEqual({ status: 'ok' });
    expect(stalled.calls()).toBe(2);
  });

  it('gives every sharer the same mapped reason when the shared query fails', async () => {
    const stalled = stalledProbe();
    const check = createReadinessCheck({ probe: stalled.probe });
    const pending = [check({ timeoutMs: 100 }), check({ timeoutMs: 100 })];
    await tick();
    stalled.fail(prismaTlsError());
    expect(await Promise.all(pending)).toEqual(
      Array(2).fill({ status: 'unavailable', reason: 'tls_SELF_SIGNED_CERT_IN_CHAIN' }),
    );
    expect(stalled.calls()).toBe(1);
  });

  it('uses the 2-second readiness timeout by default', async () => {
    const check = createReadinessCheck({ probe: async () => [{ '?column?': 1 }] });
    expect(await check()).toEqual({ status: 'ok' });
  });
});
