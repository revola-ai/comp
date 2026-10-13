import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  API_KEY_MIGRATIONS,
  API_KEY_TABLES,
  migrationSql,
  runSqlScenarios,
  type ScenarioResult,
} from '../../test/api-key-migrations';

// The API-key migrations run against a real (in-memory, PGlite) Postgres: the
// legacyCreatorless backfill, and the triggers that revoke personal keys in
// the database itself, so a delete, deactivation or ban made by any code (an
// older API build on a laptop sharing the database, a script, psql) revokes
// them. A role change does not (migration 20261013130000): a personal key is
// bounded by its creator's current roles at every use. Writes here are raw
// SQL, i.e. code that knows nothing about API keys.

const reviewSql = readFileSync(
  resolve(
    __dirname,
    '../../../../packages/db/prisma/review/api-keys-with-missing-or-inactive-creator.sql',
  ),
  'utf8',
);

const SEED = `
INSERT INTO "Organization" ("id", "name") VALUES ('org_1', 'One'), ('org_2', 'Two');
INSERT INTO "User" ("id", "email") VALUES
  ('usr_a', 'a@example.com'), ('usr_b', 'b@example.com'), ('usr_c', 'c@example.com');
INSERT INTO "Member" ("id", "organizationId", "userId", "role") VALUES
  ('mem_a', 'org_1', 'usr_a', 'admin'),
  ('mem_a2', 'org_2', 'usr_a', 'owner'),
  ('mem_b', 'org_1', 'usr_b', 'owner,admin'),
  ('mem_c', 'org_1', 'usr_c', 'employee');
INSERT INTO "ApiKey"
  ("id", "name", "key", "organizationId", "createdByMemberId", "organizationOwned", "createdAt")
VALUES
  ('k_a', 'a', 'h1', 'org_1', 'mem_a', false, '2026-10-08'),
  ('k_a_org', 'a org', 'h2', 'org_1', 'mem_a', true, '2026-10-08'),
  ('k_a2', 'a2', 'h3', 'org_2', 'mem_a2', false, '2026-10-08'),
  ('k_b', 'b', 'h4', 'org_1', 'mem_b', false, '2026-10-08'),
  ('k_c', 'c', 'h5', 'org_1', 'mem_c', false, '2026-10-08'),
  ('k_legacy', 'legacy', 'h6', 'org_1', NULL, false, '2026-01-01'),
  ('k_late_orphan', 'late', 'h7', 'org_1', NULL, false, '2026-10-07'),
  ('k_org_legacy', 'org legacy', 'h8', 'org_1', NULL, true, '2026-01-01');
`;

const ACTIVE_KEYS = `SELECT array_agg("id" ORDER BY "id") AS ids FROM "ApiKey" WHERE "isActive"`;

const SCENARIOS: Record<string, string[]> = {
  backfill: [
    `SELECT array_agg("id" ORDER BY "id") AS ids FROM "ApiKey" WHERE "legacyCreatorless"`,
  ],
  untouched: [ACTIVE_KEYS],
  memberDelete: [`DELETE FROM "Member" WHERE "id" = 'mem_a'`, ACTIVE_KEYS],
  userDelete: [`DELETE FROM "User" WHERE "id" = 'usr_a'`, ACTIVE_KEYS],
  organizationDelete: [
    `DELETE FROM "Organization" WHERE "id" = 'org_1'`,
    `SELECT array_agg("id" ORDER BY "id") AS ids FROM "ApiKey"`,
  ],
  deactivate: [
    `UPDATE "Member" SET "deactivated" = true, "isActive" = false WHERE "id" = 'mem_a'`,
    ACTIVE_KEYS,
  ],
  markInactive: [
    `UPDATE "Member" SET "isActive" = false WHERE "id" = 'mem_a'`,
    ACTIVE_KEYS,
  ],
  reactivate: [
    `UPDATE "Member" SET "deactivated" = true, "isActive" = false WHERE "id" = 'mem_a'`,
    `UPDATE "Member" SET "deactivated" = false, "isActive" = true WHERE "id" = 'mem_a'`,
    ACTIVE_KEYS,
  ],
  roleRemoved: [
    `UPDATE "Member" SET "role" = 'admin' WHERE "id" = 'mem_b'`,
    ACTIVE_KEYS,
  ],
  roleReplaced: [
    `UPDATE "Member" SET "role" = 'auditor' WHERE "id" = 'mem_c'`,
    ACTIVE_KEYS,
  ],
  roleAdded: [
    `UPDATE "Member" SET "role" = 'employee,admin' WHERE "id" = 'mem_c'`,
    ACTIVE_KEYS,
  ],
  roleReordered: [
    `UPDATE "Member" SET "role" = 'admin, owner' WHERE "id" = 'mem_b'`,
    ACTIVE_KEYS,
  ],
  unrelatedUpdates: [
    `UPDATE "Member" SET "department" = 'it', "isActive" = true, "role" = 'admin' WHERE "id" = 'mem_a'`,
    `UPDATE "User" SET "email" = 'new@example.com', "banned" = false WHERE "id" = 'usr_b'`,
    ACTIVE_KEYS,
  ],
  ban: [`UPDATE "User" SET "banned" = true WHERE "id" = 'usr_a'`, ACTIVE_KEYS],
  unban: [
    `UPDATE "User" SET "banned" = true WHERE "id" = 'usr_a'`,
    `UPDATE "User" SET "banned" = false WHERE "id" = 'usr_a'`,
    ACTIVE_KEYS,
  ],
};

