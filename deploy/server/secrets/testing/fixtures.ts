import { expect } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  hashProjectRef,
  type ProductionTarget,
} from '../../../../packages/db/src/production-target.ts';

// Synthetic values only. Every fake value contains MARKER, so a test can prove that no value
// reaches the output, an aws argument or a log. The database URLs name a fake production
// project (TARGET), the way packages/db/production-target.json names the real one.

export const MARKER = 'fakesecret';
export const PROD_REF = 'fakesecretprodrefabc';
export const POOLER = 'aws-0-us-east-2.pooler.supabase.com';
export const TARGET: ProductionTarget = {
  projectRefSha256: hashProjectRef(PROD_REF),
  poolerHost: POOLER,
};
export const RUNTIME_URL = `postgresql://postgres.${PROD_REF}:fakesecretRuntimePw@${POOLER}:5432/postgres`;
export const MIGRATION_URL = `postgresql://postgres:fakesecretMigratePw@db.${PROD_REF}.supabase.co:5432/postgres`;
export const DEV_URL = 'postgresql://postgres:fakesecretDevPw@db.fakesecretotherrefab.supabase.co:5432/postgres';

/** A 40-character token that contains MARKER and names its key. */
export function token(name: string): string {
  return `${MARKER}-${name}-`.padEnd(40, 'x');
}

export const API_REF = 'proj_fakesecretapi0000000';
export const APP_REF = 'proj_fakesecretapp0000000';

export const API_ENV: Readonly<Record<string, string>> = {
  DATABASE_URL: RUNTIME_URL,
  APP_AWS_ENDPOINT: `https://${MARKER}.storage.supabase.co/storage/v1/s3`,
  APP_AWS_REGION: `${MARKER}-region`,
  APP_AWS_ACCESS_KEY_ID: `${MARKER}-access-key-id`,
  APP_AWS_SECRET_ACCESS_KEY: `${MARKER}-secret-access-key`,
  APP_AWS_BUCKET_NAME: `${MARKER}-bucket`,
  APP_AWS_ORG_ASSETS_BUCKET: `${MARKER}-org-assets`,
  APP_AWS_QUESTIONNAIRE_UPLOAD_BUCKET: `${MARKER}-questionnaire`,
  APP_AWS_KNOWLEDGE_BASE_BUCKET: `${MARKER}-knowledge-base`,
  UPSTASH_REDIS_REST_URL: `https://${MARKER}.upstash.io`,
  UPSTASH_REDIS_REST_TOKEN: `${MARKER}-redis-token`,
  SECRET_KEY: `${MARKER}-secret-key`,
  ENCRYPTION_KEY: `${MARKER}-encryption-key`,
  AUTH_GOOGLE_ID: `${MARKER}-google-id`,
  AUTH_GOOGLE_SECRET: `${MARKER}-google-secret`,
  RESEND_API_KEY: `${MARKER}-resend`,
  RESEND_FROM_SYSTEM: `${MARKER}-system@example.invalid`,
  RESEND_FROM_DEFAULT: `${MARKER}-default@example.invalid`,
  UNSUBSCRIBE_SECRET: `${MARKER}-unsubscribe`,
  OPENAI_API_KEY: `${MARKER}-openai`,
  ANTHROPIC_API_KEY: `${MARKER}-anthropic`,
  INTERNAL_API_TOKEN: token('internal'),
  COMP_FORWARDED_IP_TOKEN: token('forwarded'),
  SERVICE_TOKEN_TRIGGER: token('trigger'),
  SERVICE_TOKEN_PORTAL: token('portal'),
  MACED_API_KEY: `${MARKER}-maced`,
  TRIGGER_PROJECT_REF: API_REF,
  // Laptop-only values push-secrets never reads.
  TRIGGER_SECRET_KEY: `tr_dev_${MARKER}api`,
  BETTER_AUTH_URL: 'http://localhost:3333',
};

