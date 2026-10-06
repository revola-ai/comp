import { db } from '@db/server';
import { createReadinessCheck, READINESS_TIMEOUT_MS } from '@trycompai/db';
import { NextResponse } from 'next/server';

// Readiness for release smoke tests and alarms: SELECT 1 with a 2-second
// timeout. A failure answers 503 with a reason (tls_<CODE>, a Prisma code,
// timeout or unknown) and never with connection details. The ALB uses
// /api/health/live instead, so a database outage does not cycle tasks.
export const dynamic = 'force-dynamic';

// SELECT 1 in one transaction whose statement_timeout is the readiness timeout, so
// the server abandons it too; connecting and waiting for a pooled connection are
// bounded by the adapter's connectionTimeoutMillis. Overlapping requests share one
// in-flight probe, so repeated probes during an outage do not pile up.
const checkReadiness = createReadinessCheck({
  probe: () =>
    db.$transaction([
      db.$queryRaw`SELECT set_config('statement_timeout', ${String(READINESS_TIMEOUT_MS)}, true)`,
      db.$queryRaw`SELECT 1`,
    ]),
});

export async function GET(): Promise<NextResponse> {
  const result = await checkReadiness();
  if (result.status === 'ok') return NextResponse.json(result);
  console.error(`[health] database not ready: ${result.reason}`);
  return NextResponse.json(result, { status: 503 });
}
