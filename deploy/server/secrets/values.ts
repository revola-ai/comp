import {
  namesProductionDatabase,
  PRODUCTION_DATABASE,
  requiredProductionVerdict,
} from '../../../packages/db/src/production-connection.ts';
import type { ProductionTarget } from '../../../packages/db/src/production-target.ts';

// The checks every value of comp/production/config passes before push-secrets writes it.
// Messages name the key and never the value, not even a part of it.

const MIN_TOKEN_LENGTH = 32;
const TOKEN_KEY = /^(SERVICE_TOKEN_[A-Z0-9_]+|COMP_FORWARDED_IP_TOKEN|INTERNAL_API_TOKEN)$/;
const LAPTOP_HOSTS = ['localhost', '127.0.0.1', 'host.docker.internal'] as const;
const PROJECT_REF = /^proj_[a-z0-9]{20}$/;
const UPSTREAM_PROJECT_REFS: readonly string[] = ['proj_zhioyrusqertqgafqgpj', 'proj_lhxjliiqgcdyqbgtucda'];
const DATABASE_KEYS: readonly string[] = ['DATABASE_URL', 'DATABASE_MIGRATION_URL'];
const TRANSACTION_POOLER_PORT = '6543';
/**
 * The only query parameters a database URL may carry. pg-connection-string copies every query
 * parameter over the authority, so `user`, `host`, `port`, `password`, `database`, `db`,
 * `options` and the rest would move the connection or change its session while the authority
 * still reads as production. sslmode: the services strip it and refuse every other TLS
 * parameter at boot (packages/db/src/pg-adapter-options.ts), and the migrate container sets it
 * with the CA-verified sslcert and sslaccept (VERIFIED_URL in lib/server-stack.sh). sslaccept
 * is Prisma's alone. connect_timeout only bounds the connect. sslrootcert, sslcert and sslkey
 * name files pg reads while it parses the URL (here, on the laptop), so they are refused too.
 */
const ALLOWED_PARAMETERS: Readonly<Record<string, readonly string[]>> = {
  DATABASE_URL: ['sslmode', 'connect_timeout'],
  DATABASE_MIGRATION_URL: ['sslmode', 'sslaccept', 'connect_timeout'],
};
const ENCODE = 'percent-encode the user and password';
/**
 * The characters a value may not start or end with. render-env.sh lists the same set, written
 * identically (secrets/keys-grammar.test.ts compares them): JS trim() and Python strip()
 * disagree (strip() takes \x1c-\x1f and U+0085, trim() takes U+FEFF), so neither is used.
 */
// prettier-ignore
const EDGE_WHITESPACE = '\t\n\v\f\r \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
/** Connection parameters pg, libpq or Prisma read, named in refusals; any other name is not. */
const KNOWN_PARAMETERS: readonly string[] = [
  ...['user', 'password', 'host', 'hostaddr', 'port', 'database', 'dbname', 'db', 'service'],
  ...['options', 'schema', 'application_name', 'fallback_application_name', 'client_encoding'],
  ...['replication', 'target_session_attrs', 'keepalives', 'keepalives_idle', 'pgbouncer'],
  ...['ssl', 'sslmode', 'sslaccept', 'sslcert', 'sslkey', 'sslrootcert', 'sslcrl', 'sslpassword'],
  ...['sslnegotiation', 'uselibpqcompat', 'connect_timeout', 'connection_limit', 'pool_timeout'],
  ...['socket_timeout', 'statement_cache_size', 'statement_timeout', 'query_timeout'],
  ...['lock_timeout', 'idle_in_transaction_session_timeout'],
];

/** Why a value cannot be pushed under `key`; empty when it can. */
export function valueProblems({
  key,
  value,
  target,
}: {
  key: string;
  value: string;
  target: ProductionTarget;
}): string[] {
  if (value === '') return [`${key} is empty`];
  if (/[\r\n]/.test(value)) return [`${key} contains a line break`];
  if (value.includes('\0')) return [`${key} contains a NUL character`];
  // The services do not all trim (the API compares COMP_FORWARDED_IP_TOKEN as is, the app and
  // portal trim it), so a stray space would make them disagree silently.
  const [first, last] = [value.charAt(0), value.charAt(value.length - 1)];
  if (EDGE_WHITESPACE.includes(first) || EDGE_WHITESPACE.includes(last)) {
    return [`${key} has leading or trailing whitespace`];
  }
  const lowered = value.toLowerCase();
  const laptopHost = LAPTOP_HOSTS.find((host) => lowered.includes(host));
  if (laptopHost) {
    return [`${key} names ${laptopHost}, a laptop-only address; production needs the hosted service`];
  }
  if (TOKEN_KEY.test(key) && value.length < MIN_TOKEN_LENGTH) {
    return [`${key} must be at least ${MIN_TOKEN_LENGTH} characters`];
  }
  if (DATABASE_KEYS.includes(key)) return databaseUrlProblems({ key, value, target });
  if (key.startsWith('TRIGGER_SECRET_KEY_')) return triggerSecretKeyProblems({ key, value });
  if (key.startsWith('TRIGGER_PROJECT_REF_')) return projectRefProblems({ key, value });
  if (key === 'TRIGGER_ACCESS_TOKEN' && !value.startsWith('tr_pat_')) {
    return [`${key} must be a Trigger.dev personal access token (tr_pat_...)`];
  }
  return [];
}

