-- Read-only review: active, unexpired API keys whose creator is missing or no
-- longer active. Run it before deploying migrations 20261013120000 and
-- 20261013120100, revoke what should not survive (Settings > API keys, or
-- POST /v1/organization/api-keys/revoke), and run it again afterwards.
--
--   psql "$DATABASE_URL" -f packages/db/prisma/review/api-keys-with-missing-or-inactive-creator.sql
--
-- It only reads (the transaction is READ ONLY and rolled back) and does not
-- depend on the new legacyCreatorless column, so it runs before and after the
-- migration.
--
-- creator_status:
--   missing     createdByMemberId is NULL. Either a legacy key from before
--               creator attribution, or a key whose creator's membership was
--               deleted (ON DELETE SET NULL); the database cannot tell them
--               apart, so each one needs a human decision.
--   deactivated the creator's membership is deactivated or inactive.
--   banned      the creator's user is banned.
-- accepted_before_fix: whether the pre-fix validation rule accepts the key
--   (organization-owned, or creatorless and created before 2026-10-06
--   06:35:57 UTC). Those are the keys migration 20261013120000 flags
--   legacyCreatorless and that keep authenticating after it.

BEGIN TRANSACTION READ ONLY;

SELECT
  k."id" AS api_key_id,
  k."name" AS api_key_name,
  k."keyPrefix" AS key_prefix,
  o."id" AS organization_id,
  o."name" AS organization_name,
  k."organizationOwned" AS organization_owned,
  CASE
    WHEN k."createdByMemberId" IS NULL THEN 'missing'
    WHEN m."deactivated" OR NOT m."isActive" THEN 'deactivated'
    ELSE 'banned'
  END AS creator_status,
  k."createdByMemberId" AS creator_member_id,
  u."email" AS creator_email,
  k."organizationOwned"
    OR (k."createdByMemberId" IS NULL
        AND k."createdAt" < TIMESTAMP '2026-10-06 06:35:57') AS accepted_before_fix,
  k."scopes" AS scopes,
  k."createdAt" AS created_at,
  k."lastUsedAt" AS last_used_at,
  k."expiresAt" AS expires_at
FROM "ApiKey" k
JOIN "Organization" o ON o."id" = k."organizationId"
LEFT JOIN "Member" m ON m."id" = k."createdByMemberId"
LEFT JOIN "User" u ON u."id" = m."userId"
WHERE k."isActive"
  AND (k."expiresAt" IS NULL OR k."expiresAt" > (now() AT TIME ZONE 'UTC'))
  AND (
    k."createdByMemberId" IS NULL
    OR m."deactivated"
    OR NOT m."isActive"
    OR u."banned" IS TRUE
  )
ORDER BY accepted_before_fix DESC, o."name", k."lastUsedAt" DESC NULLS LAST, k."id";

ROLLBACK;
