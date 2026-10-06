import { getServerApiBaseUrl, getServerApiHeaders } from '@/app/lib/server-api-base-url';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Backwards-compat alias for device-agent installs (pre-PR #2222) that call
 * `${portalUrl}/api/auth/get-session` to verify their session. Better-auth
 * lives on the NestJS API now; cross-subdomain cookies (.trycomp.ai) make
 * the same session token valid against api.trycomp.ai.
 *
 * TODO: Delete after the device-agent fleet has rolled past 1.0.5.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const headers: Record<string, string> = getServerApiHeaders({ incoming: req.headers });
  const cookie = req.headers.get('cookie');
  if (cookie) headers['Cookie'] = cookie;
  const authorization = req.headers.get('authorization');
  if (authorization) headers['Authorization'] = authorization;

  const response = await fetch(`${getServerApiBaseUrl()}/api/auth/get-session`, {
    method: 'GET',
    headers,
    redirect: 'manual',
  });

  // Headers must use append for Set-Cookie so that multiple cookies (e.g.
  // session-refresh + cookie-cache) are preserved instead of comma-collapsed.
  const responseHeaders = new Headers();
  const contentType = response.headers.get('Content-Type');
  if (contentType) responseHeaders.set('Content-Type', contentType);
  for (const cookie of response.headers.getSetCookie()) {
    responseHeaders.append('Set-Cookie', cookie);
  }

  return new NextResponse(response.body, {
    status: response.status,
    headers: responseHeaders,
  });
}
