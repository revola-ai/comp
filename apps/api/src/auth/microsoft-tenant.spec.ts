function mockNativeModule(id: string): unknown {
  const loader: typeof import('../../test/native-module') = jest.requireActual(
    '../../test/native-module',
  );
  return loader.nativeModule(id);
}
jest.mock('better-auth/api', () => mockNativeModule('better-auth/api'));

import {
  accountLinkingTrustedProviders,
  assertMicrosoftTenant,
  microsoftTenantId,
} from './microsoft-tenant';

const microsoft = {
  AUTH_MICROSOFT_CLIENT_ID: 'client-id',
  AUTH_MICROSOFT_CLIENT_SECRET: 'client-secret',
  AUTH_ALLOWED_EMAIL_DOMAINS: 'revola.ai',
};
const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';

function messageOf(run: () => void): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

describe('microsoftTenantId', () => {
  it('is the configured tenant, else "common" (better-auth\'s multi-tenant default)', () => {
    expect(
      microsoftTenantId({ env: { AUTH_MICROSOFT_TENANT_ID: ` ${TENANT} ` } }),
    ).toBe(TENANT);
    expect(microsoftTenantId({ env: {} })).toBe('common');
    expect(microsoftTenantId({ env: { AUTH_MICROSOFT_TENANT_ID: ' ' } })).toBe(
      'common',
    );
  });
});

describe('assertMicrosoftTenant', () => {
  it.each([
    ['unset', undefined],
    ['blank', '  '],
    ['common', 'common'],
    ['Common', 'Common'],
    ['organizations', 'organizations'],
    ['consumers', 'consumers'],
  ])(
    'refuses a multi-tenant (%s) Microsoft sign-in with an email-domain allowlist',
    (_case, tenant) => {
      const message = messageOf(() =>
        assertMicrosoftTenant({
          env: { ...microsoft, AUTH_MICROSOFT_TENANT_ID: tenant },
        }),
      );
      expect(message).toContain('AUTH_MICROSOFT_TENANT_ID');
      expect(message).toContain('AUTH_ALLOWED_EMAIL_DOMAINS');
      expect(message).not.toContain('client-secret');
    },
  );

  it('accepts a single tenant', () => {
    expect(() =>
      assertMicrosoftTenant({
        env: { ...microsoft, AUTH_MICROSOFT_TENANT_ID: TENANT },
      }),
    ).not.toThrow();
    expect(() =>
      assertMicrosoftTenant({
        env: {
          ...microsoft,
          AUTH_MICROSOFT_TENANT_ID: 'revola.onmicrosoft.com',
        },
      }),
    ).not.toThrow();
  });

  // Not scoped to production like the edge checks (edge-secrets.ts): laptops
  // write users and accounts into the shared production database (D7).
  it('refuses outside production too', () => {
    expect(() =>
      assertMicrosoftTenant({
        env: { ...microsoft, NODE_ENV: 'development', SELF_HOSTED: 'true' },
      }),
    ).toThrow('AUTH_MICROSOFT_TENANT_ID');
  });

  it('leaves a deployment without the allowlist or without Microsoft alone', () => {
    expect(() =>
      assertMicrosoftTenant({
        env: { ...microsoft, AUTH_ALLOWED_EMAIL_DOMAINS: ' ' },
      }),
    ).not.toThrow();
    expect(() =>
      assertMicrosoftTenant({
        env: { AUTH_ALLOWED_EMAIL_DOMAINS: 'revola.ai' },
      }),
    ).not.toThrow();
  });
});

// A trusted provider links to an existing account by email without a
// verified-email claim. Microsoft is trusted only when bound to one tenant,
// whose own administrators control the addresses it reports.
describe('accountLinkingTrustedProviders', () => {
  it.each([
    ['a tenant ID', TENANT],
    ['a primary domain', ' revola.onmicrosoft.com '],
  ])('trusts Microsoft bound to one tenant (%s)', (_case, tenant) => {
    expect(
      accountLinkingTrustedProviders({
        env: { ...microsoft, AUTH_MICROSOFT_TENANT_ID: tenant },
      }),
    ).toEqual(['google', 'microsoft']);
  });

  it.each([
    ['unset', undefined],
    ['blank', '  '],
    ['common', 'common'],
    ['ORGANIZATIONS', 'ORGANIZATIONS'],
    ['consumers', 'consumers'],
  ])(
    'trusts only Google with a multi-tenant (%s) authority',
    (_case, tenant) => {
      expect(
        accountLinkingTrustedProviders({
          env: { ...microsoft, AUTH_MICROSOFT_TENANT_ID: tenant },
        }),
      ).toEqual(['google']);
    },
  );
});
