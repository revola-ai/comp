import { NextResponse } from 'next/server';

// Portal liveness for the ALB health check and release smoke test: answers
// while the server runs. It must not import the database, auth or next/headers
// (route.test.ts enforces this), so a dependency outage does not cycle tasks.
export const dynamic = 'force-dynamic';

export function GET(): NextResponse {
  return NextResponse.json({ status: 'ok' });
}
