// The direction of the callers that REQUIRE the production database rather than refuse it:
// deploy/server/secrets/values.ts (DATABASE_URL and DATABASE_MIGRATION_URL before
// push-secrets stores them). The Prisma CLI guard's direction (refuse when any part names
// production) is productionVerdict in production-target.ts; on its own it is no allowlist,
// because a URL naming production next to another project passes it. Ported from the parked
// ECS design (revola/aws-infra packages/db/src/production-connection.ts). No Bun-only APIs:
// prisma.config.ts loads this package's src under Node.
import {
  connectionCandidates,
  hashProjectRef,
  type ProductionTarget,
  projectRefsIn,
} from './production-target';

/**
 * For callers that require production: 'production' only when every project ref the URL names
 * (each user's `postgres.<ref>` suffix and each direct host's label, query-parameter overrides
 * included: pg-connection-string lets ?user= and ?host= replace the authority) is production's;
 * 'mixed' when production is named alongside another project; 'unverifiable' when pg could not
 * parse the URL.
 */
export function requiredProductionVerdict({
  databaseUrl,
  target,
}: {
  databaseUrl: string;
  target: ProductionTarget;
}): 'production' | 'mixed' | 'not_production' | 'unverifiable' {
  if (!URL.canParse(databaseUrl)) return 'unverifiable';
  let refs: string[];
  try {
    refs = projectRefsIn(connectionCandidates({ databaseUrl, env: {} }));
  } catch {
    return 'unverifiable';
  }
  const production = refs.filter((ref) => hashProjectRef(ref) === target.projectRefSha256);
  if (production.length === 0) return 'not_production';
  return production.length === refs.length ? 'production' : 'mixed';
}
