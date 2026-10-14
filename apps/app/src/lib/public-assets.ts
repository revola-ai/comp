/**
 * Files in apps/app/public that must be reachable without a user session and without
 * Cloudflare Access, which protects the whole app host. Email clients and their image
 * proxies load these (the email logo), so the infra branch adds an Access Bypass for
 * each path. `public-assets.test.ts` checks that every path exists and that the session
 * proxy's matcher skips it.
 */
export const APP_PUBLIC_ASSETS = ['/email/logo.png'] as const;

export type AppPublicAsset = (typeof APP_PUBLIC_ASSETS)[number];
