# Production review queries

Read-only SQL to run by hand against the production database with `psql`.
Each file runs in a `READ ONLY` transaction that is rolled back; any statement that changes data is commented out for you to run deliberately, in a separate session.
Laptops share the production database (D7), so these read production wherever you run them.

Use a plain `postgres://` connection string that `psql` accepts, connected as `postgres` (the direct or session-pooler URL, without Prisma-only parameters such as `pgbouncer` or `connection_limit`).

## When to run each file

| File | When |
| --- | --- |
| `pre-deploy-checklist.sql` | Before applying migrations `20261013120000` to `20261013130000`, and again before the first deploy of the API. |
| `api-keys-with-missing-or-inactive-creator.sql` | Before applying migrations `20261013120000` and `20261013120100`, and again afterwards. The checklist includes it as its section (d), so run it on its own only to re-check API keys. |

## pre-deploy-checklist.sql

```bash
psql "$DATABASE_URL" -v gram_client_id="$GRAM_OAUTH_CLIENT_ID" \
  -f packages/db/prisma/review/pre-deploy-checklist.sql
```

`gram_client_id` is production's `GRAM_OAUTH_CLIENT_ID`; the file stops if it is not set.
Run it from the repository root or anywhere else: it includes the API-key review by a path relative to itself (`\ir`).

- (a) Gram's OAuth client row against the expected client id, and its redirect URLs.
- (b) Every other OAuth client and the tokens issued to it (self-registered while registration was open), with the `DELETE` statements to remove them commented out.
- (c) Row-level security of every table in `public`, and the privileges `anon`, `authenticated` and `PUBLIC` hold on its tables and functions.
  If the Supabase Data API is enabled, lock these down before the first deploy (the file says how).
- (d) API keys whose creator is missing or no longer active (`api-keys-with-missing-or-inactive-creator.sql`).

## api-keys-with-missing-or-inactive-creator.sql

```bash
psql "$DATABASE_URL" -f packages/db/prisma/review/api-keys-with-missing-or-inactive-creator.sql
```

Revoke what should not survive (Settings > API keys, or `POST /v1/organization/api-keys/revoke`), then run it again.

`apps/api/src/auth/pre-deploy-checklist.spec.ts` runs both files on PGlite against the migrated tables, so a syntax or column error fails the API tests instead of showing up in front of production.
