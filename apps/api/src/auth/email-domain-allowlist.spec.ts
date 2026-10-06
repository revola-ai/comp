// better-auth ships ESM only, which this jest setup cannot load; stand in a
// minimal APIError with the same (status, body) constructor.
jest.mock('better-auth/api', () => {
  class APIError extends Error {
    constructor(
      public status: string,
      public body?: { code?: string; message?: string },
    ) {
      super(body?.message ?? status);
    }
  }
  return { APIError };
});

import { APIError } from 'better-auth/api';
import {
  EMAIL_DOMAIN_NOT_ALLOWED,
  createEmailDomainAllowlistHook,
  isEmailAllowed,
  parseAllowedDomains,
} from './email-domain-allowlist';

describe('parseAllowedDomains', () => {
  it('returns an empty list when unset or blank', () => {
    expect(parseAllowedDomains({ env: {} })).toEqual([]);
    expect(
      parseAllowedDomains({ env: { AUTH_ALLOWED_EMAIL_DOMAINS: '' } }),
    ).toEqual([]);
    expect(
      parseAllowedDomains({ env: { AUTH_ALLOWED_EMAIL_DOMAINS: ' , ' } }),
    ).toEqual([]);
  });

  it('splits, trims and lowercases the list', () => {
    expect(
      parseAllowedDomains({
        env: {
          AUTH_ALLOWED_EMAIL_DOMAINS: ' Revola.AI , partner.example.com ',
        },
      }),
    ).toEqual(['revola.ai', 'partner.example.com']);
  });

  it('rejects a malformed entry and names the variable', () => {
    for (const value of [
      '@revola.ai',
      'revola',
      'revola.ai/x',
      'revola .ai',
      '*.revola.ai',
    ]) {
      expect(() =>
        parseAllowedDomains({ env: { AUTH_ALLOWED_EMAIL_DOMAINS: value } }),
      ).toThrow(/AUTH_ALLOWED_EMAIL_DOMAINS/);
    }
  });
});

describe('isEmailAllowed', () => {
  const allowedDomains = ['revola.ai'];

  it('allows a listed domain', () => {
    expect(
      isEmailAllowed({
        email: 'person@revola.ai',
        allowedDomains,
        hasPendingInvitation: false,
      }),
    ).toBe(true);
  });

  it('rejects another domain', () => {
    expect(
      isEmailAllowed({
        email: 'person@gmail.com',
        allowedDomains,
        hasPendingInvitation: false,
      }),
    ).toBe(false);
  });

  it('normalizes case before matching', () => {
    expect(
      isEmailAllowed({
        email: 'Person@Revola.AI',
        allowedDomains,
        hasPendingInvitation: false,
      }),
    ).toBe(true);
  });

  it('rejects a subdomain unless it is listed', () => {
    expect(
      isEmailAllowed({
        email: 'person@x.revola.ai',
        allowedDomains,
        hasPendingInvitation: false,
      }),
    ).toBe(false);
    expect(
      isEmailAllowed({
        email: 'person@x.revola.ai',
        allowedDomains: ['revola.ai', 'x.revola.ai'],
        hasPendingInvitation: false,
      }),
    ).toBe(true);
  });

  it('rejects a lookalike domain that merely ends with a listed one', () => {
    expect(
      isEmailAllowed({
        email: 'person@evilrevola.ai',
        allowedDomains,
        hasPendingInvitation: false,
      }),
    ).toBe(false);
  });

  it('allows an unlisted domain with a pending invitation', () => {
    expect(
      isEmailAllowed({
        email: 'auditor@firm.com',
        allowedDomains,
        hasPendingInvitation: true,
      }),
    ).toBe(true);
  });

  it('allows everyone when the allowlist is empty', () => {
    expect(
      isEmailAllowed({
        email: 'person@gmail.com',
        allowedDomains: [],
        hasPendingInvitation: false,
      }),
    ).toBe(true);
  });

  it('rejects a malformed email even with a pending invitation', () => {
    for (const email of [
      '',
      'kyle',
      'person@',
      '@revola.ai',
      'a@b@revola.ai',
      'person@revola.ai.',
    ]) {
      expect(
        isEmailAllowed({ email, allowedDomains, hasPendingInvitation: true }),
      ).toBe(false);
    }
  });
});

describe('createEmailDomainAllowlistHook', () => {
  const findFirst = jest.fn();
  const db = { invitation: { findFirst } };
  const env = { AUTH_ALLOWED_EMAIL_DOMAINS: 'revola.ai' };

  beforeEach(() => {
    findFirst.mockReset();
  });

  async function expectForbidden(promise: Promise<unknown>): Promise<void> {
    const error = await promise.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(APIError);
    if (!(error instanceof APIError)) return;
    expect(error.status).toBe('FORBIDDEN');
    expect(error.body?.code).toBe(EMAIL_DOMAIN_NOT_ALLOWED);
    expect(error.message).toBe(EMAIL_DOMAIN_NOT_ALLOWED);
  }

  it('lets a listed domain through without an invitation lookup', async () => {
    const hook = createEmailDomainAllowlistHook({ env, db });
    await expect(hook({ email: 'Person@Revola.AI' })).resolves.toBeUndefined();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('rejects an unlisted domain with email_domain_not_allowed', async () => {
    findFirst.mockResolvedValue(null);
    const hook = createEmailDomainAllowlistHook({ env, db });
    await expectForbidden(hook({ email: 'someone@gmail.com' }));
  });

  it('allows an unlisted domain with a pending, unexpired invitation (case-insensitive lookup)', async () => {
    findFirst.mockResolvedValue({ id: 'inv_1' });
    const hook = createEmailDomainAllowlistHook({ env, db });

    await expect(hook({ email: 'Auditor@Firm.com' })).resolves.toBeUndefined();

    const args = findFirst.mock.calls[0][0];
    expect(args.where.email).toEqual({
      equals: 'auditor@firm.com',
      mode: 'insensitive',
    });
    expect(args.where.status).toBe('pending');
    expect(args.where.expiresAt.gt).toBeInstanceOf(Date);
    expect(
      Math.abs(args.where.expiresAt.gt.getTime() - Date.now()),
    ).toBeLessThan(5000);
  });

  it('rejects when the only invitation is expired or already accepted', async () => {
    // The query filters on status=pending and expiresAt>now, so an expired or
    // accepted invitation is not returned.
    findFirst.mockResolvedValue(null);
    const hook = createEmailDomainAllowlistHook({ env, db });
    await expectForbidden(hook({ email: 'auditor@firm.com' }));
  });

  it('rejects a malformed email without a lookup', async () => {
    const hook = createEmailDomainAllowlistHook({ env, db });
    await expectForbidden(hook({ email: 'not-an-email' }));
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('is inert when the allowlist is unset or empty', async () => {
    for (const hookEnv of [{}, { AUTH_ALLOWED_EMAIL_DOMAINS: '' }]) {
      const hook = createEmailDomainAllowlistHook({ env: hookEnv, db });
      await expect(
        hook({ email: 'someone@gmail.com' }),
      ).resolves.toBeUndefined();
    }
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('fails at construction when the allowlist is malformed', () => {
    expect(() =>
      createEmailDomainAllowlistHook({
        env: { AUTH_ALLOWED_EMAIL_DOMAINS: 'revola' },
        db,
      }),
    ).toThrow(/AUTH_ALLOWED_EMAIL_DOMAINS/);
  });
});
