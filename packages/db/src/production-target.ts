// Is this database URL the shared production database? Laptops and production share
// one Supabase database (D7), so destructive schema and data commands check here first.
//
// packages/db/production-target.json names production by the SHA-256 of its project ref
// (this fork is public, so the plain ref is never committed) plus its regional pooler
// host. A URL is production when the ref it carries hashes to that value: the pooler
// user `postgres.<ref>` on any regional pooler host, or the direct host
// `db.<ref>.supabase.co`. The shared regional pooler host alone does not count, so a
// separate development project in the same region is never refused. The check reads the
// effective connection parameters the way pg does (query-parameter overrides, every host
// of a host list, PGUSER/PGHOST fallbacks, case and trailing-dot normalized), and a URL
// pg cannot parse is refused like a missing one.
//
// Lives in src (compiled into dist) so database-writing entry points under src can
// guard themselves; scripts/production-target-guard.ts adds the committed default for
// the Prisma CLI guard. No Bun-only APIs: prisma.config.ts loads it under Node.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'pg-connection-string';
import { z } from 'zod';

export const productionTargetSchema = z
  .object({
    projectRefSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'projectRefSha256 must be 64 lowercase hex characters'),
    poolerHost: z
      .string()
      .regex(
        /^[a-z0-9.-]+\.pooler\.supabase\.com$/,
        'poolerHost must end with .pooler.supabase.com',
      ),
  })
  .strict();

export type ProductionTarget = z.infer<typeof productionTargetSchema>;

export type GuardEnv = Record<string, string | undefined>;

export type ProdGuardErrorCode = 'production_target_refused' | 'database_url_unverifiable';

export class ProdGuardError extends Error {
  readonly code: ProdGuardErrorCode;

  constructor({ code, detail }: { code: ProdGuardErrorCode; detail: string }) {
    super(`${code}: ${detail}`);
    this.name = 'ProdGuardError';
    this.code = code;
  }
}

export const OPT_IN = 'COMP_I_AM_TOUCHING_PROD';

/** Lowercase hex SHA-256 of the lowercased project ref (refs are case-insensitive). */
export function hashProjectRef(ref: string): string {
  return createHash('sha256').update(ref.toLowerCase()).digest('hex');
}

/** production-target.json, read from the package root (src/ and dist/ sit one level below). */
export function readProductionTargetFile(): ProductionTarget {
  const path = join(__dirname, '..', 'production-target.json');
  return productionTargetSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

const DIRECT_HOST = /^db\.([a-z0-9]+)\.supabase\.co$/;

/** DNS names compare case-insensitively and a trailing dot names the same host. */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, '');
}

/** A comma-separated host list (libpq form) as its individual hosts. */
function splitHosts(value: string | null | undefined): string[] {
  return (value ?? '').split(',').map(normalizeHost).filter(Boolean);
}

type ConnectionCandidates = { users: string[]; hosts: string[] };

/**
 * Every user and host the connection could use, read the way pg reads the URL
 * (pg-connection-string's parse: a `user` or `host` query parameter overrides the
 * authority, values are percent-decoded) plus libpq's spelling of both and pg's
 * PGUSER and PGHOST fallbacks for what the URL leaves out. Throws when pg could not
 * parse it either.
 */
function connectionCandidates({
  databaseUrl,
  env,
}: {
  databaseUrl: string;
  env: GuardEnv;
}): ConnectionCandidates {
  const parsed = parse(databaseUrl);
  const url = new URL(databaseUrl);
  const users = [parsed.user, decodeURIComponent(url.username), url.searchParams.get('user')];
  const hosts = [
    ...splitHosts(parsed.host),
    ...splitHosts(decodeURIComponent(url.hostname)),
    ...url.searchParams.getAll('host').flatMap(splitHosts),
  ];
  if (!parsed.user) users.push(env.PGUSER);
  if (!parsed.host) hosts.push(...splitHosts(env.PGHOST));
  return {
    users: users.filter((user): user is string => Boolean(user)),
    hosts,
  };
}

/** The project refs the connection names: a pooler user's suffix or a direct host's label. */
function projectRefsIn({ users, hosts }: ConnectionCandidates): string[] {
  const refs: string[] = [];
  for (const user of users) {
    const dot = user.lastIndexOf('.');
    if (dot > 0 && dot < user.length - 1) refs.push(user.slice(dot + 1));
  }
  for (const host of hosts) {
    const direct = DIRECT_HOST.exec(host);
    if (direct?.[1]) refs.push(direct[1]);
  }
  return refs;
}

/** 'unverifiable' when pg could not parse the URL, so the guard fails closed. */
function productionVerdict({
  databaseUrl,
  env,
  target,
}: {
  databaseUrl: string;
  env: GuardEnv;
  target: ProductionTarget;
}): 'production' | 'not_production' | 'unverifiable' {
  let candidates: ConnectionCandidates;
  try {
    candidates = connectionCandidates({ databaseUrl, env });
  } catch {
    return 'unverifiable';
  }
  const production = projectRefsIn(candidates).some(
    (ref) => hashProjectRef(ref) === target.projectRefSha256,
  );
  return production ? 'production' : 'not_production';
}

const UNVERIFIABLE_DETAIL = `DATABASE_URL is missing or cannot be parsed, so the production guard cannot check it. Set ${OPT_IN}=1 to run anyway.`;

// Throws unless the URL is somewhere other than production or the opt-in is set.
// Returns 'production_opted_in' when it lets a production URL through on the opt-in.
export function assertNotProduction({
  databaseUrl,
  env,
  target,
}: {
  databaseUrl: string | undefined;
  env: GuardEnv;
  target: ProductionTarget;
}): 'not_production' | 'production_opted_in' {
  const optedIn = env[OPT_IN] === '1';
  const verdict =
    databaseUrl && URL.canParse(databaseUrl)
      ? productionVerdict({ databaseUrl, env, target })
      : 'unverifiable';
  if (verdict === 'not_production') return 'not_production';
  if (optedIn) return 'production_opted_in';
  if (verdict === 'unverifiable') {
    throw new ProdGuardError({ code: 'database_url_unverifiable', detail: UNVERIFIABLE_DETAIL });
  }
  throw new ProdGuardError({
    code: 'production_target_refused',
    detail:
      'DATABASE_URL points at the production database (packages/db/production-target.json). ' +
      'Author migrations with `bun run db:migrate:create` against the local comp_dev database; ' +
      `production schema changes ship with release.sh migrate. Set ${OPT_IN}=1 only to touch production on purpose.`,
  });
}

/**
 * First statement of a database-writing entry point that bypasses the Prisma CLI (the
 * seed script, one-off backfills): exits 1 against production unless the opt-in is set,
 * and says so once when it is.
 */
export function refuseProductionEntryPoint({
  name,
  env = process.env,
  target,
  exit = (code: number) => process.exit(code),
  printError = (line: string) => console.error(line),
}: {
  name: string;
  env?: GuardEnv;
  target?: ProductionTarget;
  exit?: (code: number) => void;
  printError?: (line: string) => void;
}): void {
  try {
    const outcome = assertNotProduction({
      databaseUrl: env.DATABASE_URL,
      env,
      target: target ?? readProductionTargetFile(),
    });
    if (outcome === 'production_opted_in') {
      printError(`${OPT_IN}=1: running \`${name}\` against the production database`);
    }
  } catch (error) {
    if (!(error instanceof ProdGuardError)) throw error;
    printError(`refusing \`${name}\`: ${error.message}`);
    exit(1);
  }
}
