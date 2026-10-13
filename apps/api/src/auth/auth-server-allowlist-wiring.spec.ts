// AUTH_ALLOWED_EMAIL_DOMAINS is enforced only if auth.server.ts hands the
// allowlist to better-auth: the create hook (every sign-up path) and the
// magic-link sender wrapper (nothing is mailed to a disallowed new address).
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
delete process.env.AUTH_COOKIE_DOMAIN;

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

const recipients = () =>
  mockTriggerEmail.mock.calls.map(([message]: [{ to: string }]) => message.to);

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

  it('mails no magic link to a new address outside the allowed domains', async () => {
    await auth.api
      .signInMagicLink({
        body: { email: 'someone@gmail.com' },
        headers: new Headers(),
      })
      .catch(() => undefined);
    expect(recipients()).toEqual([]);
  });

  it('mails the magic link to an address in an allowed domain', async () => {
    await auth.api.signInMagicLink({
      body: { email: 'person@revola.ai' },
      headers: new Headers(),
    });
    expect(recipients()).toEqual(['person@revola.ai']);
  });
});
