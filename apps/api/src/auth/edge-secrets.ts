type Env = Partial<NodeJS.ProcessEnv>;

const ORIGIN_AUTH = 'COMP_ORIGIN_AUTH';
const ORIGIN_AUTH_SHAPE = /^[A-Za-z0-9]{64}$/;
const FORWARDED_IP_TOKEN = 'COMP_FORWARDED_IP_TOKEN';
const FORWARDED_IP_TOKEN_MIN_LENGTH = 32;

function bootError(detail: string): Error {
  return new Error(
    `${detail} when NODE_ENV=production and AUTH_COOKIE_DOMAIN is set (the self-hosted deployment behind Cloudflare). Without it the API silently trusts no proxy header and every client shares one rate-limit bucket.`,
  );
}

/**
 * Boot check for the self-hosted production deployment: the shared secrets
 * that let the API trust Cloudflare's client IP (COMP_ORIGIN_AUTH) and the
 * app's and portal's forwarded client IP (COMP_FORWARDED_IP_TOKEN) must be
 * present and well formed, or the API refuses to start. Messages name the
 * variable, never its value. Other deployments (no AUTH_COOKIE_DOMAIN, or not
 * production) are left alone.
 */
export function assertEdgeSecrets({ env }: { env: Env }): void {
  if (env.NODE_ENV !== 'production') return;
  if (!env.AUTH_COOKIE_DOMAIN?.trim()) return;

  if (!ORIGIN_AUTH_SHAPE.test(env[ORIGIN_AUTH] ?? '')) {
    throw bootError(
      `${ORIGIN_AUTH} must be set to exactly 64 characters from [A-Za-z0-9]`,
    );
  }
  const forwarded = env[FORWARDED_IP_TOKEN]?.trim() ?? '';
  if (forwarded.length < FORWARDED_IP_TOKEN_MIN_LENGTH) {
    throw bootError(
      `${FORWARDED_IP_TOKEN} must be set to at least ${FORWARDED_IP_TOKEN_MIN_LENGTH} characters`,
    );
  }
}
