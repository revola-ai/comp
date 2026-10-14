import type { ReadinessCheck } from '@trycompai/db';
import { createDatabaseReadinessCheck } from '@trycompai/db/readiness-probe';

/**
 * The API's readiness check: `SELECT 1` on a dedicated short-lived connection
 * (never the shared Prisma pool), closed at the 2-second deadline. Overlapping
 * calls share the one outstanding probe, so repeated probes during an outage
 * open at most one connection at a time, and a result is reused for 2 seconds,
 * so back-to-back calls to this public route do not each open one.
 */
export const checkApiReadiness: ReadinessCheck = createDatabaseReadinessCheck();
