import { FakeMemberDb } from '../../../test/fake-member-db';

// PATCH /v1/people/:id goes through MemberQueries.updateMember. A change that
// cuts the member's access (isActive: false, or a role removed) revokes the
// member's personal API keys in the same transaction as the update.
let mockDb = new FakeMemberDb();
jest.mock('@db', () => ({
  get db() {
    return mockDb;
  },
}));

import { MemberQueries } from './member-queries';

const activeKeys = () =>
  mockDb.keys.filter((key) => key.isActive).map((key) => key.id);

describe('MemberQueries.updateMember revokes personal API keys on access loss', () => {
  beforeEach(() => {
    mockDb = new FakeMemberDb();
    mockDb.addMember({
      id: 'mem_1',
      organizationId: 'org_1',
      userId: 'usr_1',
      role: 'owner,admin',
    });
    // apk_1 personal, apk_2 organization-owned.
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
  });

  it('deactivating via { isActive: false } revokes personal keys only', async () => {
    await MemberQueries.updateMember('mem_1', 'org_1', { isActive: false });
    expect(mockDb.members.get('mem_1')?.isActive).toBe(false);
    expect(activeKeys()).toEqual(['apk_2']);
    expect(mockDb.lockLog).toEqual(['mem_1']);
  });

  it('reactivation brings no revoked key back', async () => {
    await MemberQueries.updateMember('mem_1', 'org_1', { isActive: false });
    await MemberQueries.updateMember('mem_1', 'org_1', { isActive: true });
    expect(mockDb.members.get('mem_1')).toMatchObject({
      isActive: true,
      deactivated: false,
    });
    expect(activeKeys()).toEqual(['apk_2']);
  });

  it('removing a role revokes personal keys', async () => {
    await MemberQueries.updateMember('mem_1', 'org_1', { role: 'employee' });
    expect(mockDb.members.get('mem_1')?.role).toBe('employee');
    expect(activeKeys()).toEqual(['apk_2']);
  });

  it('adding a role keeps the keys', async () => {
    await MemberQueries.updateMember('mem_1', 'org_1', {
      role: 'owner,admin,auditor',
    });
    expect(activeKeys()).toEqual(['apk_1', 'apk_2']);
  });

  it('an update that does not touch access keeps the keys', async () => {
    await MemberQueries.updateMember('mem_1', 'org_1', {
      jobTitle: 'Engineer',
      name: 'Renamed',
    });
    expect(activeKeys()).toEqual(['apk_1', 'apk_2']);
    expect(mockDb.lockLog).toEqual([]);
  });

  it('a deactivation the database refuses keeps the keys and the user change', async () => {
    mockDb.failNext({
      operation: 'member.update',
      error: new Error('P2025: record to update not found'),
    });
    await expect(
      MemberQueries.updateMember('mem_1', 'org_1', {
        isActive: false,
        name: 'Renamed',
      }),
    ).rejects.toThrow(/P2025/);
    expect(mockDb.members.get('mem_1')?.isActive).toBe(true);
    expect(mockDb.users.get('usr_1')).not.toHaveProperty('name');
    expect(activeKeys()).toEqual(['apk_1', 'apk_2']);
  });

  it('does not revoke the keys of a member of another organization', async () => {
    mockDb.addMember({ id: 'mem_x', organizationId: 'org_x', userId: 'usr_x' });
    mockDb.addKey({
      organizationId: 'org_x',
      createdByMemberId: 'mem_x',
      organizationOwned: false,
    });
    await expect(
      MemberQueries.updateMember('mem_x', 'org_1', { isActive: false }),
    ).rejects.toThrow(/P2025/);
    expect(activeKeys()).toEqual(['apk_1', 'apk_2', 'apk_3']);
  });
});
