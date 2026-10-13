-- Revoke personal API keys in the database whenever their creator loses
-- access, whatever code makes the change. Production shares this database
-- with developer laptops that may run an older API (one without the
-- application-level revocation, or whose better-auth client deletes users
-- through a model name it does not intercept), and with scripts and psql. The
-- application still revokes first, inside its own transaction; these
-- triggers make that a guarantee rather than a convention.
--
-- A personal key ("organizationOwned" = false) is revoked ("isActive" = false)
-- when its creator's membership:
--   * is deleted, directly or through the User / Organization cascades
--     (BEFORE DELETE, so it runs before ON DELETE SET NULL clears
--     "createdByMemberId");
--   * is deactivated or marked inactive;
--   * loses any role (comma-separated "role"; adding a role or reordering
--     roles keeps the keys, because permissions are the union of the roles);
-- or when the creator's user is banned.
-- Revocation is never undone: reactivating, re-adding a role or unbanning
-- leaves revoked keys revoked. Organization-owned keys are never touched.
--
-- Backward compatible: no schema change; older code keeps working and simply
-- sees its member's personal keys revoked at the same moments the current
-- code revokes them.

CREATE OR REPLACE FUNCTION api_key_revoke_personal_keys(member_ids TEXT[])
RETURNS VOID AS $$
  UPDATE "ApiKey"
  SET "isActive" = false
  WHERE "createdByMemberId" = ANY(member_ids)
    AND "organizationOwned" = false
    AND "isActive" = true;
$$ LANGUAGE sql;

-- Whether some role in old_roles is missing from new_roles.
CREATE OR REPLACE FUNCTION api_key_member_roles_removed(old_roles TEXT, new_roles TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT btrim(role) FROM unnest(string_to_array(old_roles, ',')) AS role
    WHERE btrim(role) <> ''
    EXCEPT
    SELECT btrim(role) FROM unnest(string_to_array(coalesce(new_roles, ''), ',')) AS role
  );
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION api_key_revoke_on_member_delete()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM api_key_revoke_personal_keys(ARRAY[OLD."id"]);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION api_key_revoke_on_member_access_loss()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM api_key_revoke_personal_keys(ARRAY[NEW."id"]);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION api_key_revoke_on_user_ban()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM api_key_revoke_personal_keys(
    ARRAY(SELECT "id" FROM "Member" WHERE "userId" = NEW."id")
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Member_revoke_api_keys_on_delete"
BEFORE DELETE ON "Member"
FOR EACH ROW
EXECUTE FUNCTION api_key_revoke_on_member_delete();

CREATE TRIGGER "Member_revoke_api_keys_on_access_loss"
AFTER UPDATE OF "isActive", "deactivated", "role" ON "Member"
FOR EACH ROW
WHEN (
  NEW."deactivated"
  OR NOT NEW."isActive"
  OR api_key_member_roles_removed(OLD."role", NEW."role")
)
EXECUTE FUNCTION api_key_revoke_on_member_access_loss();

CREATE TRIGGER "User_revoke_api_keys_on_ban"
AFTER UPDATE OF "banned" ON "User"
FOR EACH ROW
WHEN (NEW."banned" IS TRUE)
EXECUTE FUNCTION api_key_revoke_on_user_ban();
