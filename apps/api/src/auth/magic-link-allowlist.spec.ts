function mockNativeModule(id: string): unknown {
  const loader: typeof import('../../test/native-module') = jest.requireActual(
    '../../test/native-module',
  );
  return loader.nativeModule(id);
}
jest.mock('better-auth/api', () => mockNativeModule('better-auth/api'));

import { createAllowlistedEmailSender } from './email-domain-allowlist';

// Sign-in emails (magic link, email OTP) must not reveal which addresses have
// an account: an address that may not sign up gets the same success as one
// that may, and simply no email. The user.create hook still refuses the
// account if one is ever attempted.
describe('createAllowlistedEmailSender', () => {
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

  it('answers a new email from a disallowed domain like any other, sending nothing', async () => {
    const sender = createAllowlistedEmailSender({ env, db, send });

    await expect(
      sender({ email: 'Someone@Gmail.com', ...link }),
    ).resolves.toBeUndefined();

    expect(send).not.toHaveBeenCalled();
    expect(userFindFirst.mock.calls[0][0].where.email).toEqual({
      equals: 'someone@gmail.com',
      mode: 'insensitive',
    });
  });

  it('sends nothing to a malformed address', async () => {
    const sender = createAllowlistedEmailSender({ env, db, send });

    await expect(
      sender({ email: 'not-an-address', ...link }),
    ).resolves.toBeUndefined();

    expect(send).not.toHaveBeenCalled();
  });

  it('wraps an email OTP sender the same way, passing the message through', async () => {
    const sendOtp = jest.fn().mockResolvedValue(undefined);
    const sender = createAllowlistedEmailSender({ env, db, send: sendOtp });
    const otp = { otp: '123456', type: 'sign-in' as const };

    await sender({ email: 'someone@gmail.com', ...otp });
    await sender({ email: 'person@revola.ai', ...otp });

    expect(sendOtp).toHaveBeenCalledTimes(1);
    expect(sendOtp).toHaveBeenCalledWith({ email: 'person@revola.ai', ...otp });
  });

  it('sends the link to an existing user with an outside domain', async () => {
    userFindFirst.mockResolvedValue({ id: 'usr_1' });
    const sender = createAllowlistedEmailSender({ env, db, send });

    await sender({ email: 'auditor@firm.com', ...link });

    expect(send).toHaveBeenCalledWith({ email: 'auditor@firm.com', ...link });
    expect(invitationFindFirst).not.toHaveBeenCalled();
  });

  it('sends the link to a new email with a pending invitation', async () => {
    invitationFindFirst.mockResolvedValue({ id: 'inv_1' });
    const sender = createAllowlistedEmailSender({ env, db, send });

    await sender({ email: 'auditor@firm.com', ...link });

    expect(send).toHaveBeenCalledTimes(1);
    const { where } = invitationFindFirst.mock.calls[0][0];
    expect(where.status).toBe('pending');
    expect(where.expiresAt.gt).toBeInstanceOf(Date);
  });

  it('sends the link to a new email from a listed domain', async () => {
    const sender = createAllowlistedEmailSender({ env, db, send });

    await sender({ email: 'person@revola.ai', ...link });

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends the link to anyone when the allowlist is unset, without lookups', async () => {
    const sender = createAllowlistedEmailSender({ env: {}, db, send });

    await sender({ email: 'someone@gmail.com', ...link });

    expect(send).toHaveBeenCalledTimes(1);
    expect(userFindFirst).not.toHaveBeenCalled();
    expect(invitationFindFirst).not.toHaveBeenCalled();
  });
});
