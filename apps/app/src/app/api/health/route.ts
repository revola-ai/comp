import { createDatabaseReadinessCheck } from '@trycompai/db/readiness-probe';
import { NextResponse } from 'next/server';

// Readiness for release smoke tests and alarms: SELECT 1 with a 2-second
// timeout. A failure answers 503 with a reason (tls_<CODE>, a Prisma code,
// timeout or unknown) and never with connection details. The ALB uses
// /api/health/live instead, so a database outage does not cycle tasks.
export const dynamic = 'force-dynamic';

// The probe runs on a dedicated short-lived connection (never the shared Prisma
// pool), closed at the deadline, and overlapping requests share the one
// outstanding probe, so an outage opens at most one probe connection at a time.
const checkReadiness = createDatabaseReadinessCheck();

export async function GET(): Promise<NextResponse> {
  const result = await checkReadiness();
  if (result.status === 'ok') return NextResponse.json(result);
  console.error(`[health] database not ready: ${result.reason}`);
  return NextResponse.json(result, { status: 503 });
}
