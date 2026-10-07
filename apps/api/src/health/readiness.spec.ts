import { createServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

// The readiness probe must never use the shared Prisma pool: a stalled database
// would strand pooled connections behind it. Any use of it fails the test.
const mockSharedClientUse = jest.fn();
jest.mock('@db', () => ({
  db: new Proxy(
    {},
    {
      get: (_target, prop) => {
        mockSharedClientUse(prop);
        throw new Error('readiness used the shared Prisma client');
      },
    },
  ),
}));

import type { ReadinessCheck } from '@trycompai/db';

// Each test loads the module afresh, as a new process would: the check keeps
// its last result for two seconds.
let checkApiReadiness: ReadinessCheck;

// Throwaway local servers stand in for the database; nothing here connects to a
// real one. `stall` accepts TCP and never answers (a stalled pooler); `answer`
// speaks just enough of the Postgres protocol to complete SELECT 1.
const TIMEOUT_MS = 200;

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
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
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

describe('checkApiReadiness (dedicated short-lived connection)', () => {
  const savedUrl = process.env.DATABASE_URL;
  let fake: Fake | undefined;

  beforeAll(() => {
    jest.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  beforeEach(() => {
    jest.isolateModules(() => {
      ({ checkApiReadiness } =
        jest.requireActual<typeof import('./readiness')>('./readiness'));
    });
  });

  afterEach(async () => {
    await fake?.close();
    fake = undefined;
    expect(mockSharedClientUse).not.toHaveBeenCalled();
  });

  afterAll(() => {
    process.env.DATABASE_URL = savedUrl;
    jest.restoreAllMocks();
  });

  it('answers ok from a database that answers SELECT 1, then closes the connection', async () => {
    fake = await fakeDatabase('answer');
    process.env.DATABASE_URL = fake.url;
    await expect(checkApiReadiness({ timeoutMs: TIMEOUT_MS })).resolves.toEqual(
      { status: 'ok' },
    );
    await wait(50);
    expect(fake.open()).toBe(0);
  });

  it('leaves one probe outstanding for five concurrent checks against a stalled database, closed at the deadline', async () => {
    fake = await fakeDatabase('stall');
    process.env.DATABASE_URL = fake.url;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        checkApiReadiness({ timeoutMs: TIMEOUT_MS }),
      ),
    );
    expect(results).toEqual(
      Array(5).fill({ status: 'unavailable', reason: 'timeout' }),
    );
    expect(fake.connections()).toBe(1);
    await wait(50);
    expect(fake.open()).toBe(0);
  });

  it('reuses its result for two seconds without opening a connection, then probes again', async () => {
    fake = await fakeDatabase('answer');
    process.env.DATABASE_URL = fake.url;
    const start = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
    try {
      await checkApiReadiness({ timeoutMs: TIMEOUT_MS });
      clock.mockReturnValue(start + 1999);
      await expect(
        checkApiReadiness({ timeoutMs: TIMEOUT_MS }),
      ).resolves.toEqual({ status: 'ok' });
      expect(fake.connections()).toBe(1);
      clock.mockReturnValue(start + 2000);
      await checkApiReadiness({ timeoutMs: TIMEOUT_MS });
      expect(fake.connections()).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });

  it('answers P1001 when nothing listens on the database port', async () => {
    const closed = await fakeDatabase('stall');
    process.env.DATABASE_URL = closed.url;
    await closed.close();
    await expect(checkApiReadiness({ timeoutMs: TIMEOUT_MS })).resolves.toEqual(
      { status: 'unavailable', reason: 'P1001' },
    );
  });
});
