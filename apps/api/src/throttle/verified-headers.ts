import { createHash, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';

/** Set by the Cloudflare transform rule; proves a request came through Cloudflare. */
export const ORIGIN_AUTH_HEADER = 'x-comp-origin-auth';
/**
 * Sent by the app and portal on server-side calls through Service Connect.
 * It only attests the forwarded client IP; it grants no access, unlike the
 * privileged INTERNAL_API_TOKEN, which the app and portal never hold.
 */
export const FORWARDED_AUTH_HEADER = 'x-comp-forwarded-auth';

export type HeaderBag = Record<string, string | string[] | undefined>;
/**
 * Reads COMP_ORIGIN_AUTH, COMP_ORIGIN_AUTH_PREVIOUS, COMP_FORWARDED_IP_TOKEN
 * and TRUSTED_EDGE_PROXY_IPS.
 */
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
 * not leak the expected length. An empty or unset side, or a whitespace-only
 * expected value, never matches.
 */
export function secretMatches({
  presented,
  expected,
}: {
  presented: string | undefined;
  expected: string | undefined;
}): boolean {
  if (!presented || !expected?.trim()) return false;
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

/**
 * Comma-separated socket peer addresses of the Cloudflare Tunnel connector
 * (cloudflared). Cloudflare's edge sets CF-Connecting-IP and the connector
 * passes it on, so a request whose socket peer is listed carries the real
 * visitor address there.
 */
export const TRUSTED_EDGE_PROXY_IPS = 'TRUSTED_EDGE_PROXY_IPS';

const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** An IPv4-mapped IPv6 address (::ffff:a.b.c.d) as plain IPv4. */
export function unwrapIpv4Mapped(address: string): string {
  return IPV4_MAPPED.exec(address)?.[1] ?? address;
}

/**
 * The valid addresses of a TRUSTED_EDGE_PROXY_IPS value (trimmed, IPv4-mapped
 * IPv6 unwrapped), and how many entries were not an IP address. An unset or
 * blank value holds no entries; an empty entry ("a,,b") is invalid.
 */
export function parseTrustedEdgeProxyIps({
  value,
}: {
  value: string | undefined;
}): { addresses: string[]; invalidEntryCount: number } {
  if (!value?.trim()) return { addresses: [], invalidEntryCount: 0 };
  const entries = value
    .split(',')
    .map((entry) => unwrapIpv4Mapped(entry.trim()));
  const addresses = entries.filter((entry) => isIP(entry) !== 0);
  return { addresses, invalidEntryCount: entries.length - addresses.length };
}

function familyOf(address: string): 'ipv4' | 'ipv6' {
  return isIP(address) === 4 ? 'ipv4' : 'ipv6';
}

// Parsed once per distinct setting value, not on every request.
let trustedPeers: { value: string; list: BlockList } | undefined;
let warnedInvalidEntries = false;

/**
 * Production refuses an invalid list at boot (edge-secrets.ts); elsewhere the
 * invalid entries are ignored, and the process says so once, naming the
 * variable and the count, never the values.
 */
function warnInvalidEntries(count: number): void {
  if (count === 0 || warnedInvalidEntries) return;
  warnedInvalidEntries = true;
  console.warn(
    `${TRUSTED_EDGE_PROXY_IPS}: ignoring ${count} invalid ${count === 1 ? 'entry' : 'entries'} (not an IP address); CF-Connecting-IP is trusted only from the valid ones.`,
  );
}

function trustedPeerList(value: string): BlockList {
  if (trustedPeers?.value === value) return trustedPeers.list;
  const { addresses, invalidEntryCount } = parseTrustedEdgeProxyIps({ value });
  warnInvalidEntries(invalidEntryCount);
  const list = new BlockList();
  for (const address of addresses) {
    list.addAddress(address, familyOf(address));
  }
  trustedPeers = { value, list };
  return list;
}

/**
 * The socket peer is one of TRUSTED_EDGE_PROXY_IPS (never true when the
 * setting is unset or blank). Compares addresses, not strings, so another
 * spelling of a listed IPv6 address or its IPv4-mapped form still matches.
 */
export function isTrustedEdgePeer({
  peer,
  env,
}: {
  peer: string | undefined;
  env: SecretEnv;
}): boolean {
  const value = env[TRUSTED_EDGE_PROXY_IPS];
  if (!peer || !value?.trim()) return false;
  const address = unwrapIpv4Mapped(peer.trim());
  if (isIP(address) === 0) return false;
  return trustedPeerList(value).check(address, familyOf(address));
}
