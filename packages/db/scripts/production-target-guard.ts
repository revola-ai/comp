// The production guard with the committed target as its default, for the Prisma CLI
// guard (prisma.config.ts) and scripts/prod-guard.ts. The matching rules live in
// src/production-target.ts. No Bun-only APIs, no process access: prisma.config.ts loads
// this under Node.
import productionTargetJson from '../production-target.json';
import {
  type GuardEnv,
  type ProductionTarget,
  assertNotProduction as assertNotProductionFor,
  productionTargetSchema,
} from '../src/production-target';

export {
  OPT_IN,
  ProdGuardError,
  type GuardEnv,
  type ProdGuardErrorCode,
  type ProductionTarget,
} from '../src/production-target';

// The single committed source of the production database identity, validated on use
// so a malformed file fails the guarded command, never silently allows it.
export function loadProductionTarget(): ProductionTarget {
  return productionTargetSchema.parse(productionTargetJson);
}

export function assertNotProduction({
  databaseUrl,
  env,
  target,
}: {
  databaseUrl: string | undefined;
  env: GuardEnv;
  target?: ProductionTarget;
}): 'not_production' | 'production_opted_in' {
  return assertNotProductionFor({ databaseUrl, env, target: target ?? loadProductionTarget() });
}
