import { NextResponse } from 'next/server';

// Liveness for the ALB health check: answers while the server runs. It must not
// import the database, auth or next/headers (route.test.ts enforces this), so a
// database or auth outage does not make the ALB cycle healthy tasks.
export const dynamic = 'force-dynamic';

export function GET(): NextResponse {
  return NextResponse.json({ status: 'ok' });
}
