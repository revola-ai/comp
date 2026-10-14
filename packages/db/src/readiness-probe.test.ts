import { afterEach, describe, expect, it, setSystemTime } from 'bun:test';
import type { AddressInfo } from 'node:net';
import { createServer, type Socket } from 'node:net';
import { CLOSE_GRACE_MS, createDatabaseReadinessCheck, probeDatabase } from './readiness-probe';

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
  /** performance.now() when the server last saw a connection close. */
  lastClosedAt: () => number;
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
  let lastClosedAt = Number.NaN;
  // Ignoring Terminate includes the client's half-close that follows it.
  const allowHalfOpen = behaviour === 'answer-ignore-terminate';
  const server = createServer({ allowHalfOpen }, (socket) => {
    connections += 1;
    sockets.add(socket);
    let started = false;
    socket.on('close', () => {
      sockets.delete(socket);
      lastClosedAt = performance.now();
    });
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
    lastClosedAt: () => lastClosedAt,
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

// Waits for a condition the code under test brings about (a socket closing, a
// connection arriving) instead of sleeping a fixed time and hoping it happened.
// The cap only turns a hang into a readable failure.
async function until(condition: () => boolean, what: string): Promise<void> {
  const giveUpAt = performance.now() + 5000;
  while (!condition()) {
    if (performance.now() > giveUpAt) throw new Error(`timed out waiting until ${what}`);
    await wait(5);
  }
}

// Times one call by the clock it settles on, excluding any waiting done after it.
async function timed<T>(run: () => Promise<T>): Promise<{ result: T; elapsedMs: number }> {
  const started = performance.now();
  const result = await run();
  return { result, elapsedMs: performance.now() - started };
}

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
    await until(() => db.open() === 0, 'the server sees the connection closed');
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
    const { elapsedMs } = await timed(() =>
      probeDatabase({ connectionString: db.url, ssl: false, timeoutMs: TIMEOUT_MS }),
    );
    // Only the forced close at CLOSE_GRACE_MS can end this connection, so settling any
    // earlier would mean the probe returned with it open. A lower bound set by a timer
    // holds however slow the machine is (timers may fire up to a millisecond early).
    expect(elapsedMs).toBeGreaterThanOrEqual(CLOSE_GRACE_MS - 5);
    db.poke();
    await until(() => db.open() === 0, 'the server sees the connection closed');
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
    const started = performance.now();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => check({ timeoutMs: TIMEOUT_MS })),
    );
    expect(results).toEqual(Array(5).fill({ status: 'unavailable', reason: 'timeout' }));
    expect(db.connections()).toBe(1);
    await until(() => db.open() === 0, 'the server sees the connection closed');
    // Closed at the deadline, not left open: the bound is the deadline plus as much
    // again of slack, far below a connection left to pg's or the server's devices.
    expect(db.lastClosedAt() - started).toBeLessThan(TIMEOUT_MS * 2);
  });

  it('joins a check that arrives while a probe is outstanding instead of starting another', async () => {
    const db = await fakeDatabase({ behaviour: 'stall' });
    const check = checkFor(db.url);
    let firstSettled = false;
    const first = check({ timeoutMs: TIMEOUT_MS }).finally(() => {
      firstSettled = true;
    });
    await until(() => db.connections() === 1, 'the first probe has connected');
    // Joining is only shown while the first probe is still out: once it settles, a
    // check would be served from the result cache instead.
    expect(firstSettled).toBe(false);
    const late = check({ timeoutMs: TIMEOUT_MS });
    expect(await Promise.all([first, late])).toEqual(
      Array(2).fill({ status: 'unavailable', reason: 'timeout' }),
    );
    expect(db.connections()).toBe(1);
    await until(() => db.open() === 0, 'the server sees the connection closed');
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
    // A longer deadline than the other cases, so the margins below are hundreds of
    // milliseconds of scheduling slack rather than tens.
    const timeoutMs = 1000;
    const db = await fakeDatabase({
      behaviour: 'stall-after-startup',
      startupDelayMs: timeoutMs * 0.75,
    });
    const started = performance.now();
    const { result, elapsedMs } = await timed(() => checkFor(db.url)({ timeoutMs }));
    expect(result).toEqual({ status: 'unavailable', reason: 'timeout' });
    expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs - 5);
    expect(db.received()).toContain('SELECT 1');
    await until(() => db.open() === 0, 'the server sees the connection closed');
    // Startup took 0.75 of the deadline and the query then stalled. With one deadline
    // for both the connection closes at 1.0; a fresh deadline for the query would
    // close it at 1.75. The check's answer alone cannot tell: it has its own timeout.
    expect(db.lastClosedAt() - started).toBeLessThan(timeoutMs * 1.5);
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
