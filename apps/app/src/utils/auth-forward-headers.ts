import { getPublicApiUrl, getServerApiHeaders } from '@/lib/server-api-base-url';
import type { ReadonlyHeaders } from 'next/dist/server/web/spec-extension/adapters/headers';

/**
 * Headers the app sends to the API's better-auth endpoints on behalf of the
 * incoming request: the session cookie, the browser origin (better-auth's
 * CSRF check on POST), and the server headers (internal token plus the
 * sanitized client IP). Arbitrary `x-*` headers are not copied: they would
 * carry edge secrets such as `X-Comp-Origin-Auth` into the API's logs and let
 * a client choose the forwarded IP.
 */
export function buildAuthForwardHeaders({
  incoming,
}: {
  incoming: ReadonlyHeaders | Headers;
}): Record<string, string> {
  const result: Record<string, string> = { ...getServerApiHeaders({ incoming }) };

  const cookie = incoming.get('cookie');
  if (cookie) result.cookie = cookie;

  // Server actions and server components may arrive without an Origin. The
  // fallback must be the public API URL, which better-auth always trusts; the
  // internal Service Connect address is not a trusted origin.
  result.origin = incoming.get('origin') || getPublicApiUrl();

  return result;
}
