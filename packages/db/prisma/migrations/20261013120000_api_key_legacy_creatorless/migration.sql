-- Record which creatorless personal API keys are genuinely legacy, so
-- validation stops inferring it from createdAt.
--
-- Before this migration a personal key without createdByMemberId was accepted
-- whenever it was created before 2026-10-06 06:35:57 UTC (the
-- organizationOwned migration). A key whose creator's membership was deleted
-- also ends up with createdByMemberId NULL (ON DELETE SET NULL), so a
-- pre-cutoff key whose creator left was accepted forever.
--
-- The backfill flags exactly the keys the old rule accepts today: personal,
-- creatorless, created before that cutoff. From here on nothing sets the flag,
-- so a key orphaned later is refused even if it is old. Review the flagged
-- keys before deploying (packages/db/prisma/review/api-keys-with-missing-or-inactive-creator.sql).
--
-- Backward compatible: additive column with a default; code that does not
-- know it ignores it, and keys created by such code get false (they always
-- record their creator).

-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN "legacyCreatorless" BOOLEAN NOT NULL DEFAULT false;

-- Backfill
UPDATE "ApiKey"
SET "legacyCreatorless" = true
WHERE "createdByMemberId" IS NULL
  AND "organizationOwned" = false
  AND "createdAt" < TIMESTAMP '2026-10-06 06:35:57';
