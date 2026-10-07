import {
  PREVIOUS_TOKEN_SUFFIX,
  SERVICE_DEFINITIONS,
} from './service-token.config';

type Env = Partial<NodeJS.ProcessEnv>;

/** Shortest service token the self-hosted production deployment accepts. */
export const SERVICE_TOKEN_MIN_LENGTH = 32;

/**
 * The first configured service-token variable (`SERVICE_TOKEN_<NAME>` or its
 * `_PREVIOUS`) shorter than SERVICE_TOKEN_MIN_LENGTH, ignoring surrounding
 * whitespace, or undefined when every configured token is long enough. An
 * unset or empty variable is not configured: the guard never matches it.
 */
export function weakServiceTokenVariable({
  env,
}: {
  env: Env;
}): string | undefined {
  const names = Object.values(SERVICE_DEFINITIONS).flatMap(({ envVar }) => [
    envVar,
    envVar + PREVIOUS_TOKEN_SUFFIX,
  ]);
  return names.find((name) => {
    const value = env[name];
    if (value === undefined || value === '') return false;
    return value.trim().length < SERVICE_TOKEN_MIN_LENGTH;
  });
}
