-- The User, Organization, Member and ApiKey columns and foreign keys the
-- API-key migrations and triggers touch, as packages/db/prisma/migrations
-- defines them up to 20261006063557 (init, add_api_key_creator,
-- api_key_organization_owned). Used by api-key-revocation-triggers.spec.ts.

CREATE TABLE "User" (
  "id" TEXT PRIMARY KEY,
  "email" TEXT NOT NULL,
  "banned" BOOLEAN
);

CREATE TABLE "Organization" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL
);

CREATE TABLE "Member" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "department" TEXT NOT NULL DEFAULT 'none',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "deactivated" BOOLEAN NOT NULL DEFAULT false
);

ALTER TABLE "Member" ADD CONSTRAINT "Member_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Member" ADD CONSTRAINT "Member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ApiKey" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "keyPrefix" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3),
  "lastUsedAt" TIMESTAMP(3),
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "organizationId" TEXT NOT NULL,
  "createdByMemberId" TEXT,
  "organizationOwned" BOOLEAN NOT NULL DEFAULT false
);

ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_createdByMemberId_fkey" FOREIGN KEY ("createdByMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;
