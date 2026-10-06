const mockRevokeCreatedApiKeys = jest.fn();
const mockRevokeApiKeysOfUser = jest.fn();
jest.mock('./api-key-offboarding', () => ({
  revokeCreatedApiKeys: (args: unknown) => mockRevokeCreatedApiKeys(args),
  revokeApiKeysOfUser: (args: unknown) => mockRevokeApiKeysOfUser(args),
}));

// better-auth ships ESM only, which this jest setup cannot load.
const mockGetSessionFromCtx = jest.fn();
jest.mock('better-auth/api', () => ({
  createAuthMiddleware: (handler: unknown) => handler,
  getSessionFromCtx: (ctx: unknown) => mockGetSessionFromCtx(ctx),
}));

import {
  LEAVE_ORGANIZATION_PATH,
  apiKeyOffboardingBeforeHook,
  revokeApiKeysBeforeLeave,
  revokeApiKeysBeforeMemberRemoval,
  revokeApiKeysBeforeUserDeletion,
} from './auth-offboarding-hooks';

// better-auth removes members and users through its own endpoints
// (/organization/remove-member, /organization/leave, /admin/remove-user), which
// delete the Member row and let ApiKey.createdByMemberId fall to NULL. These
// hooks revoke the keys first so they cannot turn into owner-attributed
// "legacy" keys.
describe('better-auth offboarding hooks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRevokeCreatedApiKeys.mockResolvedValue({ count: 1 });
    mockRevokeApiKeysOfUser.mockResolvedValue({ count: 1 });
  });

  it('revokes the removed member keys before remove-member deletes the row', async () => {
    await revokeApiKeysBeforeMemberRemoval({ member: { id: 'mem_1' } });
    expect(mockRevokeCreatedApiKeys).toHaveBeenCalledWith({
      memberIds: ['mem_1'],
    });
  });

  it('revokes every membership key before a user is deleted', async () => {
    await expect(
      revokeApiKeysBeforeUserDeletion({ id: 'usr_1' }),
    ).resolves.toBeUndefined();
    expect(mockRevokeApiKeysOfUser).toHaveBeenCalledWith({ userId: 'usr_1' });
  });

  it('revokes the leaving user keys in that organization', async () => {
    await revokeApiKeysBeforeLeave({
      path: LEAVE_ORGANIZATION_PATH,
      userId: 'usr_1',
      organizationId: 'org_1',
    });
    expect(LEAVE_ORGANIZATION_PATH).toBe('/organization/leave');
    expect(mockRevokeApiKeysOfUser).toHaveBeenCalledWith({
      userId: 'usr_1',
      organizationId: 'org_1',
    });
  });

  it('does nothing on other paths or without a session user or organization', async () => {
    await revokeApiKeysBeforeLeave({
      path: '/organization/remove-member',
      userId: 'usr_1',
      organizationId: 'org_1',
    });
    await revokeApiKeysBeforeLeave({
      path: LEAVE_ORGANIZATION_PATH,
      userId: undefined,
      organizationId: 'org_1',
    });
    await revokeApiKeysBeforeLeave({
      path: LEAVE_ORGANIZATION_PATH,
      userId: 'usr_1',
      organizationId: undefined,
    });
    expect(mockRevokeApiKeysOfUser).not.toHaveBeenCalled();
  });

  it('wires the leave check as a before-hook that reads the session user', async () => {
    mockGetSessionFromCtx.mockResolvedValueOnce({ user: { id: 'usr_9' } });
    const ctx = {
      path: LEAVE_ORGANIZATION_PATH,
      body: { organizationId: 'org_9' },
    };
    await apiKeyOffboardingBeforeHook(ctx as never);
    expect(mockGetSessionFromCtx).toHaveBeenCalledWith(ctx);
    expect(mockRevokeApiKeysOfUser).toHaveBeenCalledWith({
      userId: 'usr_9',
      organizationId: 'org_9',
    });
  });

  it('skips the session lookup on every other path', async () => {
    await apiKeyOffboardingBeforeHook({
      path: '/get-session',
      body: undefined,
    } as never);
    expect(mockGetSessionFromCtx).not.toHaveBeenCalled();
    expect(mockRevokeApiKeysOfUser).not.toHaveBeenCalled();
  });

  it('propagates a revocation failure so the removal does not proceed', async () => {
    mockRevokeCreatedApiKeys.mockRejectedValueOnce(new Error('db down'));
    await expect(
      revokeApiKeysBeforeMemberRemoval({ member: { id: 'mem_1' } }),
    ).rejects.toThrow('db down');
  });
});
