import { createHmac } from 'node:crypto';

const UNSUBSCRIBE_SECRET = process.env.UNSUBSCRIBE_SECRET || process.env.AUTH_SECRET;

/**
 * Base URL for unsubscribe links. `/unsubscribe/preferences` is an app page,
 * so this is NEXT_PUBLIC_APP_URL. NEXT_PUBLIC_BETTER_AUTH_URL is not used:
 * when the API is self-hosted on its own host it points at the API, where the
 * page does not exist.
 */
function getBaseUrl(): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (appUrl) {
    return appUrl.replace(/\/+$/, '');
  }

  // Default fallback
  return 'https://app.trycomp.ai';
}

/**
 * Generate a secure unsubscribe token for an email address
 */
export function generateUnsubscribeToken(email: string): string {
  if (!UNSUBSCRIBE_SECRET) {
    throw new Error('UNSUBSCRIBE_SECRET or AUTH_SECRET environment variable must be set');
  }
  const hmac = createHmac('sha256', UNSUBSCRIBE_SECRET);
  hmac.update(email);
  return hmac.digest('base64url');
}

/**
 * Verify an unsubscribe token matches an email address
 */
export function verifyUnsubscribeToken(email: string, token: string): boolean {
  const expectedToken = generateUnsubscribeToken(email);
  return expectedToken === token;
}

/**
 * Generate an unsubscribe URL for an email address (preferences page)
 */
export function getUnsubscribeUrl(email: string): string {
  const token = generateUnsubscribeToken(email);
  const baseUrl = getBaseUrl();
  return `${baseUrl}/unsubscribe/preferences?email=${encodeURIComponent(email)}&token=${token}`;
}

