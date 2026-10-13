import type { PrismaClient } from '@db';
import { FakeMemberDb } from '../../test/fake-member-db';

let mockDb = new FakeMemberDb();
jest.mock('@db', () => ({
  get db() {
    return mockDb;
  },
}));

import { withApiKeyRevokingDeletes } from './api-key-revoking-deletes';

// better-auth writes role changes (/organization/update-member-role) as
// db.member.update({ where, data: { role } }) and bans (/admin/ban-user,
// /admin/update-user) as db.User.update({ where, data: { banned: true } }),
// through the client handed to its Prisma adapter.
type AdapterDelegate = {
  update: (args: {
    where: { id: string };
    data: Record<string, unknown>;
  }) => Promise<unknown>;
  updateMany: (args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }) => Promise<unknown>;
};

function adapterModel(model: string): AdapterDelegate {
  const client = withApiKeyRevokingDeletes(mockDb as unknown as PrismaClient);
  const delegate: AdapterDelegate = Reflect.get(client, model);
  return delegate;
}

const activeKeys = () =>
  mockDb.keys.filter((key) => key.isActive).map((key) => key.id);

describe('better-auth updates that cut access revoke personal keys', () => {
  beforeEach(() => {
    mockDb = new FakeMemberDb();
    mockDb.addMember({
      id: 'mem_1',
      organizationId: 'org_1',
      userId: 'usr_1',
      role: 'owner,admin',
    });
    mockDb.addMember({
      id: 'mem_2',
      organizationId: 'org_2',
      userId: 'usr_1',
      role: 'admin',
    });
    mockDb.addMember({
      id: 'mem_3',
      organizationId: 'org_1',
      userId: 'usr_3',
      role: 'employee',
    });
    // apk_1: mem_1 personal, apk_2: mem_1 organization-owned,
    // apk_3: mem_2 personal, apk_4: mem_3 personal.
    mockDb.addKey({
      organizationId: 'org_1',
      createdByMemberId: 'mem_1',
      organizationOwned: false,
    });
    mockDb.addKey({
      organizationId: 'org_1',
      createdByMemberId: 'mem_1',
      organizationOwned: true,
    });
    mockDb.addKey({
      organizationId: 'org_2',
      createdByMemberId: 'mem_2',
      organizationOwned: false,
    });
    mockDb.addKey({
      organizationId: 'org_1',
      createdByMemberId: 'mem_3',
      organizationOwned: false,
    });
  });

  it.each(['member', 'Member'])(
    'db.%s.update removing a role revokes that member personal keys',
    async (model) => {
      await adapterModel(model).update({
        where: { id: 'mem_1' },
        data: { role: 'admin' },
      });
      expect(mockDb.members.get('mem_1')?.role).toBe('admin');
      expect(activeKeys()).toEqual(['apk_2', 'apk_3', 'apk_4']);
    },
  );

  it('a role change that only adds or reorders roles keeps the keys', async () => {
    await adapterModel('member').update({
      where: { id: 'mem_1' },
      data: { role: 'admin, owner,auditor' },
    });
    expect(activeKeys()).toEqual(['apk_1', 'apk_2', 'apk_3', 'apk_4']);
  });

  it('a role given as a Prisma { set } update is checked too', async () => {
    await adapterModel('member').update({
      where: { id: 'mem_3' },
      data: { role: { set: 'auditor' } },
    });
    expect(activeKeys()).toEqual(['apk_1', 'apk_2', 'apk_3']);
  });

  it('marking a member inactive or deactivated revokes its keys', async () => {
    await adapterModel('member').update({
      where: { id: 'mem_1' },
      data: { isActive: false },
    });
    await adapterModel('member').update({
      where: { id: 'mem_3' },
      data: { deactivated: true },
    });
    expect(activeKeys()).toEqual(['apk_2', 'apk_3']);
  });

  it('member.updateMany revokes only the members that lose a role', async () => {
    await adapterModel('member').updateMany({
      where: { organizationId: 'org_1' },
      data: { role: 'employee' },
    });
    expect(activeKeys()).toEqual(['apk_2', 'apk_3', 'apk_4']);
  });

  it('an update that changes no access revokes nothing and locks nothing', async () => {
    await adapterModel('member').update({
      where: { id: 'mem_1' },
      data: { department: 'it', isActive: true, role: 'owner,admin' },
    });
    expect(activeKeys()).toEqual(['apk_1', 'apk_2', 'apk_3', 'apk_4']);
    expect(mockDb.members.get('mem_1')?.isActive).toBe(true);
  });

  it('a role change the database refuses after revoking keeps the keys', async () => {
    mockDb.failNext({
      operation: 'member.update',
      error: new Error('P2025: record to update not found'),
    });
    await expect(
      adapterModel('member').update({
        where: { id: 'mem_1' },
        data: { role: 'admin' },
      }),
    ).rejects.toThrow(/P2025/);
    expect(mockDb.lockLog).toEqual(['mem_1']);
    expect(mockDb.members.get('mem_1')?.role).toBe('owner,admin');
    expect(activeKeys()).toEqual(['apk_1', 'apk_2', 'apk_3', 'apk_4']);
  });

  it.each(['User', 'user'])(
    'db.%s.update banning a user revokes the keys of all its memberships',
    async (model) => {
      await adapterModel(model).update({
        where: { id: 'usr_1' },
        data: { banned: true, banReason: 'abuse' },
      });
      expect(mockDb.users.get('usr_1')?.banned).toBe(true);
      expect(activeKeys()).toEqual(['apk_2', 'apk_4']);
    },
  );

  it('user.updateMany banning revokes; unbanning restores nothing', async () => {
    await adapterModel('User').updateMany({
      where: { id: 'usr_1' },
      data: { banned: true },
    });
    await adapterModel('User').update({
      where: { id: 'usr_1' },
      data: { banned: false },
    });
    expect(activeKeys()).toEqual(['apk_2', 'apk_4']);
  });

  it('a user update that does not ban revokes nothing', async () => {
    await adapterModel('User').update({
      where: { id: 'usr_1' },
      data: { name: 'Renamed', banned: false },
    });
    expect(activeKeys()).toEqual(['apk_1', 'apk_2', 'apk_3', 'apk_4']);
    expect(mockDb.lockLog).toEqual([]);
  });

  it('a ban the database refuses after revoking keeps the keys', async () => {
    mockDb.failNext({
      operation: 'user.update',
      error: new Error('P2025: record to update not found'),
    });
    await expect(
      adapterModel('User').update({
        where: { id: 'usr_1' },
        data: { banned: true },
      }),
    ).rejects.toThrow(/P2025/);
    expect(activeKeys()).toEqual(['apk_1', 'apk_2', 'apk_3', 'apk_4']);
  });
});
