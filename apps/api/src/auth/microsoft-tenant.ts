import { parseAllowedDomains } from './email-domain-allowlist';

type Env = Partial<NodeJS.ProcessEnv>;

// Entra's multi-tenant authority aliases: they accept accounts of any tenant
// (or any personal Microsoft account).
const MULTI_TENANT = new Set(['common', 'organizations', 'consumers']);

/** AUTH_MICROSOFT_TENANT_ID, else "common" (better-auth's own default). */
export function microsoftTenantId({ env }: { env: Env }): string {
  return env.AUTH_MICROSOFT_TENANT_ID?.trim() || 'common';
}

/** Whether Microsoft sign-in is bound to one Entra tenant (not an alias). */
function isSingleTenant({ env }: { env: Env }): boolean {
  return !MULTI_TENANT.has(microsoftTenantId({ env }).toLowerCase());
}

/**
 * better-auth's accountLinking.trustedProviders: providers that link to an
 * existing account by email without a verified-email claim. Google vouches
 * for its addresses. Microsoft may report a username claim as the email
 * (microsoft-email.ts), which only that tenant's administrators control, so
 * it is trusted only when AUTH_MICROSOFT_TENANT_ID names one tenant (yours);
 * with a multi-tenant authority any tenant could claim an existing address.
 * GitHub links anyway whenever it reports the address verified, so trusting
 * it would only add the unverified case.
 */
export function accountLinkingTrustedProviders({
  env,
}: {
  env: Env;
}): string[] {
  return isSingleTenant({ env }) ? ['google', 'microsoft'] : ['google'];
}

/**
 * Boot check: with AUTH_ALLOWED_EMAIL_DOMAINS set, Microsoft sign-in
 * (AUTH_MICROSOFT_CLIENT_ID) must be bound to one Entra tenant. A
 * multi-tenant authority lets any tenant sign in, and the address comes from
 * the username claims when the email claim is absent (microsoft-email.ts),
 * which another tenant's administrator controls, so the allowlist cannot
 * rely on it. The message names the variables, never their values. Unlike
 * the edge checks (edge-secrets.ts, production only: they guard Cloudflare in
 * front of the deployment) it runs in every environment: it guards who can
 * create and link accounts, and laptops write those into the shared
 * production database (D7).
 */
export function assertMicrosoftTenant({ env }: { env: Env }): void {
  if (!env.AUTH_MICROSOFT_CLIENT_ID?.trim()) return;
  if (parseAllowedDomains({ env }).length === 0) return;
  if (isSingleTenant({ env })) return;
  throw new Error(
    'AUTH_MICROSOFT_TENANT_ID must name your Microsoft Entra tenant (its ID or primary domain) when AUTH_MICROSOFT_CLIENT_ID and AUTH_ALLOWED_EMAIL_DOMAINS are set. Unset, "common", "organizations" or "consumers" let any Microsoft tenant sign in with addresses the allowlist cannot verify.',
  );
}
