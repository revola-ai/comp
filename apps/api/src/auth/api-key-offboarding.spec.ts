// Prisma calls are recorded as tagged operations so the tests can assert that
// revocation and the membership change run inside one transaction.
const mockApiKeyUpdateMany = jest.fn((args: unknown) => ({
  op: 'apiKey.updateMany',
  args,
}));
const mockMemberUpdate = jest.fn((args: unknown) => ({
  op: 'member.update',
  args,
}));
const mockMemberDelete = jest.fn((args: unknown) => ({
  op: 'member.delete',
  args,
}));
const mockTransaction = jest.fn((ops: unknown[]) => Promise.resolve(ops));
jest.mock('@db', () => ({
  db: {
    apiKey: { updateMany: (args: unknown) => mockApiKeyUpdateMany(args) },
    member: {
      update: (args: unknown) => mockMemberUpdate(args),
      delete: (args: unknown) => mockMemberDelete(args),
    },
    $transaction: (ops: unknown[]) => mockTransaction(ops),
  },
}));

import {
  deactivateMemberAndRevokeApiKeys,
  deleteMemberAndRevokeApiKeys,
  revokeApiKeysOfUser,
  revokeCreatedApiKeys,
} from './api-key-offboarding';

const PERSONAL_ACTIVE_KEYS = { organizationOwned: false, isActive: true };

describe('api key offboarding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('revokes only active personal keys created by the given members', async () => {
    await revokeCreatedApiKeys({ memberIds: ['mem_1', 'mem_2'] });
    expect(mockApiKeyUpdateMany).toHaveBeenCalledWith({
      where: {
        createdByMemberId: { in: ['mem_1', 'mem_2'] },
        ...PERSONAL_ACTIVE_KEYS,
      },
      data: { isActive: false },
    });
  });

  it('deactivates a member and revokes their keys in one transaction', async () => {
    const offboardDate = new Date('2026-10-05T00:00:00Z');
    await deactivateMemberAndRevokeApiKeys({
      memberId: 'mem_1',
      organizationId: 'org_1',
      offboardDate,
    });

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    const [ops] = mockTransaction.mock.calls[0];
    expect(ops).toEqual([
      {
        op: 'apiKey.updateMany',
        args: {
          where: {
            createdByMemberId: { in: ['mem_1'] },
            ...PERSONAL_ACTIVE_KEYS,
          },
          data: { isActive: false },
        },
      },
      {
        op: 'member.update',
        args: {
          where: { id: 'mem_1', organizationId: 'org_1' },
          data: { deactivated: true, isActive: false, offboardDate },
        },
      },
    ]);
  });

  it('leaves offboardDate untouched when none is given and scopes by id alone without an org', async () => {
    await deactivateMemberAndRevokeApiKeys({ memberId: 'mem_1' });
    expect(mockMemberUpdate).toHaveBeenCalledWith({
      where: { id: 'mem_1' },
      data: { deactivated: true, isActive: false },
    });
  });

  it('can clear offboardDate explicitly', async () => {
    await deactivateMemberAndRevokeApiKeys({
      memberId: 'mem_1',
      organizationId: 'org_1',
      offboardDate: null,
    });
    expect(mockMemberUpdate).toHaveBeenCalledWith({
      where: { id: 'mem_1', organizationId: 'org_1' },
      data: { deactivated: true, isActive: false, offboardDate: null },
    });
  });

  it('revokes keys before deleting a member, in one transaction', async () => {
    await deleteMemberAndRevokeApiKeys({
      memberId: 'mem_1',
      organizationId: 'org_1',
    });
    const [ops] = mockTransaction.mock.calls[0];
    expect(ops).toEqual([
      expect.objectContaining({ op: 'apiKey.updateMany' }),
      {
        op: 'member.delete',
        args: { where: { id: 'mem_1', organizationId: 'org_1' } },
      },
    ]);
  });

  it('propagates a failed transaction', async () => {
    mockTransaction.mockRejectedValueOnce(new Error('db down'));
    await expect(
      deactivateMemberAndRevokeApiKeys({ memberId: 'mem_1' }),
    ).rejects.toThrow('db down');
  });

  it("revokes a user's keys in one organization", async () => {
    await revokeApiKeysOfUser({ userId: 'usr_1', organizationId: 'org_1' });
    expect(mockApiKeyUpdateMany).toHaveBeenCalledWith({
      where: {
        createdBy: { is: { userId: 'usr_1', organizationId: 'org_1' } },
        ...PERSONAL_ACTIVE_KEYS,
      },
      data: { isActive: false },
    });
  });

  it("revokes a user's keys in every organization when none is given", async () => {
    await revokeApiKeysOfUser({ userId: 'usr_1' });
    expect(mockApiKeyUpdateMany).toHaveBeenCalledWith({
      where: {
        createdBy: { is: { userId: 'usr_1' } },
        ...PERSONAL_ACTIVE_KEYS,
      },
      data: { isActive: false },
    });
  });
});
