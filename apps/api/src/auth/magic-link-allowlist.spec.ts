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
  createAllowlistedMagicLinkSender,
} from './email-domain-allowlist';

describe('createAllowlistedMagicLinkSender', () => {
  const userFindFirst = jest.fn();
  const invitationFindFirst = jest.fn();
  const db = {
    user: { findFirst: userFindFirst },
    invitation: { findFirst: invitationFindFirst },
  };
  const send = jest.fn();
  const env = { AUTH_ALLOWED_EMAIL_DOMAINS: 'revola.ai' };
  const link = { url: 'https://api.comp.revola.ai/api/auth/magic-link/verify' };

  beforeEach(() => {
    jest.resetAllMocks();
    send.mockResolvedValue(undefined);
    userFindFirst.mockResolvedValue(null);
    invitationFindFirst.mockResolvedValue(null);
  });

  it('rejects a new email from a disallowed domain and sends nothing', async () => {
    const sender = createAllowlistedMagicLinkSender({ env, db, send });

    const error = await sender({ email: 'Someone@Gmail.com', ...link }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(APIError);
    if (!(error instanceof APIError)) return;
    expect(error.status).toBe('FORBIDDEN');
    expect(error.body?.code).toBe(EMAIL_DOMAIN_NOT_ALLOWED);
    expect(error.message).toBe(EMAIL_DOMAIN_NOT_ALLOWED);
    expect(send).not.toHaveBeenCalled();
    expect(userFindFirst.mock.calls[0][0].where.email).toEqual({
      equals: 'someone@gmail.com',
      mode: 'insensitive',
    });
  });

  it('sends the link to an existing user with an outside domain', async () => {
    userFindFirst.mockResolvedValue({ id: 'usr_1' });
    const sender = createAllowlistedMagicLinkSender({ env, db, send });

    await sender({ email: 'auditor@firm.com', ...link });

    expect(send).toHaveBeenCalledWith({ email: 'auditor@firm.com', ...link });
    expect(invitationFindFirst).not.toHaveBeenCalled();
  });

  it('sends the link to a new email with a pending invitation', async () => {
    invitationFindFirst.mockResolvedValue({ id: 'inv_1' });
    const sender = createAllowlistedMagicLinkSender({ env, db, send });

    await sender({ email: 'auditor@firm.com', ...link });

    expect(send).toHaveBeenCalledTimes(1);
    const { where } = invitationFindFirst.mock.calls[0][0];
    expect(where.status).toBe('pending');
    expect(where.expiresAt.gt).toBeInstanceOf(Date);
  });

  it('sends the link to a new email from a listed domain', async () => {
    const sender = createAllowlistedMagicLinkSender({ env, db, send });

    await sender({ email: 'person@revola.ai', ...link });

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends the link to anyone when the allowlist is unset, without lookups', async () => {
    const sender = createAllowlistedMagicLinkSender({ env: {}, db, send });

    await sender({ email: 'someone@gmail.com', ...link });

    expect(send).toHaveBeenCalledTimes(1);
    expect(userFindFirst).not.toHaveBeenCalled();
    expect(invitationFindFirst).not.toHaveBeenCalled();
  });
});
