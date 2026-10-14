import { ForbiddenException } from '@nestjs/common';
import type { AuthenticatedRequest } from './types';

/** Keys with no recorded scopes (legacy full access) stopped working then. */
const LEGACY_KEY_CUTOFF = new Date('2026-04-20T00:00:00Z');

type ScopedRequest = Pick<
  AuthenticatedRequest,
  'apiKeyScopes' | 'apiKeyGrantedScopes' | 'method' | 'url'
>;

/**
 * Refuses (403) an API-key request that needs a scope it may not use:
 *   - a key with no recorded scopes is a legacy key, refused since the
 *     cutoff (allowed before it, with a warning);
 *   - a scope the key was never given: "API key lacks required permission
 *     scope";
 *   - a scope the key was given but its creator no longer holds (a personal
 *     key's usable scopes, `apiKeyScopes`, are its recorded scopes,
 *     `apiKeyGrantedScopes`, cut to the creator's current permissions): the
 *     message names the scopes, and the key stays valid for the rest.
 */
export function assertApiKeyScopes({
  request,
  requiredScopes,
  warn,
}: {
  request: ScopedRequest;
  requiredScopes: string[];
  warn: (message: string) => void;
}): void {
  const usable = request.apiKeyScopes ?? [];
  const granted = request.apiKeyGrantedScopes ?? usable;
  if (granted.length === 0) {
    if (new Date() >= LEGACY_KEY_CUTOFF) {
      warn(
        `Legacy API key with empty scopes BLOCKED after deprecation date on ${request.method} ${request.url}.`,
      );
      throw new ForbiddenException(
        'This API key is no longer supported. Please regenerate your API key with explicit scopes.',
      );
    }
    warn(
      `Legacy API key with empty scopes used on ${request.method} ${request.url}. This key will stop working after April 20, 2026.`,
    );
    return;
  }
  if (requiredScopes.some((scope) => !granted.includes(scope))) {
    throw new ForbiddenException('API key lacks required permission scope');
  }
  const lostByCreator = requiredScopes.filter(
    (scope) => !usable.includes(scope),
  );
  if (lostByCreator.length > 0) {
    throw new ForbiddenException(
      `This API key's creator no longer holds ${lostByCreator.join(', ')}, so the key cannot use it. The key keeps the scopes its creator still holds.`,
    );
  }
}
