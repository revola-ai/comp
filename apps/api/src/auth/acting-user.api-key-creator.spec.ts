// Mock @db before importing the service so the Prisma client doesn't try
// to connect at import time in this unit-test env.
const mockDb = {
  member: {
    findFirst: jest.fn(),
  },
};

jest.mock('@db', () => ({ db: mockDb }));

import { UnauthorizedException } from '@nestjs/common';
import { ActingUserResolver } from './acting-user.service';
import type { AuthenticatedRequest } from './types';

function apiKeyReq(
  overrides: Partial<AuthenticatedRequest> = {},
): AuthenticatedRequest {
  return {
    organizationId: 'org_1',
    authType: 'api-key',
    isApiKey: true,
    isServiceToken: false,
    isPlatformAdmin: false,
    userRoles: null,
    userId: undefined,
    apiKeyId: 'apk_1',
    ...overrides,
  } as unknown as AuthenticatedRequest;
}

describe('ActingUserResolver - API key with a recorded creator', () => {
  let resolver: ActingUserResolver;

  beforeEach(() => {
    jest.clearAllMocks();
    resolver = new ActingUserResolver();
  });

  it("attributes to the creating member's user (source api-key-creator)", async () => {
    mockDb.member.findFirst.mockResolvedValueOnce({
      userId: 'usr_creator_dave',
    });

    const result = await resolver.resolve(
      apiKeyReq({
        apiKeyName: 'Mariano CLI',
        apiKeyCreatedByMemberId: 'mem_creator',
      }),
      'org_1',
    );

    expect(result.userId).toBe('usr_creator_dave');
    expect(result.memberId).toBe('mem_creator');
    expect(result.source).toBe('api-key-creator');
    expect(result.callerLabel).toBe('via API key "Mariano CLI"');
    // Single lookup: the creator, scoped to the org + active membership.
    expect(mockDb.member.findFirst).toHaveBeenCalledTimes(1);
    expect(mockDb.member.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'mem_creator',
          organizationId: 'org_1',
          deactivated: false,
          isActive: true,
        }),
      }),
    );
  });

  it('rejects a personal key whose creator is no longer an active member, without an owner fallback', async () => {
    mockDb.member.findFirst.mockResolvedValueOnce(null);

    await expect(
      resolver.resolve(
        apiKeyReq({
          apiKeyName: 'Old Key',
          apiKeyCreatedByMemberId: 'mem_offboarded',
          apiKeyOrganizationOwned: false,
        }),
        'org_1',
      ),
    ).rejects.toThrow(UnauthorizedException);
    // Only the creator lookup ran; the owner was never consulted.
    expect(mockDb.member.findFirst).toHaveBeenCalledTimes(1);
  });

  it('treats a key without the organization-owned flag as personal', async () => {
    mockDb.member.findFirst.mockResolvedValueOnce(null);

    await expect(
      resolver.resolve(
        apiKeyReq({ apiKeyCreatedByMemberId: 'mem_offboarded' }),
        'org_1',
      ),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('falls back to the org owner for an organization-owned key whose creator left', async () => {
    // 1st findFirst = creator lookup (null), 2nd = owner fallback.
    mockDb.member.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'mem_owner', userId: 'usr_owner_carol' });

    const result = await resolver.resolve(
      apiKeyReq({
        apiKeyName: 'Shared CI',
        apiKeyCreatedByMemberId: 'mem_offboarded',
        apiKeyOrganizationOwned: true,
      }),
      'org_1',
    );

    expect(result.userId).toBe('usr_owner_carol');
    expect(result.memberId).toBe('mem_owner');
    expect(result.source).toBe('org-owner-fallback');
    expect(mockDb.member.findFirst).toHaveBeenCalledTimes(2);
  });

  it('keeps the owner fallback for legacy keys with no recorded creator', async () => {
    mockDb.member.findFirst.mockResolvedValueOnce({
      id: 'mem_owner',
      userId: 'usr_owner',
    });

    const result = await resolver.resolve(
      apiKeyReq({ apiKeyName: 'Legacy', apiKeyCreatedByMemberId: null }),
      'org_1',
    );

    expect(result.userId).toBe('usr_owner');
    expect(result.source).toBe('org-owner-fallback');
    expect(mockDb.member.findFirst).toHaveBeenCalledTimes(1);
  });
});
