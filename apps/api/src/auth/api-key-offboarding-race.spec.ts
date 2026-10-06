import { ForbiddenException } from '@nestjs/common';
import type { PrismaClient } from '@db';
import { FakeMemberDb, gate } from '../../test/fake-member-db';

// Key creation and member removal serialize on the creating member's row
// (SELECT ... FOR UPDATE), so no interleaving can leave a usable personal key
// behind a removed or deactivated member. The database is an in-memory model
// of the row locks and the ApiKey -> Member foreign key (SetNull on delete).
let mockDb = new FakeMemberDb();
jest.mock('@db', () => ({
  get db() {
    return mockDb;
  },
}));
jest.mock('@trycompai/auth', () => ({
  statement: { risk: ['read', 'update'] },
}));

import { ApiKeyService } from './api-key.service';
import {
  deactivateMemberAndRevokeApiKeys,
  deleteMemberAndRevokeApiKeys,
} from './api-key-offboarding';
import {
  type ApiKeyProvenance,
  resolveKeyProvenance,
} from './api-key-provenance';
import { withApiKeyRevokingDeletes } from './api-key-revoking-deletes';

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));
const PERSONAL: ApiKeyProvenance = {
  createdByMemberId: 'mem_1',
  organizationOwned: false,
};

function createKey(provenance = PERSONAL) {
  return new ApiKeyService().create({
    organizationId: 'org_1',
    name: 'CI',
    scopes: ['risk:read'],
    provenance,
  });
}

/** better-auth's view of the database: deletes revoke keys first. */
function betterAuthClient(): PrismaClient {
  return withApiKeyRevokingDeletes(mockDb as unknown as PrismaClient);
}

