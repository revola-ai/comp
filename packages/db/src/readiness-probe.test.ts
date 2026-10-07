import { afterEach, describe, expect, it, setSystemTime } from 'bun:test';
import type { AddressInfo } from 'node:net';
import { createServer, type Socket } from 'node:net';
import { createDatabaseReadinessCheck, probeDatabase } from './readiness-probe';

// Throwaway local servers stand in for the database: one that accepts TCP and
// never answers (a stalled pooler), and one that speaks just enough of the
// Postgres protocol. Nothing here connects to a real database.

type Behaviour =
  'stall' | 'stall-after-startup' | 'answer' | 'answer-ignore-terminate' | 'reject-password';

const TIMEOUT_MS = 200;

function message({ type, body }: { type: string; body: Buffer }): Buffer {
  const length = Buffer.alloc(4);
  length.writeInt32BE(body.length + 4);
  return Buffer.concat([Buffer.from(type, 'latin1'), length, body]);
}

const AUTH_OK = message({ type: 'R', body: Buffer.from([0, 0, 0, 0]) });
const READY = message({ type: 'Z', body: Buffer.from('I', 'latin1') });
const SELECT_DONE = message({ type: 'C', body: Buffer.from('SELECT 1\0', 'latin1') });
const PASSWORD_FAILED = message({
  type: 'E',
  body: Buffer.from(
    'SFATAL\0VFATAL\0C28P01\0Mpassword authentication failed for user "probe"\0\0',
    'latin1',
  ),
});

type FakeDatabase = {
  url: string;
  connections: () => number;
  open: () => number;
  received: () => string;
  poke: () => void;
  close: () => Promise<void>;
};

const servers: FakeDatabase[] = [];

