import { encodePathSegment, InvalidApiPathError } from '@/app/lib/api-path';
import { NextResponse, type NextRequest } from 'next/server';
import { proxyToApi } from '../../proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type UpdateParams = { params: Promise<{ filename: string }> };

/** The API path for one update file, or a 400 for an empty or dot-segment name. */
async function proxyUpdate({
  req,
  params,
  method,
}: {
  req: NextRequest;
  params: UpdateParams['params'];
  method: 'GET' | 'HEAD';
}): Promise<Response> {
  const { filename } = await params;
  let path: string;
  try {
    path = `/v1/device-agent/updates/${encodePathSegment(filename)}`;
  } catch (error) {
    if (error instanceof InvalidApiPathError) {
      return NextResponse.json({ error: 'Invalid filename' }, { status: 400 });
    }
    throw error;
  }
  return proxyToApi(req, path, method);
}

export async function GET(req: NextRequest, { params }: UpdateParams) {
  return proxyUpdate({ req, params, method: 'GET' });
}

export async function HEAD(req: NextRequest, { params }: UpdateParams) {
  return proxyUpdate({ req, params, method: 'HEAD' });
}
