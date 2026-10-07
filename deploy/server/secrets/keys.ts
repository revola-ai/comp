import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Where each key of comp/production/config comes from. The keys are exactly the union of the
// source keys in deploy/server/env/*.keys (render-env.sh refuses a missing one); each is copied
// from exactly one of the operator's env files. Ported from the parked ECS design
// (revola/aws-infra deploy/aws/secret-keys.ts), with the tunnel token and the Trigger.dev
// access token added and the ECS-only origin-auth secret dropped. Values never appear here.

/** Env files under the operator's main checkout that push-secrets reads (never committed). */
export const SOURCE_FILES = [
  'apps/api/.env',
  'apps/app/.env',
  'apps/portal/.env',
  'packages/db/.env',
  // Production-only values no laptop holds; gitignored by the repository's .env*.local rule.
  'deploy/server/.env.production.local',
] as const;
export type SourceFile = (typeof SOURCE_FILES)[number];

export function isSourceFile(file: string): file is SourceFile {
  return SOURCE_FILES.some((known) => known === file);
}

export const PRODUCTION_ONLY_FILE: SourceFile = 'deploy/server/.env.production.local';

export type SecretKeySpec = Readonly<{
  /** The one file the value is copied from. */
  file: SourceFile;
  /** The variable name in that file, when it differs from the secret key. */
  name?: string;
  /** Read this name instead when `name` is absent from the file (the output says so). */
  fallbackName?: string;
  /** The same value under another name in another file; push-secrets checks they agree. */
  aliases?: readonly Readonly<{ file: SourceFile; name: string }>[];
  /** The source name legitimately differs between files (one value per Trigger project). */
  fileSpecific?: true;
  /** Files whose variable of the same name may hold another value, so it is not compared. */
  differsIn?: readonly SourceFile[];
}>;

const API: SourceFile = 'apps/api/.env';
const APP: SourceFile = 'apps/app/.env';
const DB: SourceFile = 'packages/db/.env';
const PROD = PRODUCTION_ONLY_FILE;

/** Keys of comp/production/config, each copied from exactly one source file. */
export const SECRET_KEYS: Readonly<Record<string, SecretKeySpec>> = Object.freeze({
  // Database: the session pooler (5432) at runtime. Migrations use DATABASE_MIGRATION_URL from
  // packages/db/.env (the session pooler or the direct host), else its DATABASE_URL, which is
  // therefore never compared with the runtime one.
  DATABASE_URL: { file: API, differsIn: [DB] },
  DATABASE_MIGRATION_URL: { file: DB, fallbackName: 'DATABASE_URL', fileSpecific: true },
  // Storage: Supabase Storage through its S3 endpoint.
  APP_AWS_ENDPOINT: { file: API },
  APP_AWS_REGION: { file: API },
  APP_AWS_ACCESS_KEY_ID: { file: API },
  APP_AWS_SECRET_ACCESS_KEY: { file: API },
  APP_AWS_BUCKET_NAME: { file: API },
  APP_AWS_ORG_ASSETS_BUCKET: { file: API },
  APP_AWS_QUESTIONNAIRE_UPLOAD_BUCKET: { file: API },
  APP_AWS_KNOWLEDGE_BASE_BUCKET: { file: API },
  // Redis (Upstash).
  UPSTASH_REDIS_REST_URL: { file: API },
  UPSTASH_REDIS_REST_TOKEN: { file: API },
  // Auth and encryption: the better-auth secret is AUTH_SECRET in the app's env file and
  // BETTER_AUTH_SECRET in the portal's.
  SECRET_KEY: {
    file: API,
    aliases: [
      { file: APP, name: 'AUTH_SECRET' },
      { file: 'apps/portal/.env', name: 'BETTER_AUTH_SECRET' },
    ],
  },
  ENCRYPTION_KEY: { file: API },
  AUTH_GOOGLE_ID: { file: API },
  AUTH_GOOGLE_SECRET: { file: API },
  // Email (Resend).
  RESEND_API_KEY: { file: API },
  RESEND_FROM_SYSTEM: { file: API },
  RESEND_FROM_DEFAULT: { file: API },
  UNSUBSCRIBE_SECRET: { file: API },
  // AI providers.
  OPENAI_API_KEY: { file: API },
  ANTHROPIC_API_KEY: { file: API },
  GOOGLE_GENERATIVE_AI_API_KEY: { file: APP },
  // Service-to-service tokens (each at least 32 characters), production-only: the API trusts the
  // forwarded-IP token's X-Forwarded-For from any peer, so a laptop's value must never work on the
  // public API. The laptop stack never calls the production API, so separate values cost nothing.
  INTERNAL_API_TOKEN: { file: PROD },
  COMP_FORWARDED_IP_TOKEN: { file: PROD },
  SERVICE_TOKEN_TRIGGER: { file: PROD },
  SERVICE_TOKEN_PORTAL: { file: PROD },
  REVALIDATION_SECRET: { file: APP },
  // The penetration-test module refuses to boot without it.
  MACED_API_KEY: { file: API },
  // Trigger.dev: the prod secret keys and the personal access token are production-only; the
  // project refs are the ones the laptops already use (the CLI's TRIGGER_PROJECT_REF).
  TRIGGER_SECRET_KEY_API: { file: PROD },
  TRIGGER_SECRET_KEY_APP: { file: PROD },
  TRIGGER_ACCESS_TOKEN: { file: PROD },
  TRIGGER_PROJECT_REF_API: { file: API, name: 'TRIGGER_PROJECT_REF', fileSpecific: true },
  TRIGGER_PROJECT_REF_APP: { file: APP, name: 'TRIGGER_PROJECT_REF', fileSpecific: true },
  // The Zero Trust tunnel "comp" (cloudflared tunnel run).
  TUNNEL_TOKEN: { file: PROD },
});

/** deploy/server/env, next to this kit. */
export const KEYS_DIR = join(import.meta.dir, '..', 'env');

const KEYS_LINE = /^([A-Z_][A-Z0-9_]*)(?:\s+from\s+([A-Z_][A-Z0-9_]*))?$/;

/** The secret keys one .keys file reads: the KEY of `NAME from KEY`, else NAME. */
export function parseKeysFile({ text, file }: { text: string; file: string }): string[] {
  const keys: string[] = [];
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = KEYS_LINE.exec(line);
    if (!match?.[1]) throw new Error(`${file} line ${index + 1} is neither NAME nor NAME from KEY`);
    keys.push(match[2] ?? match[1]);
  }
  return keys;
}

/** The union of the secret keys of every env/*.keys file. */
export function readKeyUnion({ keysDir }: { keysDir: string }): Set<string> {
  const union = new Set<string>();
  for (const file of readdirSync(keysDir).filter((name) => name.endsWith('.keys')).sort()) {
    const text = readFileSync(join(keysDir, file), 'utf8');
    for (const key of parseKeysFile({ text, file: `env/${file}` })) union.add(key);
  }
  return union;
}

/** Where the key table and the .keys files disagree, by key name. */
export function keyTableProblems({
  union,
  secretKeys,
}: {
  union: ReadonlySet<string>;
  secretKeys: Readonly<Record<string, SecretKeySpec>>;
}): string[] {
  const missing = [...union].filter((key) => !(key in secretKeys)).sort();
  const extra = Object.keys(secretKeys).filter((key) => !union.has(key)).sort();
  return [
    ...missing.map((key) => `${key} is in env/*.keys but has no source in secrets/keys.ts`),
    ...extra.map((key) => `${key} has a source in secrets/keys.ts but is in no env/*.keys file`),
  ];
}