async function fakeDatabase({
  behaviour,
  startupDelayMs = 0,
}: {
  behaviour: Behaviour;
  startupDelayMs?: number;
}): Promise<FakeDatabase> {
  const sockets = new Set<Socket>();
  let connections = 0;
  let received = '';
  // Ignoring Terminate includes the client's half-close that follows it.
  const allowHalfOpen = behaviour === 'answer-ignore-terminate';
  const server = createServer({ allowHalfOpen }, (socket) => {
    connections += 1;
    sockets.add(socket);
    let started = false;
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      received += chunk.toString('latin1');
      if (behaviour === 'stall') return;
      if (!started) {
        started = true;
        const reply =
          behaviour === 'reject-password' ? PASSWORD_FAILED : Buffer.concat([AUTH_OK, READY]);
        setTimeout(() => socket.write(reply), startupDelayMs);
        return;
      }
      const answers = behaviour === 'answer' || behaviour === 'answer-ignore-terminate';
      if (chunk[0] === 'X'.charCodeAt(0) && behaviour !== 'answer-ignore-terminate') socket.end();
      if (chunk[0] === 'Q'.charCodeAt(0) && answers) {
        socket.write(Buffer.concat([SELECT_DONE, SELECT_DONE, READY]));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const fake: FakeDatabase = {
    url: `postgresql://probe:probe@127.0.0.1:${port}/probe`,
    connections: () => connections,
    open: () => sockets.size,
    received: () => received,
    // A write to a connection the client has closed draws a reset, which closes
    // the server's side too.
    poke: () => {
      for (const socket of sockets) socket.write('N');
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
  servers.push(fake);
  return fake;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function checkFor(url: string) {
  return createDatabaseReadinessCheck({
    env: { DATABASE_URL: url },
    log: () => undefined,
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('createDatabaseReadinessCheck (dedicated short-lived client)', () => {
  it('answers ok from a database that answers SELECT 1, and closes its connection', async () => {
    const db = await fakeDatabase({ behaviour: 'answer' });
    expect(await checkFor(db.url)({ timeoutMs: TIMEOUT_MS })).toEqual({ status: 'ok' });
    await wait(50);
    expect(db.open()).toBe(0);
  });

  it('settles only after the server has closed the connection on Terminate', async () => {
    const db = await fakeDatabase({ behaviour: 'answer' });
    await probeDatabase({ connectionString: db.url, ssl: false, timeoutMs: TIMEOUT_MS });
    // The server closes when it reads Terminate ('X', length 4), so the probe has
    // seen that close before it settles: never two probe connections at once.
    expect(db.received().endsWith('X\0\0\0\x04')).toBe(true);
  });

  it('settles only once the connection is closed when the server ignores Terminate (one-second fallback)', async () => {
    const db = await fakeDatabase({ behaviour: 'answer-ignore-terminate' });
    const started = Date.now();
    await probeDatabase({ connectionString: db.url, ssl: false, timeoutMs: TIMEOUT_MS });
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    db.poke();
    await wait(50);
    expect(db.open()).toBe(0);
  });

  it('bounds the query on the server side too (statement_timeout for this transaction)', async () => {
    const db = await fakeDatabase({ behaviour: 'answer' });
    await checkFor(db.url)({ timeoutMs: TIMEOUT_MS });
    expect(db.received()).toContain(
      `SELECT set_config('statement_timeout', '${TIMEOUT_MS}', true); SELECT 1`,
    );
  });

  it('leaves one probe outstanding for five concurrent checks against a stalled server, and closes it at the deadline', async () => {
    const db = await fakeDatabase({ behaviour: 'stall' });
    const check = checkFor(db.url);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => check({ timeoutMs: TIMEOUT_MS })),
    );
    expect(results).toEqual(Array(5).fill({ status: 'unavailable', reason: 'timeout' }));
    expect(db.connections()).toBe(1);
    await wait(50);
    expect(db.open()).toBe(0);
  });

  it('joins a check that arrives while a probe is outstanding instead of starting another', async () => {
    const db = await fakeDatabase({ behaviour: 'stall' });
    const check = checkFor(db.url);
    const first = check({ timeoutMs: TIMEOUT_MS });
    await wait(TIMEOUT_MS / 2);
    const late = check({ timeoutMs: TIMEOUT_MS });
    expect(await Promise.all([first, late])).toEqual(
      Array(2).fill({ status: 'unavailable', reason: 'timeout' }),
    );
    expect(db.connections()).toBe(1);
    await wait(50);
    // Past the two-second result cache, the next check starts a new probe.
    setSystemTime(new Date(Date.now() + 2000));
    try {
      await check({ timeoutMs: TIMEOUT_MS });
    } finally {
      setSystemTime();
    }
    expect(db.connections()).toBe(2);
  });

  it('reuses a result for two seconds without opening a connection, then probes again', async () => {
    const db = await fakeDatabase({ behaviour: 'answer' });
    const check = checkFor(db.url);
    const now = Date.now();
    try {
      setSystemTime(new Date(now));
      expect(await check({ timeoutMs: TIMEOUT_MS })).toEqual({ status: 'ok' });
      setSystemTime(new Date(now + 1999));
      expect(await check({ timeoutMs: TIMEOUT_MS })).toEqual({ status: 'ok' });
      expect(db.connections()).toBe(1);
      setSystemTime(new Date(now + 2000));
      expect(await check({ timeoutMs: TIMEOUT_MS })).toEqual({ status: 'ok' });
      expect(db.connections()).toBe(2);
    } finally {
      setSystemTime();
    }
  });

  it('closes a connection whose server stalls after startup, within one deadline for connect and query together', async () => {
    const db = await fakeDatabase({
      behaviour: 'stall-after-startup',
      startupDelayMs: TIMEOUT_MS * 0.75,
    });
    const started = Date.now();
    expect(await checkFor(db.url)({ timeoutMs: TIMEOUT_MS })).toEqual({
      status: 'unavailable',
      reason: 'timeout',
    });
    await wait(50);
    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS * 1.75);
    expect(db.received()).toContain('SELECT 1');
    expect(db.open()).toBe(0);
  });

  it('answers the Prisma code an authentication failure has always produced (P1000)', async () => {
    const db = await fakeDatabase({ behaviour: 'reject-password' });
    expect(await checkFor(db.url)({ timeoutMs: TIMEOUT_MS })).toEqual({
      status: 'unavailable',
      reason: 'P1000',
    });
  });

  it('answers P1001 when nothing listens on the port', async () => {
    const db = await fakeDatabase({ behaviour: 'stall' });
    const { url } = db;
    await db.close();
    expect(await checkFor(url)({ timeoutMs: TIMEOUT_MS })).toEqual({
      status: 'unavailable',
      reason: 'P1001',
    });
  });

  it('answers unknown, with no details, when the connection policy refuses the configuration', async () => {
    const check = createDatabaseReadinessCheck({ env: {}, log: () => undefined });
    expect(await check({ timeoutMs: TIMEOUT_MS })).toEqual({
      status: 'unavailable',
      reason: 'unknown',
    });
  });
});
