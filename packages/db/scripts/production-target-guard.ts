// Is this database URL the shared production database? Laptops and production share
// one Supabase database (D7), so destructive schema and data commands check here first.
// Pure (no Bun-only APIs, no process access): it runs inside prisma.config.ts, which
// the Prisma CLI loads with jiti under Node, and in Bun scripts.
import { z } from 'zod';
import productionTargetJson from '../production-target.json';

const productionTargetSchema = z.object({
  projectRef: z.string().min(1),
  poolerHost: z.string().min(1),
});

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

// The single committed source of the production database identity, validated on use
// so a malformed file fails the guarded command, never silently allows it.
export function loadProductionTarget(): ProductionTarget {
  return productionTargetSchema.parse(productionTargetJson);
}

function isProductionUrl({ url, target }: { url: URL; target: ProductionTarget }): boolean {
  const host = url.hostname.toLowerCase();
  if (host === target.poolerHost.toLowerCase()) return true;
  // The direct connection to the same project, and the pooler's per-project user name
  // (postgres.<ref>) on any regional pooler host.
  if (host === `db.${target.projectRef}.supabase.co`.toLowerCase()) return true;
  return decodeURIComponent(url.username).endsWith(`.${target.projectRef}`);
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
  target?: ProductionTarget;
}): 'not_production' | 'production_opted_in' {
  const optedIn = env[OPT_IN] === '1';
  if (!databaseUrl || !URL.canParse(databaseUrl)) {
    if (optedIn) return 'production_opted_in';
    throw new ProdGuardError({
      code: 'database_url_unverifiable',
      detail: `DATABASE_URL is missing or not a valid URL, so the production guard cannot check it. Set ${OPT_IN}=1 to run anyway.`,
    });
  }
  const resolvedTarget = target ?? loadProductionTarget();
  if (!isProductionUrl({ url: new URL(databaseUrl), target: resolvedTarget })) {
    return 'not_production';
  }
  if (optedIn) return 'production_opted_in';
  throw new ProdGuardError({
    code: 'production_target_refused',
    detail:
      'DATABASE_URL points at the production database (packages/db/production-target.json). ' +
      'Author migrations with `bun run db:migrate:create` against the local comp_dev database; ' +
      `production schema changes ship with release.sh migrate. Set ${OPT_IN}=1 only to touch production on purpose.`,
  });
}
