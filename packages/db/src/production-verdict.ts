// Does this database URL name the shared production database? The matching rules, with
// no static Node built-in import: the connection policy (pg-adapter-options.ts) applies
// production's TLS rules by this verdict, and it sits in the package index's module
// graph, which Next.js client bundles reach (see index-browser-safe.test.ts).
//
// production-target.json (next to this file, so it is compiled into dist with it) names
// production by the SHA-256 of its project ref (this fork is public, so the plain ref is
// never committed) plus its regional pooler host. A URL is production when the ref it
// carries hashes to that value: the pooler user `postgres.<ref>` on any regional pooler
// host, or the direct host `db.<ref>.supabase.co`. The shared regional pooler host alone
// does not count, so a separate development project in the same region is never
// refused. The check reads the effective connection parameters the way pg does
// (query-parameter overrides, every host of a host list, PGUSER/PGHOST fallbacks, case
// and trailing-dot normalized), and a URL pg cannot parse is 'unverifiable'.
import type * as NodeCrypto from 'node:crypto';
import { parse } from 'pg-connection-string';
import { z } from 'zod';
import productionTargetJson from './production-target.json';

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

export type ProductionVerdict = 'production' | 'not_production' | 'unverifiable';

/** The committed production target, validated on use so a malformed file fails closed. */
export function committedProductionTarget(): ProductionTarget {
  return productionTargetSchema.parse(productionTargetJson);
}

/** Lowercase hex SHA-256 of the lowercased project ref (refs are case-insensitive). */
export function hashProjectRef(ref: string): string {
  const crypto = process.getBuiltinModule('node:crypto') as typeof NodeCrypto;
  return crypto.createHash('sha256').update(ref.toLowerCase()).digest('hex');
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

/** 'unverifiable' when pg could not parse the URL, so callers fail closed. */
export function productionVerdict({
  databaseUrl,
  env,
  target,
}: {
  databaseUrl: string;
  env: GuardEnv;
  target: ProductionTarget;
}): ProductionVerdict {
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
