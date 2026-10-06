import { db } from '@db';
import {
  createReadinessCheck,
  READINESS_TIMEOUT_MS,
  type ReadinessCheck,
} from '@trycompai/db';

/**
 * `SELECT 1` in one transaction whose statement_timeout is the readiness timeout,
 * so the server abandons the probe too. Connecting and waiting for a pooled
 * connection are bounded by the adapter's connectionTimeoutMillis.
 */
function readinessProbe(): Promise<unknown> {
  return db.$transaction([
    db.$queryRaw`SELECT set_config('statement_timeout', ${String(READINESS_TIMEOUT_MS)}, true)`,
    db.$queryRaw`SELECT 1`,
  ]);
}

/**
 * The API's readiness check. Overlapping calls share one in-flight probe, so
 * repeated probes during an outage do not pile up queries or pool waiters.
 */
export const checkApiReadiness: ReadinessCheck = createReadinessCheck({
  probe: readinessProbe,
});
