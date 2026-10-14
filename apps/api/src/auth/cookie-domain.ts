type Env = Partial<NodeJS.ProcessEnv>;

const VARIABLE = 'AUTH_COOKIE_DOMAIN';
const EXAMPLE = `${VARIABLE}=.comp.revola.ai`;
const ALLOW_BROAD_VARIABLE = 'AUTH_COOKIE_DOMAIN_ALLOW_BROAD';
const MIN_LABELS = 3;

// One or more DNS labels after a leading dot, e.g. ".comp.revola.ai".
const DOMAIN_SHAPE =
  /^\.(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

// The session cookie must reach every service that reads it.
const SERVICE_URL_VARIABLES = [
  'BASE_URL',
  'NEXT_PUBLIC_APP_URL',
  'NEXT_PUBLIC_PORTAL_URL',
] as const;

interface ServiceUrl {
  variable: (typeof SERVICE_URL_VARIABLES)[number];
  url: URL;
}

function configError(detail: string): Error {
  return new Error(
    `${VARIABLE} ${detail}. Example: ${EXAMPLE} (it must start with a dot and cover the api, app and portal hosts).`,
  );
}

function isHostCovered({
  host,
  domain,
}: {
  host: string;
  domain: string;
}): boolean {
  return host === domain.slice(1) || host.endsWith(domain);
}

function readServiceUrls({ env }: { env: Env }): ServiceUrl[] {
  return SERVICE_URL_VARIABLES.map((variable) => {
    const value = env[variable]?.trim();
    if (!value) {
      throw configError(
        `is set but ${variable} is missing; set ${variable} so the cookie domain can be checked against its host`,
      );
    }
    try {
      return { variable, url: new URL(value) };
    } catch {
      throw configError(
        `is set but ${variable} ("${value}") is not a valid URL`,
      );
    }
  });
}

function parseConfiguredDomain({
  raw,
  env,
}: {
  raw: string;
  env: Env;
}): string {
  const domain = raw.toLowerCase();
  if (!domain.startsWith('.')) {
    throw configError(`must start with a dot (got "${raw}")`);
  }
  if (!DOMAIN_SHAPE.test(domain)) {
    throw configError(`is not a valid domain (got "${raw}")`);
  }
  const labels = domain.slice(1).split('.').length;
  if (labels < MIN_LABELS && env[ALLOW_BROAD_VARIABLE] !== '1') {
    throw configError(
      `"${raw}" is too broad: it has fewer than ${MIN_LABELS} labels and would send the session cookie to every sibling host; use the narrowest parent of the api, app and portal hosts, or set ${ALLOW_BROAD_VARIABLE}=1 to allow it`,
    );
  }
  for (const { variable, url } of readServiceUrls({ env })) {
    if (!isHostCovered({ host: url.hostname, domain })) {
      throw configError(
        `"${raw}" does not cover the ${variable} host "${url.hostname}"`,
      );
    }
  }
  return domain;
}

/** Built-in rules used when AUTH_COOKIE_DOMAIN is unset (Comp AI cloud). */
function getBuiltInCookieDomain({ env }: { env: Env }): string | undefined {
  // A self-hosted install never shares cookies with Comp AI's domains.
  if (env.SELF_HOSTED === 'true') return undefined;
  const baseUrl = env.BASE_URL || '';
  if (baseUrl.includes('staging.trycomp.ai')) return '.staging.trycomp.ai';
  if (baseUrl.includes('trycomp.ai')) return '.trycomp.ai';
  return undefined;
}

/**
 * The domain for better-auth's cross-subdomain session cookie.
 *
 * `AUTH_COOKIE_DOMAIN` wins when set and is validated strictly: a wrong value
 * would silently drop sessions, so it throws at boot with a message naming the
 * variable and an example. Unset keeps the built-in trycomp.ai rules (none when
 * `SELF_HOSTED=true`), and `undefined` means host-only cookies.
 */
export function getCookieDomain({ env }: { env: Env }): string | undefined {
  const raw = env[VARIABLE]?.trim();
  if (!raw) return getBuiltInCookieDomain({ env });
  return parseConfiguredDomain({ raw, env });
}

const NO_ORIGINS: readonly string[] = Object.freeze([]);

// Every variable the origins depend on; the cache key for the last result.
const ORIGIN_INPUTS = [
  VARIABLE,
  ALLOW_BROAD_VARIABLE,
  ...SERVICE_URL_VARIABLES,
] as const;

let cachedOrigins: { key: string; origins: readonly string[] } | undefined;

/**
 * Origins of the api, app and portal services that share the configured
 * `AUTH_COOKIE_DOMAIN` session cookie. Empty when the variable is unset.
 * Origin checks run on every request, so a configuration is validated once
 * and its (frozen) result reused until one of its inputs changes.
 */
export function getCookieDomainOrigins({
  env,
}: {
  env: Env;
}): readonly string[] {
  const raw = env[VARIABLE]?.trim();
  if (!raw) return NO_ORIGINS;
  const key = JSON.stringify(ORIGIN_INPUTS.map((name) => env[name] ?? null));
  if (cachedOrigins?.key === key) return cachedOrigins.origins;
  parseConfiguredDomain({ raw, env });
  const origins = Object.freeze(
    readServiceUrls({ env }).map(({ url }) => url.origin),
  );
  cachedOrigins = { key, origins };
  return origins;
}