describe('API key creation and member removal serialize on the member row', () => {
  beforeEach(() => {
    mockDb = new FakeMemberDb();
    mockDb.addMember({ id: 'mem_1', organizationId: 'org_1', userId: 'usr_1' });
  });

  it('records the creator and locks its row before inserting', async () => {
    const created = await createKey();
    expect(created.key).toMatch(/^comp_/);
    expect(mockDb.lockLog).toEqual(['mem_1']);
    expect(mockDb.keys).toEqual([
      expect.objectContaining({ createdByMemberId: 'mem_1', isActive: true }),
    ]);
  });

  it('refuses creation for a deactivated member', async () => {
    await deactivateMemberAndRevokeApiKeys({ memberId: 'mem_1' });
    await expect(createKey()).rejects.toThrow(ForbiddenException);
    expect(mockDb.keys).toEqual([]);
  });

  it('refuses creation for a removed member', async () => {
    await deleteMemberAndRevokeApiKeys({
      memberId: 'mem_1',
      organizationId: 'org_1',
    });
    await expect(createKey()).rejects.toThrow(ForbiddenException);
  });

  it('refuses creation for a member of another organization', async () => {
    mockDb.addMember({ id: 'mem_x', organizationId: 'org_x', userId: 'usr_x' });
    await expect(
      createKey({ createdByMemberId: 'mem_x', organizationOwned: false }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('a key minted through a personal API key inherits its creator and dies on offboarding', async () => {
    const provenance = resolveKeyProvenance({
      authType: 'api-key',
      apiKeyCreatedByMemberId: 'mem_1',
      apiKeyOrganizationOwned: false,
    });
    await createKey(provenance);
    await deactivateMemberAndRevokeApiKeys({ memberId: 'mem_1' });
    expect(mockDb.keys.map((key) => key.isActive)).toEqual([false]);
  });

  it('a key minted through an organization-owned key stays organization-owned', async () => {
    const provenance = resolveKeyProvenance({
      authType: 'api-key',
      apiKeyCreatedByMemberId: 'mem_1',
      apiKeyOrganizationOwned: true,
    });
    await createKey(provenance);
    await betterAuthClient().member.delete({ where: { id: 'mem_1' } });
    expect(mockDb.keys).toEqual([
      expect.objectContaining({ organizationOwned: true, isActive: true }),
    ]);
  });

  it('when removal holds the lock first, the waiting creation is refused', async () => {
    const paused = gate();
    mockDb.pauseNext({ operation: 'apiKey.updateMany', until: paused.wait });
    const removal = deleteMemberAndRevokeApiKeys({
      memberId: 'mem_1',
      organizationId: 'org_1',
    });
    await flush();
    const creation = createKey();
    await flush();
    expect(mockDb.keys).toEqual([]);
    paused.open();
    await removal;
    await expect(creation).rejects.toThrow(ForbiddenException);
    expect(mockDb.keys).toEqual([]);
  });

  it('when creation holds the lock first, the waiting removal revokes the new key', async () => {
    const paused = gate();
    mockDb.pauseNext({ operation: 'apiKey.create', until: paused.wait });
    const creation = createKey();
    await flush();
    const removal = betterAuthClient().member.delete({
      where: { id: 'mem_1' },
    });
    await flush();
    paused.open();
    await creation;
    await removal;
    expect(mockDb.keys).toEqual([
      expect.objectContaining({ createdByMemberId: null, isActive: false }),
    ]);
  });

  it('when creation holds the lock first, a waiting deactivation revokes the new key', async () => {
    const paused = gate();
    mockDb.pauseNext({ operation: 'apiKey.create', until: paused.wait });
    const creation = createKey();
    await flush();
    const deactivation = deactivateMemberAndRevokeApiKeys({
      memberId: 'mem_1',
    });
    await flush();
    paused.open();
    await Promise.all([creation, deactivation]);
    expect(mockDb.usableKeysOf('mem_1')).toEqual([]);
    expect(mockDb.keys.map((key) => key.isActive)).toEqual([false]);
  });
});

describe('better-auth deletes revoke personal keys in the same transaction', () => {
  beforeEach(() => {
    mockDb = new FakeMemberDb();
    mockDb.addMember({ id: 'mem_1', organizationId: 'org_1', userId: 'usr_1' });
    mockDb.addMember({ id: 'mem_2', organizationId: 'org_2', userId: 'usr_1' });
    mockDb.addKey({
      organizationId: 'org_1',
      createdByMemberId: 'mem_1',
      organizationOwned: false,
    });
    mockDb.addKey({
      organizationId: 'org_2',
      createdByMemberId: 'mem_2',
      organizationOwned: false,
    });
    mockDb.addKey({
      organizationId: 'org_1',
      createdByMemberId: 'mem_1',
      organizationOwned: true,
    });
  });

  const activity = () => mockDb.keys.map((key) => key.isActive);

  it('member.delete (remove-member, leave) revokes that member keys only', async () => {
    await betterAuthClient().member.delete({ where: { id: 'mem_1' } });
    expect(activity()).toEqual([false, true, true]);
    expect(mockDb.members.has('mem_1')).toBe(false);
  });

  it('member.deleteMany (organization deletion) revokes every removed member key', async () => {
    await betterAuthClient().member.deleteMany({
      where: { organizationId: 'org_1' },
    });
    expect(activity()).toEqual([false, true, true]);
  });

  it('user.delete (admin remove-user) revokes the keys of every membership', async () => {
    await betterAuthClient().user.delete({ where: { id: 'usr_1' } });
    expect(activity()).toEqual([false, false, true]);
    expect(mockDb.lockLog.sort()).toEqual(['mem_1', 'mem_2']);
  });

  it('nothing is revoked while no delete happens (a refused leave never deletes)', async () => {
    const client = betterAuthClient();
    await client.member.findUnique({ where: { id: 'mem_1' } });
    expect(activity()).toEqual([true, true, true]);
  });

  it('a failed delete rolls nothing forward: the member and its keys stay', async () => {
    await expect(
      betterAuthClient().member.delete({ where: { id: 'mem_missing' } }),
    ).rejects.toThrow(/P2025/);
    expect(activity()).toEqual([true, true, true]);
  });
});
