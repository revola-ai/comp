import { publicBaseUrl } from '../utils/public-url';

/**
 * Where better-auth sends the user to authenticate during the hosted MCP OAuth flow:
 * MCP_OAUTH_LOGIN_PAGE, else the app's sign-in page. Never an upstream default, which
 * would send Revola users (and the OAuth request) to upstream Comp's sign-in page.
 * Without either variable it is the relative `/auth`, so the redirect stays on this API
 * and fails closed; the missing variable is warned about once per process.
 */
export function mcpLoginPage(): string {
  const configured = process.env.MCP_OAUTH_LOGIN_PAGE?.trim();
  if (configured) return configured;
  const appUrl = publicBaseUrl(['NEXT_PUBLIC_APP_URL']);
  return `${appUrl ?? ''}/auth`;
}