function triggerSecretKeyProblems({ key, value }: { key: string; value: string }): string[] {
  if (value.startsWith('tr_prod_')) return [];
  if (value.startsWith('tr_dev_')) {
    return [`${key} is a dev key (tr_dev_); use the prod key (tr_prod_...) of the project`];
  }
  return [`${key} must be a Trigger.dev prod key (tr_prod_...)`];
}

function projectRefProblems({ key, value }: { key: string; value: string }): string[] {
  if (UPSTREAM_PROJECT_REFS.includes(value)) {
    return [`${key} is an upstream Comp AI project; use the Revola project ref`];
  }
  if (!PROJECT_REF.test(value)) {
    return [`${key} must be a Trigger.dev project ref (proj_ and 20 lowercase letters or digits)`];
  }
  return [];
}

/**
 * A database URL must parse, carry a user and password before the host, read back exactly as
 * written (so no unescaped character was reinterpreted: an unescaped /, ?, # or @ in the
 * password would otherwise be read as a host, port or path and echoed in a driver error), avoid
 * the transaction pooler, carry only the query parameters of ALLOWED_PARAMETERS, and name the
 * production project and no other, and its postgres database (packages/db/src/
 * production-connection.ts).
 */
function databaseUrlProblems({
  key,
  value,
  target,
}: {
  key: string;
  value: string;
  target: ProductionTarget;
}): string[] {
  if (!URL.canParse(value)) return [`${key} is not a valid URL; ${ENCODE}`];
  const url = new URL(value);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    return [`${key} must be a postgres:// or postgresql:// URL`];
  }
  if (url.username === '' || url.password === '') {
    return [
      `${key} has no user and password before the host; an unescaped /, ?, # or @ in the password ends it early, so ${ENCODE}`,
    ];
  }
  if (url.href !== value) {
    return [`${key} does not read back as written (an unescaped character in the user or password); ${ENCODE}`];
  }
  const parameters = parameterProblems({ key, url });
  if (parameters.length > 0) return parameters;
  if (url.port === TRANSACTION_POOLER_PORT) {
    return [
      `${key} uses port ${TRANSACTION_POOLER_PORT}, the transaction pooler; use the session pooler (5432) or the direct host`,
    ];
  }
  const verdict = requiredProductionVerdict({ databaseUrl: value, target });
  if (verdict === 'unverifiable') {
    return [`${key} cannot be checked against the production database; ${ENCODE}`];
  }
  if (verdict === 'not_production') {
    return [`${key} does not name the production database (packages/db/production-target.json)`];
  }
  if (verdict === 'mixed') {
    return [`${key} also names another project (its user and host carry different project refs)`];
  }
  // Never the name it does carry: it could be anything the operator pasted.
  if (!namesProductionDatabase({ databaseUrl: value })) {
    return [`${key} names a database other than ${PRODUCTION_DATABASE}`];
  }
  return [];
}

/**
 * One problem per known connection parameter outside the key's allowlist, by its name as pg
 * decodes it, and one for all other names together. Those other names are never repeated: a
 * malformed URL (an unescaped & in the password) turns part of a credential into a name.
 */
function parameterProblems({ key, url }: { key: string; url: URL }): string[] {
  const allowed = ALLOWED_PARAMETERS[key] ?? [];
  const reason = `which can change where or how it connects (allowed: ${allowed.join(', ')})`;
  const refused = [...new Set(url.searchParams.keys())].filter((name) => !allowed.includes(name));
  const unknown = refused.filter((name) => !KNOWN_PARAMETERS.includes(name)).length;
  const problems = refused
    .filter((name) => KNOWN_PARAMETERS.includes(name))
    .map((name) => `${key} carries the query parameter ${name}, ${reason}`);
  if (unknown > 0) {
    const what = unknown === 1 ? '1 query parameter that is' : `${unknown} query parameters that are`;
    problems.push(
      `${key} carries ${what} not a known connection parameter, not named here because it could be part of a credential; ${ENCODE}`,
    );
  }
  return problems;
}
