import { z } from 'zod';
import { DatabaseConfigError } from './database-config-error';
import { isLocalhostUrl, resolveSslConfig, stripSslMode, type SslConfig } from './ssl-config';

// The one connection policy for every Prisma client (api, app, portal, framework
// editor, Trigger workers, seed): TLS from resolveSslConfig, pool size from
// DATABASE_POOL_MAX, and a hard stop when a production process would talk to a
// remote database without the CA it needs to verify it.

export type PgAdapterOptions = {
  connectionString: string;
  ssl: SslConfig;
  max?: number;
};

export type TlsMode = 'disabled' | 'verified' | 'chain-only' | 'insecure';

type Env = Partial<Record<string, string | undefined>>;
type LogSink = (line: string) => void;

const POOL_MAX_MIN = 1;
const POOL_MAX_MAX = 50;

const poolMaxSchema = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().min(POOL_MAX_MIN).max(POOL_MAX_MAX));

const TLS_MODE_DESCRIPTIONS: Record<TlsMode, string> = {
  disabled: 'disabled (local database host)',
  verified: 'verified (chain and hostname, Node roots plus DATABASE_SSL_CA)',
  'chain-only': 'chain-only (Node trust store, hostname not checked)',
  insecure: 'insecure (PRISMA_ALLOW_INSECURE_TLS=1, certificate not verified)',
};

// One startup line per sink, however many clients a process builds.
const loggedSinks = new WeakSet<LogSink>();

function defaultLog(line: string): void {
  console.info(line);
}

function parsePoolMax(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const parsed = poolMaxSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DatabaseConfigError({
      code: 'pool_max_invalid',
      detail: `DATABASE_POOL_MAX must be a whole number from ${POOL_MAX_MIN} to ${POOL_MAX_MAX}, e.g. DATABASE_POOL_MAX=10`,
    });
  }
  return parsed.data;
}

function assertProductionCa({ databaseUrl, env }: { databaseUrl: string; env: Env }): void {
  if (env.NODE_ENV !== 'production') return;
  if (isLocalhostUrl(databaseUrl)) return;
  if (env.DATABASE_SSL_CA) return;
  if (env.PRISMA_ALLOW_INSECURE_TLS === '1') return;
  throw new DatabaseConfigError({
    code: 'ca_file_missing',
    detail:
      'NODE_ENV=production with a non-local database requires DATABASE_SSL_CA, the path of the ' +
      "database server's CA certificate (e.g. DATABASE_SSL_CA=/app/certs/supabase-ca.crt). " +
      'PRISMA_ALLOW_INSECURE_TLS=1 is the only explicit opt-out.',
  });
}

// pg parses the connection string over the explicit options, so these URL parameters
// would replace the enforced `ssl` config (ssl=0 turns TLS off, sslrootcert swaps the
// trust store, uselibpqcompat or sslnegotiation=direct rewrite it). sslmode values the
// enforced verified TLS already satisfies are stripped instead (stripSslMode).
const TLS_OVERRIDE_PARAMS = ['ssl', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat'];
const SATISFIED_SSL_MODES = new Set(['require', 'verify-ca', 'verify-full']);

function conflictingTlsParams(databaseUrl: string): string[] {
  const params = new URL(databaseUrl).searchParams;
  const conflicts = TLS_OVERRIDE_PARAMS.filter((name) => params.has(name));
  if (params.getAll('sslmode').some((mode) => !SATISFIED_SSL_MODES.has(mode))) {
    conflicts.push('sslmode');
  }
  if (params.getAll('sslnegotiation').some((value) => value !== 'postgres')) {
    conflicts.push('sslnegotiation');
  }
  return conflicts;
}

function assertNoTlsParamConflict({ databaseUrl, env }: { databaseUrl: string; env: Env }): void {
  if (env.NODE_ENV !== 'production') return;
  if (isLocalhostUrl(databaseUrl)) return;
  const conflicts = conflictingTlsParams(databaseUrl);
  if (conflicts.length === 0) return;
  throw new DatabaseConfigError({
    code: 'ssl_param_conflict',
    detail:
      `DATABASE_URL sets ${conflicts.join(', ')}, which would override the enforced TLS ` +
      'settings (DATABASE_SSL_CA, verified chain and hostname). Remove it from the URL; ' +
      'sslmode=require, verify-ca and verify-full are accepted and stripped.',
  });
}

export function tlsModeOf(ssl: SslConfig): TlsMode {
  if (ssl === undefined) return 'disabled';
  if ('ca' in ssl) return 'verified';
  if ('rejectUnauthorized' in ssl) return 'insecure';
  return 'chain-only';
}

export function buildPgAdapterOptions({
  databaseUrl,
  env = process.env,
  log = defaultLog,
}: {
  databaseUrl: string | undefined;
  env?: Env;
  log?: LogSink;
}): PgAdapterOptions {
  if (!databaseUrl) {
    throw new DatabaseConfigError({
      code: 'database_url_missing',
      detail:
        'DATABASE_URL is not set, e.g. DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/comp',
    });
  }
  if (!URL.canParse(databaseUrl)) {
    // Never echo the value: it carries the password.
    throw new DatabaseConfigError({
      code: 'database_url_invalid',
      detail: 'DATABASE_URL is not a valid URL, e.g. postgresql://user:password@host:5432/database',
    });
  }
  const max = parsePoolMax(env.DATABASE_POOL_MAX);
  assertProductionCa({ databaseUrl, env });
  assertNoTlsParamConflict({ databaseUrl, env });
  const ssl = resolveSslConfig(databaseUrl, env);
  const connectionString = ssl === undefined ? databaseUrl : stripSslMode(databaseUrl);

  if (!loggedSinks.has(log)) {
    loggedSinks.add(log);
    const pool = max === undefined ? 'driver default' : String(max);
    log(`[db] TLS ${TLS_MODE_DESCRIPTIONS[tlsModeOf(ssl)]}; pool max ${pool}`);
  }

  return max === undefined ? { connectionString, ssl } : { connectionString, ssl, max };
}
