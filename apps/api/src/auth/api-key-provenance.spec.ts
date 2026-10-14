import { ForbiddenException } from '@nestjs/common';
import {
  resolveKeyProvenance,
  resolveOrganizationOwnedProvenance,
} from './api-key-provenance';

// Who a new API key belongs to. A key must always trace back to a member (so
// offboarding can revoke it) or be explicitly organization-owned; a null
// creator is never recorded for a new personal key.
describe('resolveKeyProvenance', () => {
  it('attributes a session-created key to the signed-in member', () => {
    expect(
      resolveKeyProvenance({ authType: 'session', memberId: 'mem_session' }),
    ).toEqual({ createdByMemberId: 'mem_session', organizationOwned: false });
  });

  it('attributes a key created through a personal API key to that key creator', () => {
    expect(
      resolveKeyProvenance({
        authType: 'api-key',
        apiKeyCreatedByMemberId: 'mem_creator',
        apiKeyOrganizationOwned: false,
      }),
    ).toEqual({ createdByMemberId: 'mem_creator', organizationOwned: false });
  });

  it('makes a key created through an organization-owned key organization-owned', () => {
    expect(
      resolveKeyProvenance({
        authType: 'api-key',
        apiKeyCreatedByMemberId: 'mem_creator',
        apiKeyOrganizationOwned: true,
      }),
    ).toEqual({ createdByMemberId: 'mem_creator', organizationOwned: true });
    expect(
      resolveKeyProvenance({
        authType: 'api-key',
        apiKeyCreatedByMemberId: null,
        apiKeyOrganizationOwned: true,
      }),
    ).toEqual({ createdByMemberId: null, organizationOwned: true });
  });

  it('refuses creation through a legacy key that has no recorded creator', () => {
    const create = () =>
      resolveKeyProvenance({
        authType: 'api-key',
        apiKeyCreatedByMemberId: null,
        apiKeyOrganizationOwned: false,
      });
    expect(create).toThrow(ForbiddenException);
    expect(create).toThrow(/signed-in session/);
  });

  it('attributes a service-token key to the acting member it names', () => {
    expect(
      resolveKeyProvenance({ authType: 'service', memberId: 'mem_acting' }),
    ).toEqual({ createdByMemberId: 'mem_acting', organizationOwned: false });
  });

  it('refuses creation when no member can be recorded as the creator', () => {
    expect(() => resolveKeyProvenance({ authType: 'service' })).toThrow(
      ForbiddenException,
    );
    expect(() => resolveKeyProvenance({ authType: 'session' })).toThrow(
      ForbiddenException,
    );
  });
});

// POST /v1/organization/api-keys with organizationOwned: true. Such a key
// deliberately outlives its creator, so only an owner may mint one.
describe('resolveOrganizationOwnedProvenance', () => {
  it('lets an owner session create one, attributed to the owner', () => {
    expect(
      resolveOrganizationOwnedProvenance({
        authType: 'session',
        memberId: 'mem_owner',
        userRoles: ['admin', ' owner'],
      }),
    ).toEqual({ createdByMemberId: 'mem_owner', organizationOwned: true });
  });

  it.each([[['admin']], [['auditor']], [['ci-bot']], [null]])(
    'refuses a session whose roles are %p',
    (userRoles) => {
      const create = () =>
        resolveOrganizationOwnedProvenance({
          authType: 'session',
          memberId: 'mem_1',
          userRoles,
        });
      expect(create).toThrow(ForbiddenException);
      expect(create).toThrow(/owner/);
    },
  );

  it('refuses an owner role without a member to attribute it to', () => {
    expect(() =>
      resolveOrganizationOwnedProvenance({
        authType: 'session',
        userRoles: ['owner'],
      }),
    ).toThrow(ForbiddenException);
  });

  it('refuses a personal API key and a service token', () => {
    expect(() =>
      resolveOrganizationOwnedProvenance({
        authType: 'api-key',
        apiKeyCreatedByMemberId: 'mem_owner',
        apiKeyOrganizationOwned: false,
      }),
    ).toThrow(ForbiddenException);
    expect(() =>
      resolveOrganizationOwnedProvenance({
        authType: 'service',
        memberId: 'mem_owner',
        userRoles: ['owner'],
      }),
    ).toThrow(ForbiddenException);
  });

  it('lets an organization-owned API key create one, as it would anyway', () => {
    expect(
      resolveOrganizationOwnedProvenance({
        authType: 'api-key',
        apiKeyCreatedByMemberId: 'mem_creator',
        apiKeyOrganizationOwned: true,
      }),
    ).toEqual({ createdByMemberId: 'mem_creator', organizationOwned: true });
  });
});
