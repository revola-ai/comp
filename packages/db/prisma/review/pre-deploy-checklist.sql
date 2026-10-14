-- Read-only pre-deploy checklist for the production database. Run it before
-- applying migrations 20261013120000 to 20261013130000 and before the first
-- deploy (see README.md in this folder), read every section, act on what it
-- shows, and run it again afterwards.
--
--   psql "$DATABASE_URL" -v gram_client_id="$GRAM_OAUTH_CLIENT_ID" \
--     -f packages/db/prisma/review/pre-deploy-checklist.sql
--
-- gram_client_id is the client id production's GRAM_OAUTH_CLIENT_ID holds.
-- Use a plain postgres:// URL that psql accepts (no Prisma-only parameters
-- such as pgbouncer or connection_limit), connected as postgres.
--
-- Sections (a) to (c) run in one READ ONLY transaction that is rolled back;
-- section (d) runs the API-key review, in its own read-only transaction.
-- The statements that change anything are commented out: run them yourself,
-- deliberately, in a separate session once you have decided.
-- It never selects a client secret or a token value.

\set ON_ERROR_STOP on
\if :{?gram_client_id}
\else
  \echo 'Set the expected Gram client id: psql -v gram_client_id=<GRAM_OAUTH_CLIENT_ID> ...'
  \quit
\endif

BEGIN TRANSACTION READ ONLY;

-- (a) Gram's OAuth client.
-- Only the production deployment writes this row, at boot, from GRAM_OAUTH_*
-- (apps/api/src/auth/gram-mcp-client-sync.service.ts). Expected after the
-- first deploy: exactly one row, client_id = gram_client_id, name
-- 'Comp AI MCP (Gram)', type 'web', disabled false, no owner_user_id, and
-- redirect_urls exactly production's GRAM_OAUTH_REDIRECT_URI (one URL).
-- Before the first deploy no row, or a row a previous boot wrote, is fine;
-- the deploy brings it back to GRAM_OAUTH_*. A row named like Gram's under
-- another client id was written by some other environment (a laptop shares
-- this database, D7): review it in (b).
-- check: gram_application
SELECT
  a.id,
  a.name,
  a."clientId" AS client_id,
  a.type,
  a.disabled,
  a."userId" AS owner_user_id,
  a."redirectUrls" AS redirect_urls,
  position(',' IN a."redirectUrls") > 0 AS several_redirect_urls,
  a."clientSecret" IS NOT NULL AS has_secret,
  (SELECT count(*)::int FROM "oauth_access_token" t
    WHERE t."clientId" = a."clientId") AS access_tokens,
  a."createdAt" AS created_at,
  a."updatedAt" AS updated_at
FROM "oauth_application" a
WHERE a."clientId" = :'gram_client_id' OR a.name = 'Comp AI MCP (Gram)'
ORDER BY a."clientId" = :'gram_client_id' DESC, a."createdAt";

-- (b) Every other OAuth client, and the tokens issued to it.
-- Client registration (/mcp/register) was open before it was refused
-- (apps/api/src/auth/gram-mcp-oauth.ts), so anyone could have registered a
-- client and obtained tokens for users who approved it. Gram is the only
-- intended client: every row here needs a decision.
-- check: other_applications
SELECT
  a.id,
  a.name,
  a."clientId" AS client_id,
  a.type,
  a.disabled,
  a."userId" AS owner_user_id,
  u.email AS owner_email,
  a."redirectUrls" AS redirect_urls,
  count(t.id)::int AS access_tokens,
  (count(t.id) FILTER (
    WHERE t."refreshTokenExpiresAt" > (now() AT TIME ZONE 'UTC')))::int
    AS live_refresh_tokens,
  (SELECT count(*)::int FROM "oauth_consent" c
    WHERE c."clientId" = a."clientId") AS consents,
  a."createdAt" AS created_at
FROM "oauth_application" a
LEFT JOIN "User" u ON u.id = a."userId"
LEFT JOIN "oauth_access_token" t ON t."clientId" = a."clientId"
WHERE a."clientId" <> :'gram_client_id'
GROUP BY a.id, u.email
ORDER BY a."createdAt", a.id;

