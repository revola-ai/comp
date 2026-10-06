import { createHmac, timingSafeEqual } from 'node:crypto';

/** Neither UNSUBSCRIBE_SECRET nor AUTH_SECRET is set, so no token can be signed or checked. */
export class UnsubscribeSecretMissingError extends Error {
  constructor() {
    super(
      'UNSUBSCRIBE_SECRET (or AUTH_SECRET) must be set to generate or verify unsubscribe tokens',
    );
    this.name = 'UnsubscribeSecretMissingError';
  }
}

/**
 * The signing secret, read on every use: UNSUBSCRIBE_SECRET, else AUTH_SECRET (what
 * apps/app verifies with). There is no built-in fallback: a public default would let
 * anyone forge a token for any address.
 */
function unsubscribeSecret(): string {
  const secret = process.env.UNSUBSCRIBE_SECRET?.trim() || process.env.AUTH_SECRET?.trim();
  if (!secret) throw new UnsubscribeSecretMissingError();
  return secret;
}

/**
 * Base URL for unsubscribe links. `/unsubscribe/preferences` is an app page, so this is
 * NEXT_PUBLIC_APP_URL; NEXT_PUBLIC_BETTER_AUTH_URL points at the API when it is
 * self-hosted on its own host, where the page does not exist.
 */
function getBaseUrl(): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (appUrl) return appUrl.replace(/\/+$/, '');
  return 'https://app.trycomp.ai';
}

/**
 * Generate a secure unsubscribe token for an email address
 */
export function generateUnsubscribeToken(email: string): string {
  const hmac = createHmac('sha256', unsubscribeSecret());
  hmac.update(email);
  return hmac.digest('base64url');
}

/** Timing-safe check of a token against the one this secret signs for the address. */
export function verifyUnsubscribeToken({
  email,
  token,
}: {
  email: string;
  token: string;
}): boolean {
  const expected = Buffer.from(generateUnsubscribeToken(email));
  const presented = Buffer.from(token);
  return expected.length === presented.length && timingSafeEqual(expected, presented);
}

/**
 * Generate an unsubscribe URL for an email address (preferences page)
 */
export function getUnsubscribeUrl(email: string): string {
  const token = generateUnsubscribeToken(email);
  const baseUrl = getBaseUrl();
  return `${baseUrl}/unsubscribe/preferences?email=${encodeURIComponent(email)}&token=${token}`;
}