export const APP_ENV: Readonly<Record<string, string>> = {
  DATABASE_URL: RUNTIME_URL,
  AUTH_SECRET: API_ENV.SECRET_KEY ?? '',
  ENCRYPTION_KEY: API_ENV.ENCRYPTION_KEY ?? '',
  GOOGLE_GENERATIVE_AI_API_KEY: `${MARKER}-gemini`,
  REVALIDATION_SECRET: `${MARKER}-revalidation`,
  TRIGGER_PROJECT_REF: APP_REF,
  TRIGGER_SECRET_KEY: `tr_dev_${MARKER}app`,
};

export const PORTAL_ENV: Readonly<Record<string, string>> = {
  DATABASE_URL: RUNTIME_URL,
  BETTER_AUTH_SECRET: API_ENV.SECRET_KEY ?? '',
};

export const DB_ENV: Readonly<Record<string, string>> = {
  DATABASE_URL: RUNTIME_URL,
  DATABASE_MIGRATION_URL: MIGRATION_URL,
};

export const PROD_ENV: Readonly<Record<string, string>> = {
  TUNNEL_TOKEN: `${MARKER}-tunnel-token`,
  TRIGGER_ACCESS_TOKEN: `tr_pat_${MARKER}access`,
  TRIGGER_SECRET_KEY_API: `tr_prod_${MARKER}api`,
  TRIGGER_SECRET_KEY_APP: `tr_prod_${MARKER}app`,
};

export type FixtureFiles = Record<string, Readonly<Record<string, string>>>;

/** `record` without `keys`. */
export function without<T>({ record, keys }: { record: Readonly<Record<string, T>>; keys: readonly string[] }): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
}

type Overrides = Partial<Record<'api' | 'app' | 'portal' | 'db' | 'prod', Record<string, string>>>;

/** The five source files with the values above, each file's overrides merged in. */
export function sources(overrides: Overrides = {}): FixtureFiles {
  return {
    'apps/api/.env': { ...API_ENV, ...overrides.api },
    'apps/app/.env': { ...APP_ENV, ...overrides.app },
    'apps/portal/.env': { ...PORTAL_ENV, ...overrides.portal },
    'packages/db/.env': { ...DB_ENV, ...overrides.db },
    'deploy/server/.env.production.local': { ...PROD_ENV, ...overrides.prod },
  };
}

/** What a push of the unchanged fixtures writes. */
export function expectedSecret(): Record<string, string> {
  const api = without({
    record: API_ENV,
    keys: ['TRIGGER_PROJECT_REF', 'TRIGGER_SECRET_KEY', 'BETTER_AUTH_URL'],
  });
  return {
    ...api,
    GOOGLE_GENERATIVE_AI_API_KEY: APP_ENV.GOOGLE_GENERATIVE_AI_API_KEY ?? '',
    REVALIDATION_SECRET: APP_ENV.REVALIDATION_SECRET ?? '',
    DATABASE_MIGRATION_URL: MIGRATION_URL,
    TRIGGER_PROJECT_REF_API: API_REF,
    TRIGGER_PROJECT_REF_APP: APP_REF,
    ...PROD_ENV,
  };
}

function quoted(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"')}"`;
}

/** Writes each file as dotenv text under `dir`. */
export function writeEnvFiles({ dir, files }: { dir: string; files: FixtureFiles }): void {
  for (const [file, env] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    const text = Object.entries(env)
      .map(([name, value]) => `${name}=${quoted(value)}`)
      .join('\n');
    writeFileSync(join(dir, file), `# fixture, fake values only\n${text}\n`);
  }
}

export function git({ cwd, args }: { cwd: string; args: string[] }): void {
  const result = Bun.spawnSync(
    ['git', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { cwd, stdout: 'pipe', stderr: 'pipe' },
  );
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

/** A main git checkout under a fresh temporary directory holding `files`. */
export function makeCheckout({ files, roots }: { files: FixtureFiles; roots: string[] }): string {
  const root = mkdtempSync(join(tmpdir(), 'push-secrets-'));
  roots.push(root);
  git({ cwd: root, args: ['init', '-q'] });
  writeEnvFiles({ dir: root, files });
  return root;
}

/** No fixture value, and nothing containing MARKER, appears in `text`. */
export function expectNoValues(text: string): void {
  expect(text).not.toContain(MARKER);
}
