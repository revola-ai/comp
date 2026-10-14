import type { AddressInfo } from 'node:net';
import { createServer, type Socket } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The readiness probe must never use the shared Prisma pool: a stalled database
// would strand pooled connections behind it. Any use of it fails the test.
const mocks = vi.hoisted(() => ({ sharedClientUse: vi.fn() }));

vi.mock('@db/server', () => ({
  db: new Proxy(
    {},
    {
      get: (_target, prop) => {
        mocks.sharedClientUse(prop);
        throw new Error('readiness used the shared Prisma client');
      },
    },
  ),
}));

// Each test loads the route afresh, as a new process would: its readiness check
// keeps the last result for two seconds.
let GET: (typeof import('./route'))['GET'];

// Throwaway local servers stand in for the database; nothing here connects to a
// real one. `stall` accepts TCP and never answers (a stalled pooler); `answer`
// speaks just enough of the Postgres protocol to complete SELECT 1.
function frame(type: string, body: string | Buffer): Buffer {
  const payload = typeof body === 'string' ? Buffer.from(body, 'latin1') : body;
  const length = Buffer.alloc(4);
  length.writeInt32BE(payload.length + 4);
  return Buffer.concat([Buffer.from(type, 'latin1'), length, payload]);
}

const STARTED = Buffer.concat([frame('R', Buffer.alloc(4)), frame('Z', 'I')]);
const ANSWERED = Buffer.concat([
  frame('C', 'SELECT 1\0'),
  frame('C', 'SELECT 1\0'),
  frame('Z', 'I'),
]);

type Fake = {
  url: string;
  connections: () => number;
  open: () => number;
  close: () => Promise<void>;
};

async function fakeDatabase(behaviour: 'stall' | 'answer'): Promise<Fake> {
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    let started = false;
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      if (behaviour === 'stall') return;
      if (!started) {
        started = true;
        socket.write(STARTED);
      } else if (chunk[0] === 'Q'.charCodeAt(0)) {
        socket.write(ANSWERED);
      } else if (chunk[0] === 'X'.charCodeAt(0)) {
        socket.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `postgresql://probe:probe@127.0.0.1:${port}/probe`,
    connections: () => connections,
    open: () => sockets.size,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

const wait = (ms: number) => new Promise((settle) => setTimeout(settle, ms));

describe('GET /api/health (app readiness, dedicated short-lived connection)', () => {
  const savedUrl = process.env.DATABASE_URL;
  let fake: Fake | undefined;

  beforeAll(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  beforeEach(async () => {
    vi.resetModules();
    ({ GET } = await import('./route'));
  });

  afterEach(async () => {
    await fake?.close();
    fake = undefined;
    expect(mocks.sharedClientUse).not.toHaveBeenCalled();
  });

  afterAll(() => {
    process.env.DATABASE_URL = savedUrl;
    vi.restoreAllMocks();
  });

  it('answers 200 {status: ok} from a database that answers SELECT 1, then closes the connection', async () => {
    fake = await fakeDatabase('answer');
    process.env.DATABASE_URL = fake.url;
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    await wait(50);
    expect(fake.open()).toBe(0);
  });

  it('answers 503 timeout to five overlapping requests against a stalled database with one connection, closed at the deadline', async () => {
    fake = await fakeDatabase('stall');
    process.env.DATABASE_URL = fake.url;
    const responses = await Promise.all(Array.from({ length: 5 }, () => GET()));
    expect(responses.map((response) => response.status)).toEqual([503, 503, 503, 503, 503]);
    for (const response of responses) {
      expect(await response.json()).toEqual({ status: 'unavailable', reason: 'timeout' });
    }
    expect(fake.connections()).toBe(1);
    await wait(50);
    expect(fake.open()).toBe(0);
  }, 10_000);

  it('reuses its result for two seconds without opening a connection, then probes again', async () => {
    fake = await fakeDatabase('answer');
    process.env.DATABASE_URL = fake.url;
    const start = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    try {
      expect((await GET()).status).toBe(200);
      clock.mockReturnValue(start + 1999);
      expect((await GET()).status).toBe(200);
      expect(fake.connections()).toBe(1);
      clock.mockReturnValue(start + 2000);
      expect((await GET()).status).toBe(200);
      expect(fake.connections()).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });

  it('answers 503 with the Prisma code and no connection details when nothing listens', async () => {
    const closed = await fakeDatabase('stall');
    process.env.DATABASE_URL = closed.url;
    await closed.close();
    const response = await GET();
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ status: 'unavailable', reason: 'P1001' });
    expect(text).not.toContain('127.0.0.1');
  });
});
