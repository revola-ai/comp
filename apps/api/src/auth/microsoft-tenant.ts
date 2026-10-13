import { parseAllowedDomains } from './email-domain-allowlist';

type Env = Partial<NodeJS.ProcessEnv>;

// Entra's multi-tenant authority aliases: they accept accounts of any tenant
// (or any personal Microsoft account).
const MULTI_TENANT = new Set(['common', 'organizations', 'consumers']);

/** AUTH_MICROSOFT_TENANT_ID, else "common" (better-auth's own default). */
export function microsoftTenantId({ env }: { env: Env }): string {
  return env.AUTH_MICROSOFT_TENANT_ID?.trim() || 'common';
}

/**
 * Boot check: with AUTH_ALLOWED_EMAIL_DOMAINS set, Microsoft sign-in
 * (AUTH_MICROSOFT_CLIENT_ID) must be bound to one Entra tenant. A
 * multi-tenant authority lets any tenant sign in, and the address comes from
 * the username claims when the email claim is absent (microsoft-email.ts),
 * which another tenant's administrator controls, so the allowlist cannot
 * rely on it. The message names the variables, never their values.
 */
export function assertMicrosoftTenant({ env }: { env: Env }): void {
  if (!env.AUTH_MICROSOFT_CLIENT_ID?.trim()) return;
  if (parseAllowedDomains({ env }).length === 0) return;
  const tenant = microsoftTenantId({ env }).toLowerCase();
  if (!MULTI_TENANT.has(tenant)) return;
  throw new Error(
    'AUTH_MICROSOFT_TENANT_ID must name your Microsoft Entra tenant (its ID or primary domain) when AUTH_MICROSOFT_CLIENT_ID and AUTH_ALLOWED_EMAIL_DOMAINS are set. Unset, "common", "organizations" or "consumers" let any Microsoft tenant sign in with addresses the allowlist cannot verify.',
  );
}