function runScenarios(): Record<string, ScenarioResult> {
  return runSqlScenarios({
    setup: [API_KEY_TABLES, SEED, ...API_KEY_MIGRATIONS.map(migrationSql)],
    scenarios: {
      ...SCENARIOS,
      review: [readOnlyStatement(reviewSql)],
    },
  });
}

/** The review script's single statement, without its read-only wrapper. */
function readOnlyStatement(script: string): string {
  const body = script
    .split('\n')
    .filter((line) => !line.startsWith('--'))
    .join('\n');
  const match = /BEGIN TRANSACTION READ ONLY;([\s\S]*);\s*ROLLBACK;/.exec(body);
  if (!match) throw new Error('review script lost its read-only wrapper');
  return match[1];
}

describe('API-key migrations in Postgres', () => {
  let results: Record<string, ScenarioResult>;
  const ids = (scenario: string) => {
    const result = results[scenario];
    if (result.error) throw new Error(`${scenario}: ${result.error}`);
    return result.rows?.[0]?.ids;
  };

  beforeAll(() => {
    results = runScenarios();
  }, 90_000);

  const ALL_ACTIVE = [
    'k_a',
    'k_a2',
    'k_a_org',
    'k_b',
    'k_c',
    'k_late_orphan',
    'k_legacy',
    'k_org_legacy',
  ];
  const without = (...revoked: string[]) =>
    ALL_ACTIVE.filter((id) => !revoked.includes(id));

  it('flags only personal creatorless keys from before the old cutoff as legacy', () => {
    expect(ids('backfill')).toEqual(['k_legacy']);
    expect(ids('untouched')).toEqual(ALL_ACTIVE);
  });

  it('a member delete revokes that member personal keys, not organization-owned ones', () => {
    expect(ids('memberDelete')).toEqual(without('k_a'));
  });

  it('a user delete revokes the personal keys of every membership it cascades to', () => {
    expect(ids('userDelete')).toEqual(without('k_a', 'k_a2'));
  });

  it('an organization delete still cascades its keys away', () => {
    expect(ids('organizationDelete')).toEqual(['k_a2']);
  });

  it('deactivation and marking inactive revoke, and reactivation does not restore', () => {
    expect(ids('deactivate')).toEqual(without('k_a'));
    expect(ids('markInactive')).toEqual(without('k_a'));
    expect(ids('reactivate')).toEqual(without('k_a'));
  });

  it('no role change revokes: removing, replacing, adding or reordering', () => {
    expect(ids('roleRemoved')).toEqual(ALL_ACTIVE);
    expect(ids('roleReplaced')).toEqual(ALL_ACTIVE);
    expect(ids('roleAdded')).toEqual(ALL_ACTIVE);
    expect(ids('roleReordered')).toEqual(ALL_ACTIVE);
  });

  it('updates that change no access revoke nothing', () => {
    expect(ids('unrelatedUpdates')).toEqual(ALL_ACTIVE);
  });

  it('banning a user revokes the personal keys of all its memberships; unbanning restores none', () => {
    expect(ids('ban')).toEqual(without('k_a', 'k_a2'));
    expect(ids('unban')).toEqual(without('k_a', 'k_a2'));
  });

  it('the review query lists active keys whose creator is missing, and is read-only', () => {
    expect(readOnlyStatement(reviewSql)).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/i,
    );
    const rows = results.review.rows ?? [];
    expect(
      rows.map((row) => [row.api_key_id, row.accepted_before_fix]),
    ).toEqual([
      ['k_legacy', true],
      ['k_org_legacy', true],
      ['k_late_orphan', false],
    ]);
  });
});
