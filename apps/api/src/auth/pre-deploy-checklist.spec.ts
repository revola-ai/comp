import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  API_KEY_MIGRATIONS,
  API_KEY_TABLES,
  migrationSql,
  runSqlScenarios,
} from '../../test/api-key-migrations';

// packages/db/prisma/review/pre-deploy-checklist.sql is run by hand with psql
// against the production database before the API-key migrations and the
// first deploy. This runs it on PGlite against the migrated tables it reads,
// with Supabase's anon and authenticated roles, so a syntax or column error
// shows here and not in front of production.

const REVIEW = resolve(__dirname, '../../../../packages/db/prisma/review');
const CHECKLIST = readFileSync(
  resolve(REVIEW, 'pre-deploy-checklist.sql'),
  'utf8',
);
const API_KEY_REVIEW = readFileSync(
  resolve(REVIEW, 'api-keys-with-missing-or-inactive-creator.sql'),
  'utf8',
);
const GRAM = 'gram-client-id';

/** Drops psql meta-commands (\set, \if, \ir...) and fills in :'gram_client_id'. */
function forPglite(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('\\'))
    .join('\n')
    .replaceAll(":'gram_client_id'", `'${GRAM}'`);
}

/** The file's statements, without comments and psql meta-commands. */
function statements(sql: string): string[] {
  const code = forPglite(sql)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  return code
    .split(/;\s*\n/)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** Each statement that follows a `-- check: <name>` line, by name. */
function checks(sql: string): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  let name: string | null = null;
  let lines: string[] = [];
  for (const line of forPglite(sql).split('\n')) {
    const marker = /^-- check: (\S+)/.exec(line);
    if (marker) {
      name = marker[1];
      lines = [];
      continue;
    }
    if (name === null || line.trimStart().startsWith('--')) continue;
    lines.push(line);
    if (line.trimEnd().endsWith(';')) {
      found[name] = [lines.join('\n')];
      name = null;
    }
  }
  return found;
}

const OAUTH_TABLES = migrationSql('20260528213310_add_oauth_provider_tables');
const PREFIXED_CUID = `
CREATE FUNCTION generate_prefixed_cuid(prefix text) RETURNS text
  LANGUAGE sql AS $$ SELECT prefix || '_' || md5(random()::text) $$;`;

/** Supabase's API roles, one table granted to anon and one table under RLS. */
const SUPABASE = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
GRANT SELECT ON "Organization" TO anon;
GRANT SELECT, INSERT ON "oauth_application" TO authenticated;
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;`;

const SEED = `
INSERT INTO "User" ("id", "email") VALUES ('usr_a', 'a@example.com');
INSERT INTO "oauth_application"
  ("id", "name", "clientId", "redirectUrls", "type", "updatedAt")
VALUES
  ('oap_gram', 'Comp AI MCP (Gram)', '${GRAM}',
   'https://gram.example/oauth/callback', 'web', now()),
  ('oap_stray', 'Self-registered', 'stray-client',
   'https://stray.example/cb,https://stray.example/cb2', 'web', now());
UPDATE "oauth_application" SET "userId" = 'usr_a' WHERE "id" = 'oap_stray';
INSERT INTO "oauth_access_token" ("id", "accessToken", "refreshToken",
  "accessTokenExpiresAt", "refreshTokenExpiresAt", "clientId", "userId",
  "scopes", "updatedAt")
