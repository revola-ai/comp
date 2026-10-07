// Server only. The readiness probe opens its own short-lived `pg` connection instead
// of borrowing one from the shared Prisma pool, so a stalled database (one that
// accepts TCP but never answers) cannot strand pooled connections or queue requests
// behind probes. It imports `pg`, so it stays out of the package index that browser
// bundles reach; apps import it as `@trycompai/db/readiness-probe`.

import { Client } from 'pg';
import { buildPgAdapterOptions, type PgAdapterOptions } from './pg-adapter-options';
import { createReadinessCheck, type ReadinessCheck, readinessTimeoutError } from './readiness';

type Env = Partial<Record<string, string | undefined>>;

// The Prisma code that @prisma/adapter-pg and Prisma's engine give the same failure,
// so readiness reasons stay what they were when the probe ran through Prisma.
const SOCKET_ERROR_CODES: Record<string, string> = {
  ENOTFOUND: 'P1001',
  ECONNREFUSED: 'P1001',
  ECONNRESET: 'P1017',
  ETIMEDOUT: 'P1008',
};
const SQLSTATE_CODES: Record<string, string> = {
  '28P01': 'P1000',
  '3D000': 'P1003',
  '28000': 'P1010',
  '53300': 'P2037',
};
// pg's own deadlines (connectionTimeoutMillis, query_timeout), should they fire first.
const PG_TIMEOUT_MESSAGES = new Set(['timeout expired', 'Query read timeout']);

function field({ error, key }: { error: object; key: string }): unknown {
  return (error as Record<string, unknown>)[key];
}

function prismaCodeOf(error: object): string | undefined {
  const code = field({ error, key: 'code' });
  if (typeof code !== 'string') return undefined;
  if (typeof field({ error, key: 'syscall' }) === 'string') return SOCKET_ERROR_CODES[code];
  if (typeof field({ error, key: 'severity' }) === 'string') return SQLSTATE_CODES[code];
  return undefined;
}

/** The error a failed probe reports: the original under a Prisma code, if it has one. */
function asProbeError(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return error;
  const prismaCode = prismaCodeOf(error);
  if (prismaCode) {
    return Object.assign(new Error('database probe failed', { cause: error }), {
      code: prismaCode,
    });
  }
  const message = field({ error, key: 'message' });
  if (typeof message === 'string' && PG_TIMEOUT_MESSAGES.has(message)) {
    return readinessTimeoutError();
  }
  return error;
}

// After a successful probe, a server that does not close on Terminate gets this long.
const CLOSE_GRACE_MS = 1000;

/**
 * Sends Terminate and resolves once the connection's socket has closed; a server
 * that has not closed it after CLOSE_GRACE_MS has the socket destroyed instead.
 * `client.end()` resolves on the socket's close event, which a destroy also
 * emits, so it always settles.
 */
async function closeGracefully({
  client,
  destroy,
}: {
  client: Client;
  destroy: () => void;
}): Promise<void> {
  const force = setTimeout(destroy, CLOSE_GRACE_MS);
  try {
    await client.end();
  } finally {
    clearTimeout(force);
  }
}

/**
 * Runs `SELECT 1` on a dedicated connection that exists only for this probe, with one
 * deadline (`timeoutMs`) for connecting and querying together. At the deadline, or
 * on any error, the connection's socket is destroyed (its descriptor closes at once)
 * and the probe rejects (a timeout as `readinessTimeoutError`, which readinessReason
 * reports as `timeout`). The query also carries the deadline as its transaction's
 * statement_timeout, so the server abandons it too. pg's own connect and query
 * timeouts are set to the same deadline as a second bound. After a successful query
 * the probe resolves only once the connection is closed (Terminate, or a destroy
 * after CLOSE_GRACE_MS), so it settles within `timeoutMs + CLOSE_GRACE_MS` and the
 * single-flight check never has two probe connections open.
 */
export async function probeDatabase({
  connectionString,
  ssl,
  timeoutMs,
}: Pick<PgAdapterOptions, 'connectionString' | 'ssl'> & { timeoutMs: number }): Promise<void> {
  const deadlineMs = Math.max(1, Math.trunc(timeoutMs));
  const client = new Client({
    connectionString,
    ssl,
    connectionTimeoutMillis: deadlineMs,
    query_timeout: deadlineMs,
  });
  // A failure is reported through the promises below; pg also emits it as an
  // 'error' event, which must not go unhandled (that would crash the process).
  client.on('error', () => undefined);
  // The TCP socket, captured before any TLS upgrade replaces `connection.stream`
  // with a TLS socket on top of it; destroying both leaves nothing open.
  const socket = client.connection.stream;
  const destroy = () => {
    client.connection.stream.destroy();
    socket.destroy();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      destroy();
      reject(readinessTimeoutError());
    }, deadlineMs);
  });
  const run = async () => {
    await client.connect();
    await client.query(`SELECT set_config('statement_timeout', '${deadlineMs}', true); SELECT 1`);
  };
  try {
    await Promise.race([run(), deadline]);
  } catch (error) {
    destroy();
    throw asProbeError(error);
  } finally {
    clearTimeout(timer);
  }
  await closeGracefully({ client, destroy });
}

/**
 * The readiness check for the API and the app: overlapping checks share one
 * outstanding probe (createReadinessCheck), and each probe is `probeDatabase` with
 * the connection policy every Prisma client uses (buildPgAdapterOptions: TLS, CA,
 * the production checks), read from `env` when the probe runs, so importing this
 * module never needs a database configuration. A configuration the policy refuses
 * answers `unknown` (the API and app already refuse to boot with it).
 */
export function createDatabaseReadinessCheck({
  env = process.env,
  log,
}: {
  env?: Env;
  log?: (line: string) => void;
} = {}): ReadinessCheck {
  return createReadinessCheck({
    probe: async ({ timeoutMs }) => {
      const { connectionString, ssl } = buildPgAdapterOptions({
        databaseUrl: env.DATABASE_URL,
        env,
        log,
      });
      await probeDatabase({ connectionString, ssl, timeoutMs });
    },
  });
}
