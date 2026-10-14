import { assertSafeApiPath, encodePathSegment, InvalidApiPathError } from '@/lib/api-path';
import { getServerApiBaseUrl, getServerApiHeaders } from '@/lib/server-api-base-url';
import { NextRequest, NextResponse } from 'next/server';

/** The API path to export, or null when the query names nothing to export. */
function exportPath({
  memberId,
  exportAll,
}: {
  memberId: string | null;
  exportAll: boolean;
}): string | null {
  if (exportAll) return '/v1/offboarding-checklist/export-all';
  if (!memberId) return null;
  const path = `/v1/offboarding-checklist/member/${encodePathSegment(memberId)}/export`;
  assertSafeApiPath(path);
  return path;
}

export async function GET(request: NextRequest) {
  const memberId = request.nextUrl.searchParams.get('memberId');
  const exportAll = request.nextUrl.searchParams.get('all') === 'true';

  let path: string | null;
  try {
    path = exportPath({ memberId, exportAll });
  } catch (error) {
    if (error instanceof InvalidApiPathError) {
      return NextResponse.json({ error: 'Invalid memberId' }, { status: 400 });
    }
    throw error;
  }
  if (!path) {
    return NextResponse.json({ error: 'memberId or all=true required' }, { status: 400 });
  }
  const endpoint = `${getServerApiBaseUrl()}${path}`;

  const cookieHeader = request.headers.get('cookie') ?? '';
  const authorizationHeader = request.headers.get('authorization');

  let response: Response;
  try {
    const forwardHeaders: Record<string, string> = {
      ...getServerApiHeaders({ incoming: request.headers }),
      cookie: cookieHeader,
    };
    if (authorizationHeader) {
      forwardHeaders.authorization = authorizationHeader;
    }
    response = await fetch(endpoint, {
      headers: forwardHeaders,
    });
  } catch {
    return NextResponse.json({ error: 'Export service unavailable' }, { status: 502 });
  }

  if (!response.ok) {
    return NextResponse.json({ error: 'Export failed' }, { status: response.status });
  }

  const headers = new Headers();
  headers.set('Content-Type', 'application/zip');
  headers.set(
    'Content-Disposition',
    response.headers.get('Content-Disposition') ?? 'attachment; filename="offboarding-export.zip"',
  );

  return new NextResponse(response.body, { headers });
}
