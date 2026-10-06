// Is this database URL the shared production database? Laptops and production share
// one Supabase database (D7), so destructive schema and data commands check here first.
//
// packages/db/production-target.json names production by the SHA-256 of its project ref
// (this fork is public, so the plain ref is never committed) plus its regional pooler
// host. A URL is production when the ref it carries hashes to that value: the pooler
// user `postgres.<ref>` on any regional pooler host, or the direct host
// `db.<ref>.supabase.co`. The shared regional pooler host alone does not count, so a
// separate development project in the same region is never refused.
//
// Lives in src (compiled into dist) so database-writing entry points under src can
// guard themselves; scripts/production-target-guard.ts adds the committed default for
// the Prisma CLI guard. No Bun-only APIs: prisma.config.ts loads it under Node.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** The project refs a URL names: the pooler user's suffix and the direct host's label. */
function projectRefsIn(url: URL): string[] {
  const refs: string[] = [];
  const username = decodeURIComponent(url.username);
  const dot = username.lastIndexOf('.');
  if (dot > 0 && dot < username.length - 1) refs.push(username.slice(dot + 1));
  const direct = DIRECT_HOST.exec(url.hostname.toLowerCase());
  if (direct?.[1]) refs.push(direct[1]);
  return refs;
}

function isProductionUrl({ url, target }: { url: URL; target: ProductionTarget }): boolean {
  return projectRefsIn(url).some((ref) => hashProjectRef(ref) === target.projectRefSha256);
}

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
  if (!databaseUrl || !URL.canParse(databaseUrl)) {
    if (optedIn) return 'production_opted_in';
    throw new ProdGuardError({
      code: 'database_url_unverifiable',
      detail: `DATABASE_URL is missing or not a valid URL, so the production guard cannot check it. Set ${OPT_IN}=1 to run anyway.`,
    });
  }
  if (!isProductionUrl({ url: new URL(databaseUrl), target })) return 'not_production';
  if (optedIn) return 'production_opted_in';
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
