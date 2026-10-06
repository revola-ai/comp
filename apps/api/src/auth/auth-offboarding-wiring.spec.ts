import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PrismaClient } from '@db';
import { FakeMemberDb } from '../../test/fake-member-db';

let mockDb = new FakeMemberDb();
jest.mock('@db', () => ({
  get db() {
    return mockDb;
  },
}));

import { withApiKeyRevokingDeletes } from './api-key-revoking-deletes';

// better-auth (ESM only) cannot load under this jest setup, so the wiring is
// checked in the source, and the leave flow is replayed in better-auth's order
// (better-auth 1.6.23, plugins/organization/routes/crud-members.mjs,
// leaveOrganization): find the member, refuse a sole owner with
// YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER, else adapter.deleteMember,
// which reaches member.delete on the client passed to prismaAdapter.
describe('auth.server wiring for API-key offboarding', () => {
  const source = readFileSync(resolve(__dirname, 'auth.server.ts'), 'utf8');

  it('hands better-auth the client whose member and user deletes revoke keys', () => {
    expect(source).toMatch(/prismaAdapter\(withApiKeyRevokingDeletes\(db\)/);
  });

  it('revokes nothing in hooks that run before better-auth decides to delete', () => {
    expect(source).not.toMatch(/apiKeyOffboardingBeforeHook/);
    expect(source).not.toMatch(/beforeRemoveMember/);
    expect(source).not.toMatch(/revokeApiKeysBefore/);
  });
});

describe('leaving an organization', () => {
  beforeEach(() => {
    mockDb = new FakeMemberDb();
    mockDb.addMember({
      id: 'mem_owner',
      organizationId: 'org_1',
      userId: 'usr_owner',
    });
    mockDb.addKey({
      organizationId: 'org_1',
      createdByMemberId: 'mem_owner',
      organizationOwned: false,
    });
  });

  async function leave({
    memberId,
    ownerCount,
  }: {
    memberId: string;
    ownerCount: number;
  }): Promise<'left' | 'refused'> {
    const client = withApiKeyRevokingDeletes(mockDb as unknown as PrismaClient);
    const member = await client.member.findUnique({ where: { id: memberId } });
    if (!member) return 'refused';
    if (ownerCount <= 1) return 'refused';
    await client.member.delete({ where: { id: memberId } });
    return 'left';
  }

  it('a refused leave (sole owner) keeps the leaver keys working', async () => {
    expect(await leave({ memberId: 'mem_owner', ownerCount: 1 })).toBe(
      'refused',
    );
    expect(mockDb.usableKeysOf('mem_owner')).toHaveLength(1);
  });

  it('a successful leave revokes the leaver keys together with the membership', async () => {
    expect(await leave({ memberId: 'mem_owner', ownerCount: 2 })).toBe('left');
    expect(mockDb.members.has('mem_owner')).toBe(false);
    expect(mockDb.keys.map((key) => key.isActive)).toEqual([false]);
  });
});
