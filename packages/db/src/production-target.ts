// Refuses destructive commands against the shared production database. Laptops and
// production share one Supabase database (D7), so destructive schema and data commands
// check here first. The matching rules (which URL is production) live in
// production-verdict.ts.
//
// Lives in src (compiled into dist) so database-writing entry points under src can
// guard themselves; scripts/production-target-guard.ts adds the committed default for
// the Prisma CLI guard. No Bun-only APIs: prisma.config.ts loads it under Node.
import {
  type GuardEnv,
  type ProductionTarget,
  committedProductionTarget,
  productionVerdict,
} from './production-verdict';

export {
  committedProductionTarget,
  hashProjectRef,
  productionTargetSchema,
  productionVerdict,
  type GuardEnv,
  type ProductionTarget,
  type ProductionVerdict,
} from './production-verdict';

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
      'DATABASE_URL points at the production database (packages/db/src/production-target.json). ' +
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
      target: target ?? committedProductionTarget(),
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
