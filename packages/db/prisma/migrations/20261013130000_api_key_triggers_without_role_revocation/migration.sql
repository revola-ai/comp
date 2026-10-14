-- Replaces the API-key revocation triggers of 20261013120100.
--
-- 1. Role changes no longer revoke personal API keys. Revoking on any lost
--    role fired on promotions too (admin to owner drops "admin") and was
--    permanent. The API now bounds a personal key, at every use, by its
--    creator's current roles, so a demotion or a custom-role edit narrows the
--    key at once without revoking it. Personal keys are still revoked when
--    their creator's membership is deleted, deactivated or marked inactive,
--    or the creator's user is banned.
--
-- 2. The trigger functions are locked down: no EXECUTE for PUBLIC (nor for
--    Supabase's anon and authenticated roles, which PostgREST exposes, where
--    they exist; local and test databases have no such roles), and a pinned
--    search_path, so no caller's schema can shadow "ApiKey" or "Member".
--    Firing a trigger needs no EXECUTE grant on its function, so every write
--    that could fire them before still does. The helper functions
--    api_key_revoke_personal_keys and api_key_member_roles_removed are
--    dropped: each trigger function now does its own UPDATE, so nothing
--    callable outside a trigger is left.
--
-- Backward compatible: no schema change. An older API build (on a laptop
-- sharing this database) may still revoke on role changes in its own code;
-- the database no longer does.

DROP TRIGGER IF EXISTS "Member_revoke_api_keys_on_access_loss" ON "Member";

CREATE OR REPLACE FUNCTION api_key_revoke_on_member_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE "ApiKey"
  SET "isActive" = false
  WHERE "createdByMemberId" = OLD."id"
    AND "organizationOwned" = false
    AND "isActive" = true;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION api_key_revoke_on_member_access_loss()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE "ApiKey"
  SET "isActive" = false
  WHERE "createdByMemberId" = NEW."id"
    AND "organizationOwned" = false
    AND "isActive" = true;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION api_key_revoke_on_user_ban()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE "ApiKey"
  SET "isActive" = false
  WHERE "createdByMemberId" IN (
      SELECT "id" FROM "Member" WHERE "userId" = NEW."id"
    )
    AND "organizationOwned" = false
    AND "isActive" = true;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "Member_revoke_api_keys_on_access_loss"
AFTER UPDATE OF "isActive", "deactivated" ON "Member"
FOR EACH ROW
WHEN (NEW."deactivated" OR NOT NEW."isActive")
EXECUTE FUNCTION api_key_revoke_on_member_access_loss();

DROP FUNCTION IF EXISTS api_key_member_roles_removed(TEXT, TEXT);
DROP FUNCTION IF EXISTS api_key_revoke_personal_keys(TEXT[]);

REVOKE ALL ON FUNCTION api_key_revoke_on_member_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION api_key_revoke_on_member_access_loss() FROM PUBLIC;
REVOKE ALL ON FUNCTION api_key_revoke_on_user_ban() FROM PUBLIC;

DO $$
DECLARE
  api_role TEXT;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION api_key_revoke_on_member_delete(), '
        'api_key_revoke_on_member_access_loss(), api_key_revoke_on_user_ban() '
        'FROM %I',
        api_role
      );
    END IF;
  END LOOP;
END;
$$;
