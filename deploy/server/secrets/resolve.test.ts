import { describe, expect, test } from 'bun:test';
import { isSourceFile, SECRET_KEYS } from './keys.ts';
import { resolveDesired, type SourceValues } from './resolve.ts';
import {
  API_ENV,
  DEV_URL,
  expectedSecret,
  expectNoValues,
  type FixtureFiles,
  LAPTOP_TOKENS,
  PROD_ENV,
  MIGRATION_URL,
  RUNTIME_URL,
  sources,
  TARGET,
  without,
} from './testing/fixtures.ts';

function asSources(files: FixtureFiles): SourceValues {
  const values: SourceValues = {};
  for (const [file, env] of Object.entries(files)) {
    if (isSourceFile(file)) values[file] = env;
  }
  return values;
}

function resolve(files: FixtureFiles) {
  const result = resolveDesired({ secretKeys: SECRET_KEYS, sources: asSources(files), target: TARGET });
  expectNoValues([...result.problems, ...result.notes].join('\n'));
  return result;
}

describe('resolveDesired', () => {
  test('copies every key from its one source file', () => {
    const { values, problems } = resolve(sources());
    expect(problems).toEqual([]);
    expect(values).toEqual(expectedSecret());
  });

  test('a missing key names the key and its file', () => {
    const app = without({ record: sources()['apps/app/.env'] ?? {}, keys: ['REVALIDATION_SECRET'] });
    const files = { ...sources(), 'apps/app/.env': app };
    expect(resolve(files).problems).toEqual(['REVALIDATION_SECRET not found in apps/app/.env; add it there']);
  });

  test('a renamed key names both names', () => {
    const api = without({ record: API_ENV, keys: ['TRIGGER_PROJECT_REF'] });
    const files = { ...sources(), 'apps/api/.env': api };
    expect(resolve(files).problems).toEqual([
      'TRIGGER_PROJECT_REF_API (TRIGGER_PROJECT_REF) not found in apps/api/.env; add it there',
    ]);
  });

  test('the same name with another value in another file is refused', () => {
    const files = sources({ app: { ENCRYPTION_KEY: 'fakesecret-different' } });
    expect(resolve(files).problems).toEqual(['ENCRYPTION_KEY disagrees between apps/api/.env and apps/app/.env']);
  });

  test('an alias with another value is refused', () => {
    const files = sources({ portal: { BETTER_AUTH_SECRET: 'fakesecret-different' } });
    expect(resolve(files).problems).toEqual([
      'SECRET_KEY disagrees between apps/api/.env and apps/portal/.env (BETTER_AUTH_SECRET)',
    ]);
  });

  test('the migration file may hold another DATABASE_URL', () => {
    const files = sources({ db: { DATABASE_URL: DEV_URL } });
    expect(resolve(files).problems).toEqual([]);
  });

  test('without DATABASE_MIGRATION_URL the migration file DATABASE_URL is used, and said so', () => {
    const files = { ...sources(), 'packages/db/.env': { DATABASE_URL: MIGRATION_URL } };
    const { values, problems, notes } = resolve(files);
    expect(problems).toEqual([]);
    expect(values.DATABASE_MIGRATION_URL).toBe(MIGRATION_URL);
    expect(notes).toEqual([
      'DATABASE_MIGRATION_URL: packages/db/.env has no DATABASE_MIGRATION_URL; using its DATABASE_URL',
    ]);
  });

  test('value refusals carry through, naming the key', () => {
    const files = sources({
      api: { DATABASE_URL: DEV_URL },
      app: { DATABASE_URL: DEV_URL },
      portal: { DATABASE_URL: DEV_URL },
      prod: { SERVICE_TOKEN_PORTAL: 'fakesecret-short', TRIGGER_SECRET_KEY_API: 'tr_dev_fakesecret' },
    });
    expect(resolve(files).problems).toEqual([
      'DATABASE_URL does not name the production database (packages/db/production-target.json)',
      'SERVICE_TOKEN_PORTAL must be at least 32 characters',
      'TRIGGER_SECRET_KEY_API is a dev key (tr_dev_); use the prod key (tr_prod_...) of the project',
    ]);
  });

  test('a laptop value in a shared key is refused', () => {
    const files = sources({
      api: { APP_AWS_ENDPOINT: 'http://localhost:9000/fakesecret' },
      app: { APP_AWS_ENDPOINT: 'http://localhost:9000/fakesecret' },
    });
    expect(resolve(files).problems).toEqual([
      'APP_AWS_ENDPOINT names localhost, a laptop-only address; production needs the hosted service',
    ]);
  });

  test('the two Trigger.dev projects cannot share a prod key', () => {
    const files = sources({ prod: { TRIGGER_SECRET_KEY_APP: 'tr_prod_fakesecretapi' } });
    expect(resolve(files).problems).toEqual([
      'TRIGGER_SECRET_KEY_API and TRIGGER_SECRET_KEY_APP are the same key; each Trigger.dev project has its own prod key',
    ]);
  });

  test.each(Object.keys(LAPTOP_TOKENS))('%s in production must differ from the laptop value', (key) => {
    const files = sources({ prod: { [key]: LAPTOP_TOKENS[key] ?? '' } });
    expect(resolve(files).problems).toEqual([
      `${key} in deploy/server/.env.production.local equals its value in apps/api/.env; production needs its own value`,
    ]);
  });

  test('a laptop copy in another env file is compared too', () => {
    const files = sources({ portal: { SERVICE_TOKEN_PORTAL: PROD_ENV.SERVICE_TOKEN_PORTAL ?? '' } });
    expect(resolve(files).problems).toEqual([
      'SERVICE_TOKEN_PORTAL in deploy/server/.env.production.local equals its value in apps/portal/.env; production needs its own value',
    ]);
  });

  test('a value holding another KEY= (two lines glued together) is refused', () => {
    const files = sources({
      api: { OPENAI_API_KEY: 'fakesecret-openaiRESEND_API_KEY=fakesecret' },
      prod: { TRIGGER_ACCESS_TOKEN: 'tr_pat_fakesecretINTERNAL_API_TOKEN=fakesecret' },
    });
    expect(resolve(files).problems).toEqual([
      'OPENAI_API_KEY in apps/api/.env holds another KEY=VALUE pair, as if two lines were glued together; put each on its own line',
      'TRIGGER_ACCESS_TOKEN in deploy/server/.env.production.local holds another KEY=VALUE pair, as if two lines were glued together; put each on its own line',
    ]);
  });

  test('the production-only file holds only the keys read from it', () => {
    const files = sources({ prod: { DATABASE_URL: RUNTIME_URL, TUNNEL_TOKN: 'fakesecret' } });
    expect(resolve(files).problems).toEqual([
      'deploy/server/.env.production.local holds DATABASE_URL, TUNNEL_TOKN, which push-secrets does not read from it; remove them',
    ]);
  });

  test('a missing source file leaves its keys missing', () => {
    const rest = without({ record: sources(), keys: ['deploy/server/.env.production.local'] });
    const { problems } = resolve(rest);
    expect(problems).toContain(
      'TUNNEL_TOKEN not found in deploy/server/.env.production.local; add it there',
    );
  });
});
