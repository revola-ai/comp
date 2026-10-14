import { createHmac, timingSafeEqual } from 'node:crypto';

// Mirrors packages/email/lib/unsubscribe.ts (the API signs, this app verifies): the same
// secret, the same token and the same rule for a missing secret.

/** Neither UNSUBSCRIBE_SECRET nor AUTH_SECRET is set, so no token can be checked. */
export class UnsubscribeSecretMissingError extends Error {
  constructor() {
    super(
      'UNSUBSCRIBE_SECRET (or AUTH_SECRET) must be set to generate or verify unsubscribe tokens',
    );
    this.name = 'UnsubscribeSecretMissingError';
  }
}

/** Read on every use; there is no built-in fallback, which would let anyone forge a token. */
function configuredSecret(): string | undefined {
  return process.env.UNSUBSCRIBE_SECRET?.trim() || process.env.AUTH_SECRET?.trim() || undefined;
}

/** Whether a signing secret is set, so unsubscribe links can be built and checked. */
export function isUnsubscribeConfigured(): boolean {
  return configuredSecret() !== undefined;
}

let warnedUnsubscribeDisabled = false;

function warnUnsubscribeDisabledOnce(): void {
  if (warnedUnsubscribeDisabled) return;
  warnedUnsubscribeDisabled = true;
  console.warn(
    '[unsubscribe] UNSUBSCRIBE_SECRET (or AUTH_SECRET) is not set: unsubscribe links are left out and the preferences page is unavailable. Copy the shared UNSUBSCRIBE_SECRET into the env file to enable them.',
  );
}

function signToken(email: string): string {
  const secret = configuredSecret();
  if (!secret) throw new UnsubscribeSecretMissingError();
  return createHmac('sha256', secret).update(email).digest('base64url');
}

let warnedAppUrlMissing = false;

/**
 * Base URL for unsubscribe links, or undefined (one warning per process, no value) when
 * NEXT_PUBLIC_APP_URL is unset. `/unsubscribe/preferences` is an app page, so this is
 * NEXT_PUBLIC_APP_URL. NEXT_PUBLIC_BETTER_AUTH_URL is not used: when the API is
 * self-hosted on its own host it points at the API, where the page does not exist. There
 * is no upstream default host, which would send the address and its signed token there.
 */
function getBaseUrl(): string | undefined {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, '');
  if (appUrl) return appUrl;
  if (!warnedAppUrlMissing) {
    warnedAppUrlMissing = true;
    console.warn(
      '[unsubscribe] NEXT_PUBLIC_APP_URL is not set: unsubscribe links are left out. Set it to the public app URL of this deployment.',
    );
  }
  return undefined;
}

/**
 * Timing-safe check of a token for an address. Throws UnsubscribeSecretMissingError when
 * no secret is configured; callers check isUnsubscribeConfigured() first.
 */
export function verifyUnsubscribeToken({
  email,
  token,
}: {
  email: string;
  token: string;
}): boolean {
  const expected = Buffer.from(signToken(email));
  const presented = Buffer.from(token);
  return expected.length === presented.length && timingSafeEqual(expected, presented);
}

/**
 * The preferences page URL for an address, or undefined (with one warning per process)
 * when no secret or no NEXT_PUBLIC_APP_URL is configured, in which case the page shows
 * no link.
 */
export function getUnsubscribeUrl(email: string): string | undefined {
  if (!isUnsubscribeConfigured()) {
    warnUnsubscribeDisabledOnce();
    return undefined;
  }
  const baseUrl = getBaseUrl();
  if (baseUrl === undefined) return undefined;
  const token = signToken(email);
  return `${baseUrl}/unsubscribe/preferences?email=${encodeURIComponent(email)}&token=${token}`;
}