VALUES
  ('oat_1', 'at-1', 'rt-1', now() + interval '1 hour',
   now() + interval '30 days', 'stray-client', 'usr_a', 'openid', now()),
  ('oat_2', 'at-2', 'rt-2', now() + interval '1 hour',
   now() + interval '30 days', '${GRAM}', 'usr_a', 'openid', now());`;

describe('pre-deploy-checklist.sql', () => {
  it('only reads: one READ ONLY transaction, rolled back, with every write commented out', () => {
    const all = statements(CHECKLIST);
    expect(all[0]).toBe('BEGIN TRANSACTION READ ONLY');
    expect(all[all.length - 1]).toBe('ROLLBACK');
    for (const statement of all.slice(1, -1)) {
      expect(statement).toMatch(/^SELECT\b/);
    }
  });

  it('includes the API-key review after its own transaction', () => {
    const includes = CHECKLIST.split('\n').filter((line) =>
      line.startsWith('\\ir '),
    );
    expect(includes).toEqual([
      '\\ir api-keys-with-missing-or-inactive-creator.sql',
    ]);
    expect(CHECKLIST.indexOf('\\ir ')).toBeGreaterThan(
      CHECKLIST.lastIndexOf('ROLLBACK;'),
    );
  });

  describe('on the migrated schema', () => {
    // Setup runs the whole file and the API-key review it includes, so a
    // syntax error anywhere fails here.
    const results = runSqlScenarios({
      setup: [
        PREFIXED_CUID,
        API_KEY_TABLES,
        OAUTH_TABLES,
        ...API_KEY_MIGRATIONS.map(migrationSql),
        SUPABASE,
        SEED,
        forPglite(CHECKLIST),
        API_KEY_REVIEW,
      ],
      scenarios: checks(CHECKLIST),
    });
    const rows = (name: string) => results[name]?.rows ?? [];

    it('runs every check without an error', () => {
      expect(Object.keys(results).sort()).toEqual([
        'api_role_function_privileges',
        'api_role_table_privileges',
        'gram_application',
        'other_access_tokens',
        'other_applications',
        'row_level_security',
      ]);
      for (const result of Object.values(results)) {
        expect(result.error).toBeUndefined();
      }
    });

    it("(a) shows Gram's row by the expected client id, never its secret", () => {
      expect(rows('gram_application')).toEqual([
        expect.objectContaining({
          client_id: GRAM,
          name: 'Comp AI MCP (Gram)',
          redirect_urls: 'https://gram.example/oauth/callback',
          several_redirect_urls: false,
          access_tokens: 1,
        }),
      ]);
      expect(JSON.stringify(results)).not.toContain('clientSecret');
    });

    it('(b) lists every other application and its tokens, never token values', () => {
      expect(rows('other_applications')).toEqual([
        expect.objectContaining({
          id: 'oap_stray',
          owner_email: 'a@example.com',
          access_tokens: 1,
          live_refresh_tokens: 1,
        }),
      ]);
      expect(rows('other_access_tokens')).toEqual([
        expect.objectContaining({ id: 'oat_1', refresh_token_live: true }),
      ]);
      expect(JSON.stringify(results)).not.toMatch(/"(at|rt)-\d"/);
    });

    it('(c) reports row-level security per public table', () => {
      const rls = Object.fromEntries(
        rows('row_level_security').map((row) => [row.table_name, row]),
      );
      expect(rls.User).toMatchObject({ rls_enabled: true, policies: 0 });
      expect(rls.ApiKey).toMatchObject({ rls_enabled: false });
      expect(rls.oauth_application).toMatchObject({ rls_enabled: false });
    });

    it('(c) lists what anon, authenticated and PUBLIC hold on tables and functions', () => {
      expect(rows('api_role_table_privileges')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            grantee: 'anon',
            table_name: 'Organization',
            privileges: 'SELECT',
          }),
          expect.objectContaining({
            grantee: 'authenticated',
            table_name: 'oauth_application',
            privileges: 'INSERT, SELECT',
          }),
        ]),
      );
      const functions = rows('api_role_function_privileges');
      expect(functions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            grantee: 'PUBLIC',
            function_name: 'generate_prefixed_cuid',
          }),
        ]),
      );
      // The API-key trigger functions are locked down by their migrations.
      expect(
        functions.filter((row) =>
          String(row.function_name).startsWith('api_key_'),
        ),
      ).toEqual([]);
    });
  });
});
