import { ForbiddenException } from '@nestjs/common';
import { assertScopesGrantable } from './api-key-scope-grant';

// A key creating a key may only hand out scopes it holds itself; otherwise a
// key with nothing but apiKey:create could mint a full-access key.
describe('assertScopesGrantable', () => {
  const AVAILABLE = [
    'apiKey:create',
    'risk:read',
    'risk:update',
    'vendor:read',
  ];

  it('lets an API key grant a subset of its own scopes', () => {
    expect(() =>
      assertScopesGrantable({
        caller: {
          authType: 'api-key',
          apiKeyScopes: ['apiKey:create', 'risk:read'],
        },
        requestedScopes: ['risk:read'],
        availableScopes: AVAILABLE,
      }),
    ).not.toThrow();
  });

  it('refuses an API key that requests a scope it does not hold, naming it', () => {
    const grant = () =>
      assertScopesGrantable({
        caller: { authType: 'api-key', apiKeyScopes: ['apiKey:create'] },
        requestedScopes: ['apiKey:create', 'risk:update'],
        availableScopes: AVAILABLE,
      });
    expect(grant).toThrow(ForbiddenException);
    expect(grant).toThrow(/risk:update/);
  });

  it('lets a full-access API key grant any scope', () => {
    expect(() =>
      assertScopesGrantable({
        caller: { authType: 'api-key', apiKeyScopes: [...AVAILABLE] },
        requestedScopes: ['vendor:read', 'risk:update'],
        availableScopes: AVAILABLE,
      }),
    ).not.toThrow();
  });

  it('treats a key with no recorded scopes as holding none (fail closed)', () => {
    for (const apiKeyScopes of [[], undefined]) {
      expect(() =>
        assertScopesGrantable({
          caller: { authType: 'api-key', apiKeyScopes },
          requestedScopes: ['risk:read'],
          availableScopes: AVAILABLE,
        }),
      ).toThrow(ForbiddenException);
    }
  });

  it('leaves session and service callers to RBAC', () => {
    for (const authType of ['session', 'service'] as const) {
      expect(() =>
        assertScopesGrantable({
          caller: { authType },
          requestedScopes: AVAILABLE,
          availableScopes: AVAILABLE,
        }),
      ).not.toThrow();
    }
  });
});
