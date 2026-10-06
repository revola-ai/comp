import { db } from '@db/server';
import { checkDatabaseReadiness } from '@trycompai/db';
import { NextResponse } from 'next/server';

// Readiness for release smoke tests and alarms: SELECT 1 with a 2-second
// timeout. A failure answers 503 with a reason (tls_<CODE>, a Prisma code,
// timeout or unknown) and never with connection details. The ALB uses
// /api/health/live instead, so a database outage does not cycle tasks.
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const result = await checkDatabaseReadiness({ probe: () => db.$queryRaw`SELECT 1` });
  if (result.status === 'ok') return NextResponse.json(result);
  console.error(`[health] database not ready: ${result.reason}`);
  return NextResponse.json(result, { status: 503 });
}
