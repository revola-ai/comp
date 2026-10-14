import {
  API_KEY_MIGRATIONS,
  API_KEY_TABLES,
  migrationSql,
  runSqlScenarios,
  type ScenarioResult,
} from '../../test/api-key-migrations';

// The functions behind the API-key revocation triggers must not be callable
// by roles that merely exist (PUBLIC, and Supabase's anon and authenticated,
// which PostgREST exposes), and must not resolve names through a caller's
// search_path. Firing the triggers needs no EXECUTE grant, so a role allowed
// to delete a member still revokes that member's keys.

const SEED = `
INSERT INTO "Organization" ("id", "name") VALUES ('org_1', 'One');
INSERT INTO "User" ("id", "email") VALUES ('usr_a', 'a@example.com');
INSERT INTO "Member" ("id", "organizationId", "userId", "role")
  VALUES ('mem_a', 'org_1', 'usr_a', 'admin');
INSERT INTO "ApiKey" ("id", "name", "key", "organizationId", "createdByMemberId")
  VALUES ('k_a', 'a', 'h1', 'org_1', 'mem_a');
`;

/** Supabase's API roles, with its default EXECUTE grant on new functions. */
const SUPABASE_ROLES = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
`;

const FUNCTIONS = `
SELECT p.proname AS name, p.proconfig AS config,
  has_function_privilege('outsider', p.oid, 'EXECUTE') AS outsider_can_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname LIKE 'api_key_%'
ORDER BY p.proname`;

const asOutsider = (statement: string) => [
  'CREATE ROLE outsider NOLOGIN',
  'GRANT USAGE ON SCHEMA public TO outsider',
  'SET LOCAL ROLE outsider',
  statement,
];

const TRIGGER_FUNCTIONS = [
  'api_key_revoke_on_member_access_loss',
  'api_key_revoke_on_member_delete',
  'api_key_revoke_on_user_ban',
];

function run({ withSupabaseRoles }: { withSupabaseRoles: boolean }) {
  return runSqlScenarios({
    setup: [
      API_KEY_TABLES,
      SEED,
      ...(withSupabaseRoles ? [SUPABASE_ROLES] : []),
      ...API_KEY_MIGRATIONS.map(migrationSql),
    ],
    scenarios: {
      functions: ['CREATE ROLE outsider NOLOGIN', FUNCTIONS],
      callDirectly: asOutsider('SELECT api_key_revoke_on_user_ban()'),
      supabaseRoles: [
        `SELECT bool_or(has_function_privilege(r.rolname, p.oid, 'EXECUTE')) AS any
         FROM pg_proc p CROSS JOIN pg_roles r
         WHERE p.proname LIKE 'api_key_%'
           AND r.rolname IN ('anon', 'authenticated')`,
      ],
      deleteAsWriter: [
        'CREATE ROLE writer NOLOGIN',
        'GRANT USAGE ON SCHEMA public TO writer',
        'GRANT SELECT, UPDATE, DELETE ON "Member", "ApiKey" TO writer',
        'SET LOCAL ROLE writer',
        `DELETE FROM "Member" WHERE "id" = 'mem_a'`,
        'RESET ROLE',
        `SELECT "isActive" FROM "ApiKey" WHERE "id" = 'k_a'`,
      ],
    },
  });
}

describe('API-key trigger functions in Postgres', () => {
  let plain: Record<string, ScenarioResult>;
  let supabase: Record<string, ScenarioResult>;

  beforeAll(() => {
    plain = run({ withSupabaseRoles: false });
    supabase = run({ withSupabaseRoles: true });
  }, 120_000);

  const rows = (results: Record<string, ScenarioResult>, name: string) => {
    const result = results[name];
    if (result.error) throw new Error(`${name}: ${result.error}`);
    return result.rows ?? [];
  };

  it('leaves only the trigger functions, each with a pinned search_path and no PUBLIC EXECUTE', () => {
    expect(rows(plain, 'functions')).toEqual(
      TRIGGER_FUNCTIONS.map((name) => ({
        name,
        config: ['search_path=public, pg_temp'],
        outsider_can_execute: false,
      })),
    );
  });

  it('refuses a role without grants that calls one directly', () => {
    expect(plain.callDirectly.error).toMatch(/permission denied for function/);
  });

  it('revokes EXECUTE from Supabase anon and authenticated when they exist', () => {
    expect(rows(supabase, 'supabaseRoles')).toEqual([{ any: false }]);
    expect(rows(supabase, 'functions')).toHaveLength(3);
  });

  it('still revokes keys when a role allowed to delete members does so', () => {
    expect(rows(plain, 'deleteAsWriter')).toEqual([{ isActive: false }]);
  });
});