-- check: other_access_tokens
SELECT
  t.id,
  t."clientId" AS client_id,
  a.name AS application_name,
  t."userId" AS user_id,
  u.email AS user_email,
  t.scopes,
  t."createdAt" AS created_at,
  t."accessTokenExpiresAt" AS access_token_expires_at,
  t."refreshTokenExpiresAt" AS refresh_token_expires_at,
  t."refreshTokenExpiresAt" > (now() AT TIME ZONE 'UTC') AS refresh_token_live
FROM "oauth_access_token" t
JOIN "oauth_application" a ON a."clientId" = t."clientId"
LEFT JOIN "User" u ON u.id = t."userId"
WHERE t."clientId" <> :'gram_client_id'
ORDER BY t."createdAt", t.id;

-- To remove the clients you decided against, in a separate psql session
-- (deleting a client also deletes its oauth_access_token and oauth_consent
-- rows: ON DELETE CASCADE), either by id:
--   BEGIN;
--   DELETE FROM "oauth_application" WHERE id IN ('oap_...', 'oap_...');
--   COMMIT;
-- or every client except Gram's:
--   BEGIN;
--   DELETE FROM "oauth_application" WHERE "clientId" <> :'gram_client_id';
--   COMMIT;

-- (c) Row-level security and what Supabase's API roles hold.
-- If the Supabase Data API (PostgREST) is enabled for this project
-- (Dashboard > Project Settings > Data API, schema public exposed), anyone
-- with the anon key, which is public by design, reaches through it every
-- public table and function that anon or authenticated may use and that RLS
-- does not stop: User, Session, ApiKey and oauth_* included. The API does not
-- use the Data API, so then lock it down before the first deploy: disable the
-- Data API or stop exposing public, or revoke the grants (and the default
-- privileges that hand them to new tables) and enable RLS on every table.
-- Every role belongs to PUBLIC, so a PUBLIC grant counts for anon too.
-- Without the anon and authenticated roles (not Supabase), only PUBLIC shows.
-- check: row_level_security
SELECT
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  c.relforcerowsecurity AS rls_forced,
  (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
ORDER BY c.relrowsecurity, c.relname;

-- From the catalog ACLs rather than information_schema.role_table_grants and
-- routine_privileges, which only show grants whose grantor or grantee is a
-- role this session holds.
-- check: api_role_table_privileges
SELECT
  CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE r.rolname END AS grantee,
  c.relname AS table_name,
  c.relkind AS kind,
  string_agg(acl.privilege_type, ', ' ORDER BY acl.privilege_type)
    AS privileges,
  c.relrowsecurity AS rls_enabled
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
LEFT JOIN pg_roles r ON r.oid = acl.grantee
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND (acl.grantee = 0 OR r.rolname IN ('anon', 'authenticated'))
GROUP BY 1, c.relname, c.relkind, c.relrowsecurity
ORDER BY c.relname, 1;

-- check: api_role_function_privileges
SELECT
  CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE r.rolname END AS grantee,
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS arguments,
  p.prosecdef AS security_definer
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
LEFT JOIN pg_roles r ON r.oid = acl.grantee
WHERE n.nspname = 'public'
  AND acl.privilege_type = 'EXECUTE'
  AND (acl.grantee = 0 OR r.rolname IN ('anon', 'authenticated'))
ORDER BY p.proname, 3, 1;

-- Lockdown, if the Data API is enabled and you keep it (separate session,
-- as postgres; the API connects as the tables' owner and is unaffected):
--   BEGIN;
--   REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon, authenticated;
--   REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;
--   REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--     REVOKE ALL ON TABLES FROM anon, authenticated;
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--     REVOKE ALL ON SEQUENCES FROM anon, authenticated;
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--     REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
--   COMMIT;
-- and, table by table, ALTER TABLE "<table>" ENABLE ROW LEVEL SECURITY;

ROLLBACK;

-- (d) API keys whose creator is missing or no longer active: the existing
-- review (api-keys-with-missing-or-inactive-creator.sql, which explains its
-- columns), run before migration 20261013120000 flags the legacy ones.
\ir api-keys-with-missing-or-inactive-creator.sql
