import { getUnsubscribeToken, publicBaseUrl } from '@trycompai/email';

/**
 * RFC 8058 one-click unsubscribe headers (what Gmail and Yahoo require of bulk senders)
 * for one recipient, or undefined when no unsubscribe secret or no NEXT_PUBLIC_API_URL
 * is configured: the email is then sent without them, and the email package warns once
 * per process. There is no upstream default host, which would hand every recipient's
 * address and signed token to upstream Comp's API.
 */
export function listUnsubscribeHeaders(
  email: string,
): Record<string, string> | undefined {
  const token = getUnsubscribeToken(email);
  if (token === undefined) return undefined;
  const apiBaseUrl = publicBaseUrl(['NEXT_PUBLIC_API_URL']);
  if (apiBaseUrl === undefined) return undefined;
  const oneClickUrl = `${apiBaseUrl}/v1/email/unsubscribe?email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`;
  return {
    'List-Unsubscribe': `<${oneClickUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
