import { isIP } from 'node:net';
import 'server-only';

/**
 * Where server-side app code (route handlers, server components, server
 * actions) reaches the NestJS API, and which headers it adds.
 *
 * In production BACKEND_API_URL is the ECS Service Connect address
 * (`http://comp-api.comp.internal:3333`), so server calls stay inside the VPC
 * instead of looping through Cloudflare. Browser code must keep using
 * NEXT_PUBLIC_API_URL: the internal address is not reachable from a browser,
 * and INTERNAL_API_TOKEN must never reach a client bundle (hence
 * `server-only` above).
 */

/** Header the API's InternalTokenGuard reads (`req.headers['x-internal-token']`). */
export const INTERNAL_TOKEN_HEADER = 'X-Internal-Token';

const LOCAL_API_URL = 'http://localhost:3333';

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

/** `BACKEND_API_URL`, else `NEXT_PUBLIC_API_URL`, else localhost; empty counts as unset. */
export function getServerApiBaseUrl(): string {
  return stripTrailingSlashes(
    readEnv('BACKEND_API_URL') ?? readEnv('NEXT_PUBLIC_API_URL') ?? LOCAL_API_URL,
  );
}

/**
 * The public API URL (what browsers and better-auth's trusted origins know).
 * Used where the public address is required server-side, such as the
 * fallback `Origin` for better-auth's CSRF check.
 */
export function getPublicApiUrl(): string {
  return stripTrailingSlashes(readEnv('NEXT_PUBLIC_API_URL') ?? LOCAL_API_URL);
}

function validIp(value: string | null | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  return isIP(candidate) === 0 ? undefined : candidate;
}

/**
 * The end user's IP for the request being served. Cloudflare overwrites
 * `CF-Connecting-IP` on every request it proxies, so it wins when valid;
 * otherwise only the first entry of `X-Forwarded-For` is used. Anything that
 * is not a literal IPv4 or IPv6 address is dropped.
 */
function clientIp({ incoming }: { incoming: Pick<Headers, 'get'> }): string | undefined {
  const fromCloudflare = validIp(incoming.get('cf-connecting-ip'));
  if (fromCloudflare) return fromCloudflare;
  const forwardedFor = incoming.get('x-forwarded-for');
  if (!forwardedFor) return undefined;
  return validIp(forwardedFor.split(',')[0]);
}

/**
 * Headers every server-side API call adds next to its own auth (cookie,
 * bearer or service token): the internal token, which lets the API trust the
 * forwarded client IP, and that sanitized client IP. Nothing else from the
 * incoming request is copied, so edge headers such as `X-Comp-Origin-Auth`
 * never reach the API.
 */
export function getServerApiHeaders({ incoming }: { incoming: Headers }): Record<string, string> {
  const result: Record<string, string> = {};
  const token = readEnv('INTERNAL_API_TOKEN');
  if (token) result[INTERNAL_TOKEN_HEADER] = token;
  const ip = clientIp({ incoming });
  if (ip) result['X-Forwarded-For'] = ip;
  return result;
}
