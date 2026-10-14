import { getSafeRedirectPath } from './auth-callback';

/** Error code the API's sign-up allowlist puts in the rejection (Task 1). */
export const EMAIL_DOMAIN_NOT_ALLOWED_CODE = 'email_domain_not_allowed';

export const EMAIL_DOMAIN_NOT_ALLOWED_MESSAGE =
  'Sign-ups are limited to revola.ai; ask an admin for an invite';

const GENERIC_SIGN_IN_ERROR = 'Sign-in failed. Please try again.';

/**
 * Turns the `error` (and `error_description`) query parameters that
 * better-auth appends to `errorCallbackURL` into the message shown on the
 * sign-in page. Through the OAuth callback, better-auth passes the hook's
 * APIError message with spaces replaced by underscores, so the allowlist code
 * is matched anywhere in either parameter, case-insensitively.
 */
export function getSignInErrorMessage({
  error,
  errorDescription,
}: {
  error?: string | null;
  errorDescription?: string | null;
}): string | undefined {
  if (!error) return undefined;
  const haystack = `${error} ${errorDescription ?? ''}`.toLowerCase();
  if (haystack.includes(EMAIL_DOMAIN_NOT_ALLOWED_CODE)) {
    return EMAIL_DOMAIN_NOT_ALLOWED_MESSAGE;
  }
  return GENERIC_SIGN_IN_ERROR;
}

const MAGIC_LINK_SEND_ERROR = 'Error sending email - try again?';

/**
 * Message for a failed magic-link send. The API rejects a new email outside
 * the sign-up allowlist at send time with the `email_domain_not_allowed`
 * code, which may arrive as the error code (any case) or inside the message.
 */
export function getMagicLinkSendErrorMessage({
  error,
}: {
  error: { code?: string | null; message?: string | null };
}): string {
  const message = getSignInErrorMessage({
    error: error.code || error.message,
    errorDescription: error.message,
  });
  return message === EMAIL_DOMAIN_NOT_ALLOWED_MESSAGE ? message : MAGIC_LINK_SEND_ERROR;
}

/**
 * Absolute URL of the app's sign-in page for better-auth's `errorCallbackURL`.
 * Without it, OAuth and magic-link errors land on the API host's generic
 * error page instead of the app.
 */
export function buildAuthErrorCallbackUrl({
  inviteCode,
  redirectTo,
}: {
  inviteCode?: string;
  redirectTo?: string;
}): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const params = new URLSearchParams();
  if (inviteCode) params.set('inviteCode', inviteCode);
  const safeRedirect = getSafeRedirectPath(redirectTo);
  if (safeRedirect) params.set('redirectTo', safeRedirect);
  const query = params.toString();
  return `${origin}/auth${query ? `?${query}` : ''}`;
}
