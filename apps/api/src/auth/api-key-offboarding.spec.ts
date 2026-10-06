// The transaction client records each call in order, so the tests can assert
// that the member row is locked, then keys revoked, then the membership
// changed, all inside one transaction.
const mockCalls: Array<{ op: string; args: unknown }> = [];
const record = (op: string) => (args: unknown) => {
  mockCalls.push({ op, args });
  return Promise.resolve({ count: 1 });
};
const mockTx = {
  $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
    mockCalls.push({ op: 'lock', args: { sql: strings.join('?'), values } });
    return Promise.resolve([]);
  },
  apiKey: { updateMany: record('apiKey.updateMany') },
  member: {
    update: record('member.update'),
    delete: record('member.delete'),
  },
};
const mockTransaction = jest.fn(
  (run: (tx: typeof mockTx) => Promise<unknown>) => run(mockTx),
);
jest.mock('@db', () => ({
  db: {
    $transaction: (run: (tx: typeof mockTx) => Promise<unknown>) =>
      mockTransaction(run),
  },
}));

import {
  deactivateMemberAndRevokeApiKeys,
  deleteMemberAndRevokeApiKeys,
  revokeCreatedApiKeys,
} from './api-key-offboarding';

const PERSONAL_ACTIVE_KEYS = { organizationOwned: false, isActive: true };
const REVOKE_MEM_1 = {
  op: 'apiKey.updateMany',
  args: {
    where: { createdByMemberId: { in: ['mem_1'] }, ...PERSONAL_ACTIVE_KEYS },
    data: { isActive: false },
  },
};

function lockOf(memberIds: string[]) {
  return {
    op: 'lock',
    args: {
      sql: expect.stringMatching(/FROM "Member"[\s\S]*FOR UPDATE/) as unknown,
      values: [memberIds],
    },
  };
}

describe('api key offboarding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCalls.length = 0;
  });

  it('revokes only active personal keys created by the given members', async () => {
    await revokeCreatedApiKeys({
      tx: mockTx as unknown as Parameters<typeof revokeCreatedApiKeys>[0]['tx'],
      memberIds: ['mem_1', 'mem_2'],
    });
    expect(mockCalls).toEqual([
      {
        op: 'apiKey.updateMany',
        args: {
          where: {
            createdByMemberId: { in: ['mem_1', 'mem_2'] },
            ...PERSONAL_ACTIVE_KEYS,
          },
          data: { isActive: false },
        },
      },
    ]);
  });

  it('locks the member, revokes its keys, then deactivates it, in one transaction', async () => {
    const offboardDate = new Date('2026-10-05T00:00:00Z');
    await deactivateMemberAndRevokeApiKeys({
      memberId: 'mem_1',
      organizationId: 'org_1',
      offboardDate,
    });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockCalls).toEqual([
      lockOf(['mem_1']),
      REVOKE_MEM_1,
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
    expect(mockCalls[2]).toEqual({
      op: 'member.update',
      args: {
        where: { id: 'mem_1' },
        data: { deactivated: true, isActive: false },
      },
    });
  });

  it('can clear offboardDate explicitly', async () => {
    await deactivateMemberAndRevokeApiKeys({
      memberId: 'mem_1',
      organizationId: 'org_1',
      offboardDate: null,
    });
    expect(mockCalls[2]).toEqual({
      op: 'member.update',
      args: {
        where: { id: 'mem_1', organizationId: 'org_1' },
        data: { deactivated: true, isActive: false, offboardDate: null },
      },
    });
  });

  it('locks the member, revokes its keys, then deletes it, in one transaction', async () => {
    await deleteMemberAndRevokeApiKeys({
      memberId: 'mem_1',
      organizationId: 'org_1',
    });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockCalls).toEqual([
      lockOf(['mem_1']),
      REVOKE_MEM_1,
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
});
