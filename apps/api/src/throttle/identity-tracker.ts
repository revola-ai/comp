import { isIP } from 'node:net';
import {
  type HeaderBag,
  hasValidForwardedAuth,
  hasValidOriginAuth,
  headerValue,
  type SecretEnv,
} from './verified-headers';

/**
 * The parts of a request the tracker reads. Identity fields are set by
 * HybridAuthGuard (see auth/types.ts) and are absent before it runs.
 */
export type TrackableRequest = {
  headers: HeaderBag;
  ip?: string;
  socket?: { remoteAddress?: string };
  authType?: 'api-key' | 'session' | 'service';
  userId?: string;
  apiKeyId?: string;
  serviceName?: string;
};

const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

function validIp(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate && isIP(candidate) ? candidate : undefined;
}

/**
 * The client address, trusting proxy headers only when the request proves
 * where it came from:
 * - a valid forwarded-auth token (Service Connect from the app or portal):
 *   the first X-Forwarded-For entry, which the caller sanitized to one client
 *   IP (the Envoy sidecar may append its own hop after it);
 * - a valid origin header (Cloudflare): CF-Connecting-IP;
 * - otherwise the socket address. There is no `trust proxy`, so a forged
 *   X-Forwarded-For never reaches `req.ip`.
 */
export function verifiedClientIp({
  req,
  env = process.env,
}: {
  req: TrackableRequest;
  env?: SecretEnv;
}): string | undefined {
  const { headers } = req;
  if (hasValidForwardedAuth({ headers, env })) {
    const forwarded = headerValue({ headers, name: 'x-forwarded-for' });
    const first = validIp(forwarded?.split(',')[0]);
    if (first) return first;
  }
  if (hasValidOriginAuth({ headers, env })) {
    const connecting = validIp(
      headerValue({ headers, name: 'cf-connecting-ip' }),
    );
    if (connecting) return connecting;
  }
  return validIp(req.ip) ?? validIp(req.socket?.remoteAddress);
}

function expandIpv6(address: string): string[] {
  const [head, tail] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<string>(missing).fill('0'), ...right].map((group) =>
    group.padStart(4, '0'),
  );
}

/**
 * The throttling bucket for an address: IPv4 as is (IPv4-mapped IPv6 unwrapped),
 * IPv6 by /64, since one host usually controls a whole /64.
 */
export function ipBucket(address: string): string {
  const mapped = IPV4_MAPPED.exec(address);
  if (mapped) return mapped[1];
  if (isIP(address) !== 6 || address.includes('.'))
    return address.toLowerCase();
  const prefix = expandIpv6(address.toLowerCase()).slice(0, 4).join(':');
  return `${prefix}::/64`;
}

/**
 * Throttling key: verified identity when the request is authenticated (API key
 * ID, service-token name, session user ID), else the verified client IP.
 */
export function identityTracker({
  req,
  env = process.env,
}: {
  req: TrackableRequest;
  env?: SecretEnv;
}): string {
  if (req.authType === 'api-key' && req.apiKeyId) {
    return `api-key:${req.apiKeyId}`;
  }
  if (req.authType === 'service' && req.serviceName) {
    return `service:${req.serviceName}`;
  }
  if (req.authType === 'session' && req.userId) return `user:${req.userId}`;
  const ip = verifiedClientIp({ req, env });
  return `ip:${ip ? ipBucket(ip) : 'unknown'}`;
}
