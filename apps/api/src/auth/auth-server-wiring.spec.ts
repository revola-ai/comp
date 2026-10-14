// AUTH_ALLOWED_EMAIL_DOMAINS is enforced only if auth.server.ts hands the
// allowlist to better-auth: the create hook (every sign-up path) and the
// magic-link sender wrapper (nothing is mailed to a disallowed new address).
// Account linking and the Microsoft tenant boot check guard the same rule.
// This loads the real auth.server.ts on the real better-auth (through Node's
// require, see test/native-module.ts); only the database, the mailer and the
// Redis cache are faked.
function mockNativeModule(id: string): unknown {
  const loader: typeof import('../../test/native-module') = jest.requireActual(
    '../../test/native-module',
  );
  return loader.nativeModule(id);
}
jest.mock('better-auth', () => mockNativeModule('better-auth'));
jest.mock('better-auth/api', () => mockNativeModule('better-auth/api'));
jest.mock('better-auth/plugins', () => mockNativeModule('better-auth/plugins'));
jest.mock('better-auth/adapters/prisma', () =>
  mockNativeModule('better-auth/adapters/prisma'),
);
jest.mock('better-auth/plugins/access', () =>
  mockNativeModule('better-auth/plugins/access'),
);
jest.mock('better-auth/plugins/organization/access', () =>
  mockNativeModule('better-auth/plugins/organization/access'),
);
jest.mock('../config/load-env', () => ({}));
jest.mock('@upstash/redis', () => ({ Redis: class {} }));
jest.mock('@trycompai/email', () => ({
  ChangeEmailConfirmationEmail: () => null,
  MagicLinkEmail: () => null,
  OTPVerificationEmail: () => null,
  VerifyEmail: () => null,
}));
jest.mock('../email/templates/invite-member', () => ({
  InviteEmail: () => null,
}));
const mockTriggerEmail = jest.fn();
jest.mock('../email/trigger-email', () => ({
  triggerEmail: (...args: unknown[]) => mockTriggerEmail(...args),
}));
const mockUserFindFirst = jest.fn();
const mockInvitationFindFirst = jest.fn();
jest.mock('@db', () => {
  const { mockFakeDb } = jest.requireActual<
    typeof import('../../test/fake-auth-db')
  >('../../test/fake-auth-db');
  return {
    db: mockFakeDb({
      user: { findFirst: (...args: unknown[]) => mockUserFindFirst(...args) },
      invitation: {
        findFirst: (...args: unknown[]) => mockInvitationFindFirst(...args),
      },
    }),
  };
});

const savedEnv = { ...process.env };
Object.assign(process.env, {
  SECRET_KEY: 'wiring-spec-secret-key-0123456789',
  AUTH_ALLOWED_EMAIL_DOMAINS: 'revola.ai',
  NODE_ENV: 'test',
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
});
for (const name of [
  'AUTH_COOKIE_DOMAIN',
  'AUTH_MICROSOFT_CLIENT_ID',
  'AUTH_MICROSOFT_CLIENT_SECRET',
  'AUTH_MICROSOFT_TENANT_ID',
]) {
  delete process.env[name];
}

import { EMAIL_DOMAIN_NOT_ALLOWED } from './email-domain-allowlist';
import { auth } from './auth.server';

afterAll(() => {
  process.env = savedEnv;
});

beforeEach(() => {
  mockTriggerEmail.mockReset().mockResolvedValue(undefined);
  mockUserFindFirst.mockReset().mockResolvedValue(null);
  mockInvitationFindFirst.mockReset().mockResolvedValue(null);
});

// Sign-in emails are decided and sent in the background (the endpoint
// answers first), so read the recipients once that work has settled.
const recipients = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  return mockTriggerEmail.mock.calls.map(
    ([message]: [{ to: string }]) => message.to,
  );
};

describe('auth.server sign-up allowlist wiring', () => {
  it('refuses to create a user outside the allowed domains', async () => {
    const before = auth.options.databaseHooks?.user?.create?.before;
    if (!before) throw new Error('no user.create.before hook is configured');
    await expect(before({ email: 'someone@gmail.com' })).rejects.toMatchObject({
      body: { code: EMAIL_DOMAIN_NOT_ALLOWED },
    });
    await expect(
      before({ email: 'person@revola.ai' }),
    ).resolves.toBeUndefined();
  });

  // The same success for every address: a refusal would reveal which
  // outside addresses already have an account.
  it('mails no magic link to a new address outside the allowed domains', async () => {
    await expect(
      auth.api.signInMagicLink({
        body: { email: 'someone@gmail.com' },
        headers: new Headers(),
      }),
    ).resolves.toEqual({ status: true });
    expect(await recipients()).toEqual([]);
  });

  it('mails no sign-in code to a new address outside the allowed domains', async () => {
    await expect(
      auth.api.sendVerificationOTP({
        body: { email: 'someone@gmail.com', type: 'sign-in' },
        headers: new Headers(),
      }),
    ).resolves.toEqual({ success: true });
    expect(await recipients()).toEqual([]);
  });

  it('mails the sign-in code to an existing user outside the allowed domains', async () => {
    mockUserFindFirst.mockResolvedValue({ id: 'usr_auditor' });
    await auth.api.sendVerificationOTP({
      body: { email: 'auditor@firm.com', type: 'sign-in' },
      headers: new Headers(),
    });
    expect(await recipients()).toEqual(['auditor@firm.com']);
  });

  it('mails the magic link to an address in an allowed domain', async () => {
    await auth.api.signInMagicLink({
      body: { email: 'person@revola.ai' },
      headers: new Headers(),
    });
    expect(await recipients()).toEqual(['person@revola.ai']);
  });
});

describe('auth.server account linking', () => {
  // A trusted provider links to an existing account by email even when it
  // does not vouch for the address. Microsoft may hand over a username claim
  // as the email (microsoft-email.ts); GitHub links anyway whenever GitHub
  // reports the address verified, so trusting it would only add the
  // unverified case.
  it('trusts only Google to link without a verified-email claim', () => {
    expect(auth.options.account?.accountLinking?.trustedProviders).toEqual([
      'google',
    ]);
  });
});

describe('auth.server Microsoft tenant', () => {
  const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';
  const loadWith = (env: Record<string, string>) => {
    const before = { ...process.env };
    Object.assign(process.env, {
      AUTH_MICROSOFT_CLIENT_ID: 'microsoft-client-id',
      AUTH_MICROSOFT_CLIENT_SECRET: 'microsoft-client-secret',
      ...env,
    });
    try {
      let loaded: typeof import('./auth.server') | undefined;
      jest.isolateModules(() => {
        loaded =
          jest.requireActual<typeof import('./auth.server')>('./auth.server');
      });
      return loaded;
    } finally {
      process.env = before;
    }
  };

  it('refuses to boot with a multi-tenant Microsoft sign-in and an allowlist', () => {
    expect(() => loadWith({})).toThrow('AUTH_MICROSOFT_TENANT_ID');
    expect(() => loadWith({ AUTH_MICROSOFT_TENANT_ID: 'common' })).toThrow(
      'AUTH_MICROSOFT_TENANT_ID',
    );
  });

  it('signs in against the configured tenant', () => {
    const loaded = loadWith({ AUTH_MICROSOFT_TENANT_ID: TENANT });
    expect(loaded?.auth.options.socialProviders).toMatchObject({
      microsoft: { tenantId: TENANT },
    });
  });
});
