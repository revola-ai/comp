import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Runs the API-key migrations against a throwaway PGlite database
// (pglite-sql-runner.mjs) on the tables they touch (api-key-tables.sql).

const repo = resolve(__dirname, '../../..');

export function migrationSql(name: string): string {
  return readFileSync(
    resolve(repo, 'packages/db/prisma/migrations', name, 'migration.sql'),
    'utf8',
  );
}

/** The API-key migrations after the tables exist, in order. */
export const API_KEY_MIGRATIONS = [
  '20261013120000_api_key_legacy_creatorless',
  '20261013120100_api_key_revocation_triggers',
  '20261013130000_api_key_triggers_without_role_revocation',
];

export const API_KEY_TABLES = readFileSync(
  resolve(__dirname, 'api-key-tables.sql'),
  'utf8',
);

export type ScenarioResult = {
  rows?: Array<Record<string, unknown>>;
  error?: string;
};

/**
 * Runs `setup` once, then each scenario's statements inside BEGIN ... ROLLBACK;
 * returns each scenario's last rows or its first error message.
 */
export function runSqlScenarios({
  setup,
  scenarios,
}: {
  setup: string[];
  scenarios: Record<string, string[]>;
}): Record<string, ScenarioResult> {
  const output = execFileSync(
    process.execPath,
    [resolve(__dirname, 'pglite-sql-runner.mjs')],
    {
      input: JSON.stringify({ setup, scenarios }),
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  return JSON.parse(output) as Record<string, ScenarioResult>;
}
