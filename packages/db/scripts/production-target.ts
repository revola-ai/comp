// The one zod schema for packages/db/production-target.json, shared by the production
// guard (scripts/production-target-guard.ts) and deploy/aws/config.ts.
export {
  hashProjectRef,
  productionTargetSchema,
  type ProductionTarget,
} from '../src/production-target';
