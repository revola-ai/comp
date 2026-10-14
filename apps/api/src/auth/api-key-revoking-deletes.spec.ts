import type { PrismaClient } from '@db';
import { FakeMemberDb } from '../../test/fake-member-db';

let mockDb = new FakeMemberDb();
jest.mock('@db', () => ({
  get db() {
    return mockDb;
  },
}));

import { withApiKeyRevokingDeletes } from './api-key-revoking-deletes';

/**
 * better-auth's Prisma adapter (@better-auth/prisma-adapter 1.6.23) resolves
 * each model through `getModelName` and then calls `db[model].<method>`. With
 * `user.modelName: 'User'` (auth.server.ts) admin remove-user deletes through
 * `db.User`; the organization plugin's members go through `db.member`. Prisma
 * exposes both casings, so revocation must hold under every one of them.
 */
type AdapterDelegate = {
  delete: (args: { where: { id: string } }) => Promise<unknown>;
  deleteMany: (args: { where: Record<string, unknown> }) => Promise<unknown>;
};

function adapterModel(model: string): AdapterDelegate {
  const client = withApiKeyRevokingDeletes(mockDb as unknown as PrismaClient);
  const delegate: AdapterDelegate = Reflect.get(client, model);
  return delegate;
}

const activity = () => mockDb.keys.map((key) => key.isActive);

describe('better-auth deletes revoke keys under every model name', () => {
  beforeEach(() => {
    mockDb = new FakeMemberDb();
    mockDb.addMember({ id: 'mem_1', organizationId: 'org_1', userId: 'usr_1' });
    mockDb.addMember({ id: 'mem_2', organizationId: 'org_2', userId: 'usr_1' });
    mockDb.addMember({ id: 'mem_3', organizationId: 'org_1', userId: 'usr_3' });
    for (const [memberId, organizationId] of [
      ['mem_1', 'org_1'],
      ['mem_2', 'org_2'],
      ['mem_3', 'org_1'],
    ]) {
      mockDb.addKey({
        organizationId,
        createdByMemberId: memberId,
        organizationOwned: false,
      });
    }
  });

  it.each(['User', 'user'])(
    'db.%s.delete (admin remove-user) revokes every membership key',
    async (model) => {
      await adapterModel(model).delete({ where: { id: 'usr_1' } });
      expect(activity()).toEqual([false, false, true]);
      expect(mockDb.users.has('usr_1')).toBe(false);
    },
  );

  it.each(['User', 'user'])(
    'db.%s.deleteMany revokes the keys of every deleted user',
    async (model) => {
      await adapterModel(model).deleteMany({ where: { id: 'usr_1' } });
      expect(activity()).toEqual([false, false, true]);
      expect(mockDb.users.has('usr_1')).toBe(false);
    },
  );

  it.each(['Member', 'member'])(
    'db.%s.delete (remove-member, leave) revokes that member keys',
    async (model) => {
      await adapterModel(model).delete({ where: { id: 'mem_1' } });
      expect(activity()).toEqual([false, true, true]);
    },
  );

  it('a delete inside an interactive transaction revokes in that transaction', async () => {
    const client = withApiKeyRevokingDeletes(mockDb as unknown as PrismaClient);
    await client.$transaction(async (tx) => {
      const users: AdapterDelegate = Reflect.get(tx, 'User');
      await users.delete({ where: { id: 'usr_1' } });
    });
    expect(activity()).toEqual([false, false, true]);
    expect(mockDb.lockLog.sort()).toEqual(['mem_1', 'mem_2']);
  });

  it.each(['Member', 'member'])(
    'db.%s.deleteMany (organization deletion) revokes every removed member key',
    async (model) => {
      await adapterModel(model).deleteMany({
        where: { organizationId: 'org_1' },
      });
      expect(activity()).toEqual([false, true, false]);
    },
  );
});
