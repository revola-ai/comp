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
// checked in the source, and removals are replayed as better-auth's Prisma
// adapter performs them (@better-auth/prisma-adapter 1.6.23): leave and
// remove-member reach `db.member.delete` (the organization plugin's default
// model name), admin remove-user reaches `db.User.delete` (user.modelName),
// both on the client passed to prismaAdapter. better-auth's own refusals (a
// sole owner leaving) happen before that call and never reach the client.
describe('auth.server wiring for API-key offboarding', () => {
  const source = readFileSync(resolve(__dirname, 'auth.server.ts'), 'utf8');

  it('hands better-auth the client whose member and user deletes revoke keys', () => {
    expect(source).toMatch(/prismaAdapter\(withApiKeyRevokingDeletes\(db\)/);
  });

  it('names the User model the remove-user replay below deletes through', () => {
    expect(source).toMatch(/\n {2}user: \{\n {4}modelName: 'User',/);
  });

  it('revokes nothing in hooks that run before better-auth decides to delete', () => {
    expect(source).not.toMatch(/apiKeyOffboardingBeforeHook/);
    expect(source).not.toMatch(/beforeRemoveMember/);
    expect(source).not.toMatch(/revokeApiKeysBefore/);
  });
});

type AdapterDelegate = {
  delete: (args: { where: { id: string } }) => Promise<unknown>;
};

/** better-auth's adapter call `db[model].delete(...)` on the wrapped client. */
function adapterDelete({ model, id }: { model: string; id: string }) {
  const client = withApiKeyRevokingDeletes(mockDb as unknown as PrismaClient);
  const delegate: AdapterDelegate = Reflect.get(client, model);
  return delegate.delete({ where: { id } });
}

describe('better-auth removals on the wrapped client', () => {
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

  it('a leave revokes the leaver keys together with the membership', async () => {
    await adapterDelete({ model: 'member', id: 'mem_owner' });
    expect(mockDb.members.has('mem_owner')).toBe(false);
    expect(mockDb.keys.map((key) => key.isActive)).toEqual([false]);
  });

  it('a leave the database refuses after revoking keeps the leaver keys working', async () => {
    mockDb.failNext({
      operation: 'member.delete',
      error: new Error('P2003: foreign key constraint failed'),
    });
    await expect(
      adapterDelete({ model: 'member', id: 'mem_owner' }),
    ).rejects.toThrow(/P2003/);
    expect(mockDb.members.has('mem_owner')).toBe(true);
    expect(mockDb.usableKeysOf('mem_owner')).toHaveLength(1);
  });

  it('a remove-user the database refuses after revoking keeps the user keys working', async () => {
    mockDb.failNext({
      operation: 'user.delete',
      error: new Error('P2003: foreign key constraint failed'),
    });
    await expect(
      adapterDelete({ model: 'User', id: 'usr_owner' }),
    ).rejects.toThrow(/P2003/);
    expect(mockDb.users.has('usr_owner')).toBe(true);
    expect(mockDb.usableKeysOf('mem_owner')).toHaveLength(1);
  });
});
