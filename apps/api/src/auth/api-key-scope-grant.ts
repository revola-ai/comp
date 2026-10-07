import { ForbiddenException } from '@nestjs/common';
import type { AuthContext } from './types';

/**
 * A key created through an API key may only carry scopes that key holds, so a
 * key limited to `apiKey:create` cannot mint a broader one. A key holding every
 * available scope may grant any. A key with no recorded scopes holds none
 * (empty-scope legacy keys are blocked by PermissionGuard anyway). Session and
 * service callers are governed by RBAC (`apiKey:create`) as before.
 */
export function assertScopesGrantable({
  caller,
  requestedScopes,
  availableScopes,
}: {
  caller: Pick<AuthContext, 'authType' | 'apiKeyScopes'>;
  requestedScopes: string[];
  availableScopes: string[];
}): void {
  if (caller.authType !== 'api-key') return;
  const held = new Set(caller.apiKeyScopes ?? []);
  const fullAccess =
    held.size > 0 && availableScopes.every((scope) => held.has(scope));
  if (fullAccess) return;
  const missing = requestedScopes.filter((scope) => !held.has(scope));
  if (missing.length === 0) return;
  throw new ForbiddenException(
    `This API key cannot grant scopes it does not hold: ${missing.join(', ')}`,
  );
}
