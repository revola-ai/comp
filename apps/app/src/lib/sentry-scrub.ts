import type { Event } from '@sentry/nextjs';

/**
 * Header names that carry deployment secrets and must never reach Sentry:
 * the Cloudflare-to-ALB origin header and the internal API token the app
 * sends to the API. Matched case-insensitively, with `-` or `_` separators
 * (span attributes spell them `http.request.header.x_comp_origin_auth`).
 */
const SENSITIVE_HEADER = /x[-_]comp[-_]origin[-_]auth|x[-_]internal[-_]token/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function scrubValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubValue);
  if (!isPlainObject(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_HEADER.test(key)) continue;
    result[key] = scrubValue(entry);
  }
  return result;
}

/**
 * `beforeSend` / `beforeSendTransaction` hook: drops every key naming a
 * sensitive header anywhere in the event (request headers, breadcrumbs,
 * contexts, span data, extra).
 */
export function scrubSensitiveHeaders<T extends Event>(event: T): T {
  return scrubValue(event) as T;
}
