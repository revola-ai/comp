import { getUnsubscribeToken } from '@trycompai/email';

/**
 * RFC 8058 one-click unsubscribe headers (what Gmail and Yahoo require of bulk senders)
 * for one recipient, or undefined when no unsubscribe secret is configured: the email
 * is then sent without them, and the email package warns once per process.
 */
export function listUnsubscribeHeaders(
  email: string,
): Record<string, string> | undefined {
  const token = getUnsubscribeToken(email);
  if (token === undefined) return undefined;
  const apiBaseUrl =
    process.env.NEXT_PUBLIC_API_URL || 'https://api.trycomp.ai';
  const oneClickUrl = `${apiBaseUrl}/v1/email/unsubscribe?email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`;
  return {
    'List-Unsubscribe': `<${oneClickUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
