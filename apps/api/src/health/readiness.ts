import { db } from '@db';
import {
  checkDatabaseReadiness,
  READINESS_TIMEOUT_MS,
  type ReadinessResult,
} from '@trycompai/db';

/** `SELECT 1` against the API's database, bounded by the readiness timeout. */
export function checkApiReadiness({
  timeoutMs = READINESS_TIMEOUT_MS,
}: { timeoutMs?: number } = {}): Promise<ReadinessResult> {
  return checkDatabaseReadiness({
    probe: () => db.$queryRaw`SELECT 1`,
    timeoutMs,
  });
}
