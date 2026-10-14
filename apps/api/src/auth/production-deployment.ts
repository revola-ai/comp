type Env = Partial<NodeJS.ProcessEnv>;

/**
 * Whether this process is the deployed production API: the self-hosted
 * deployment behind Cloudflare, as edge-secrets.ts names it (NODE_ENV=
 * production with AUTH_COOKIE_DOMAIN set), and SELF_HOSTED=true, which that
 * boot check requires of it. Laptops share the production database (D7), so
 * the database URL cannot tell them apart; the deployment's own settings can.
 * NODE_ENV=production alone also matches the production image run locally
 * (deploy/aws/tests), and SELF_HOSTED=true alone matches every laptop.
 * AUTH_COOKIE_DOMAIN must cover the hosts of BASE_URL and the app and portal
 * URLs (cookie-domain.ts) and, in production, brings the Cloudflare edge
 * secrets with it, so only the deployment sets it.
 */
export function isProductionDeployment({ env }: { env: Env }): boolean {
  return (
    env.NODE_ENV === 'production' &&
    env.SELF_HOSTED === 'true' &&
    Boolean(env.AUTH_COOKIE_DOMAIN?.trim())
  );
}
