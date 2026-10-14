import { selfHostedTrustedOrigins } from './origin-policy';
import {
  parseTrustedEdgeProxyIps,
  TRUSTED_EDGE_PROXY_IPS,
} from '../throttle/verified-headers';
import {
  SERVICE_TOKEN_MIN_LENGTH,
  weakServiceTokenVariable,
} from './service-token-strength';

type Env = Partial<NodeJS.ProcessEnv>;

const ORIGIN_AUTH = 'COMP_ORIGIN_AUTH';
const ORIGIN_AUTH_SHAPE = /^[A-Za-z0-9]{64}$/;
const FORWARDED_IP_TOKEN = 'COMP_FORWARDED_IP_TOKEN';
const FORWARDED_IP_TOKEN_MIN_LENGTH = 32;
const UNTRUSTED_PROXY =
  'Without it the API silently trusts no proxy header and every client shares one rate-limit bucket.';
const GUESSABLE_TOKEN =
  'Service tokens are checked in memory and a valid one bypasses the per-IP attempt limit, so a short one can be guessed.';

function bootError({
  detail,
  consequence,
}: {
  detail: string;
  consequence: string;
}): Error {
  return new Error(
    `${detail} when NODE_ENV=production and AUTH_COOKIE_DOMAIN is set (the self-hosted deployment behind Cloudflare). ${consequence}`,
  );
}

/**
 * The API can trust Cloudflare's client IP: through the origin header
 * (COMP_ORIGIN_AUTH, Cloudflare in front of an ALB) or the socket peer
 * (TRUSTED_EDGE_PROXY_IPS, a Cloudflare Tunnel). At least one must be
 * configured, and each one that is configured must be well formed.
 */
function assertCloudflareTrust({ env }: { env: Env }): void {
  // Whitespace-only counts as unset, like a blank TRUSTED_EDGE_PROXY_IPS.
  const rawOrigin = env[ORIGIN_AUTH] ?? '';
  const origin = rawOrigin.trim() ? rawOrigin : '';
  const peers = parseTrustedEdgeProxyIps({
    value: env[TRUSTED_EDGE_PROXY_IPS],
  });
  if (
    !origin &&
    peers.addresses.length === 0 &&
    peers.invalidEntryCount === 0
  ) {
    throw bootError({
      detail: `${ORIGIN_AUTH} (exactly 64 characters from [A-Za-z0-9], for Cloudflare in front of a load balancer) or ${TRUSTED_EDGE_PROXY_IPS} (the comma-separated IP addresses of the Cloudflare Tunnel connector) must be set`,
      consequence: UNTRUSTED_PROXY,
    });
  }
  if (origin && !ORIGIN_AUTH_SHAPE.test(origin)) {
    throw bootError({
      detail: `${ORIGIN_AUTH} must be set to exactly 64 characters from [A-Za-z0-9]`,
      consequence: UNTRUSTED_PROXY,
    });
  }
  if (peers.invalidEntryCount > 0) {
    throw bootError({
      detail: `${TRUSTED_EDGE_PROXY_IPS} must be a comma-separated list of IP addresses, with no empty entry`,
      consequence: UNTRUSTED_PROXY,
    });
  }
}

/**
 * A production SELF_HOSTED=true API must trust some browser origin, and the
 * deployment that shares its session cookie through AUTH_COOKIE_DOMAIN must
 * be SELF_HOSTED=true: otherwise the origin policy also trusts Comp AI's own
 * domains (its hosted subdomains and published trust-portal custom domains).
 */
function assertSelfHostedOrigins({ env }: { env: Env }): void {
  const selfHosted = env.SELF_HOSTED === 'true';
  if (env.AUTH_COOKIE_DOMAIN?.trim() && !selfHosted) {
    throw bootError({
      detail: 'SELF_HOSTED must be set to "true"',
      consequence:
        "Without it the API also trusts Comp AI's own hosted origins and trust-portal custom domains for CORS and sign-in redirects.",
    });
  }
  if (!selfHosted) return;
  if (selfHostedTrustedOrigins({ env }).length > 0) return;
  throw new Error(
    'AUTH_TRUSTED_ORIGINS or AUTH_COOKIE_DOMAIN must be set when NODE_ENV=production and SELF_HOSTED=true. Without either the API trusts no browser origin and refuses every sign-in.',
  );
}

/**
 * Boot check for the self-hosted production deployment: SELF_HOSTED=true with
 * at least one trusted origin (assertSelfHostedOrigins), and the settings that
 * let the API trust Cloudflare's client IP (COMP_ORIGIN_AUTH or
 * TRUSTED_EDGE_PROXY_IPS) and the app's and portal's forwarded client IP
 * (COMP_FORWARDED_IP_TOKEN) must be present and well formed, and every
 * configured service token (SERVICE_TOKEN_<NAME> and its _PREVIOUS) must be
 * at least 32 characters, or the API refuses to start. Messages name the
 * variable, never its value. Other deployments (no AUTH_COOKIE_DOMAIN and no
 * SELF_HOSTED, or not production) are left alone.
 */
export function assertEdgeSecrets({ env }: { env: Env }): void {
  if (env.NODE_ENV !== 'production') return;
  assertSelfHostedOrigins({ env });
  if (!env.AUTH_COOKIE_DOMAIN?.trim()) return;

  assertCloudflareTrust({ env });
  const forwarded = env[FORWARDED_IP_TOKEN]?.trim() ?? '';
  if (forwarded.length < FORWARDED_IP_TOKEN_MIN_LENGTH) {
    throw bootError({
      detail: `${FORWARDED_IP_TOKEN} must be set to at least ${FORWARDED_IP_TOKEN_MIN_LENGTH} characters`,
      consequence: UNTRUSTED_PROXY,
    });
  }
  const weak = weakServiceTokenVariable({ env });
  if (weak) {
    throw bootError({
      detail: `${weak} must be at least ${SERVICE_TOKEN_MIN_LENGTH} characters`,
      consequence: GUESSABLE_TOKEN,
    });
  }
}
