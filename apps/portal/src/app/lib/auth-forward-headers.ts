import 'server-only';
import { getPublicApiUrl, getServerApiHeaders } from './server-api-base-url';

function originOf(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate || !URL.canParse(candidate)) return undefined;
  return new URL(candidate).origin;
}

/**
 * The Origin the portal claims when the incoming request has none: the
 * portal's public URL (NEXT_PUBLIC_PORTAL_URL), else the public API URL, which
 * better-auth always trusts as its own base URL. Never the internal Service
 * Connect address (getServerApiBaseUrl), which is not a trusted origin.
 */
function fallbackOrigin(): string {
  return originOf(process.env.NEXT_PUBLIC_PORTAL_URL) ?? getPublicApiUrl();
}

/**
 * Headers the portal sends to the API's better-auth endpoints on behalf of the
 * incoming request: the session cookie, an Origin (better-auth refuses a
 * cookie-carrying POST without one, MISSING_OR_NULL_ORIGIN), the forwarded-IP
 * token and the sanitized client IP. Arbitrary `x-*` headers are not copied:
 * they would carry edge secrets such as `X-Comp-Origin-Auth` into the API's
 * logs and let a client choose the forwarded IP.
 */
export function buildAuthForwardHeaders({
  incoming,
}: {
  incoming: Headers;
}): Record<string, string> {
  const result: Record<string, string> = { ...getServerApiHeaders({ incoming }) };

  const cookie = incoming.get('cookie');
  if (cookie) result.cookie = cookie;

  // Server components render on GET navigations, which carry no Origin.
  result.origin = incoming.get('origin') || fallbackOrigin();

  return result;
}
