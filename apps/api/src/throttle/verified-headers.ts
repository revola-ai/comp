import { createHash, timingSafeEqual } from 'node:crypto';

/** Set by the Cloudflare transform rule; proves a request came through Cloudflare. */
export const ORIGIN_AUTH_HEADER = 'x-comp-origin-auth';
/**
 * Sent by the app and portal on server-side calls through Service Connect.
 * It only attests the forwarded client IP; it grants no access, unlike the
 * privileged INTERNAL_API_TOKEN, which the app and portal never hold.
 */
export const FORWARDED_AUTH_HEADER = 'x-comp-forwarded-auth';

export type HeaderBag = Record<string, string | string[] | undefined>;
/** Reads COMP_ORIGIN_AUTH, COMP_ORIGIN_AUTH_PREVIOUS and COMP_FORWARDED_IP_TOKEN. */
export type SecretEnv = Readonly<Record<string, string | undefined>>;

export function headerValue({
  headers,
  name,
}: {
  headers: HeaderBag;
  name: string;
}): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Timing-safe comparison. Both sides are hashed first so the comparison does
 * not leak the expected length. An empty or unset side never matches.
 */
export function secretMatches({
  presented,
  expected,
}: {
  presented: string | undefined;
  expected: string | undefined;
}): boolean {
  if (!presented || !expected) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

/** The request carries COMP_ORIGIN_AUTH or, during rotation, COMP_ORIGIN_AUTH_PREVIOUS. */
export function hasValidOriginAuth({
  headers,
  env,
}: {
  headers: HeaderBag;
  env: SecretEnv;
}): boolean {
  const presented = headerValue({ headers, name: ORIGIN_AUTH_HEADER });
  const current = secretMatches({ presented, expected: env.COMP_ORIGIN_AUTH });
  const previous = secretMatches({
    presented,
    expected: env.COMP_ORIGIN_AUTH_PREVIOUS,
  });
  return current || previous;
}

/** The request carries COMP_FORWARDED_IP_TOKEN (never true when it is unset or empty). */
export function hasValidForwardedAuth({
  headers,
  env,
}: {
  headers: HeaderBag;
  env: SecretEnv;
}): boolean {
  return secretMatches({
    presented: headerValue({ headers, name: FORWARDED_AUTH_HEADER }),
    expected: env.COMP_FORWARDED_IP_TOKEN,
  });
}
