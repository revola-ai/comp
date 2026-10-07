import { describe, expect, test } from 'bun:test';
import {
  DEV_URL,
  expectNoValues,
  MIGRATION_URL,
  POOLER,
  PROD_REF,
  RUNTIME_URL,
  TARGET,
  token,
} from './testing/fixtures.ts';
import { valueProblems } from './values.ts';

function problems(key: string, value: string): string[] {
  const found = valueProblems({ key, value, target: TARGET });
  expectNoValues(found.join('\n'));
  return found;
}

describe('every key', () => {
  test('a plain value passes', () => {
    expect(problems('OPENAI_API_KEY', 'fakesecret-openai')).toEqual([]);
  });

  test('an empty value is refused', () => {
    expect(problems('OPENAI_API_KEY', '')).toEqual(['OPENAI_API_KEY is empty']);
  });

  test('a line break or a NUL character is refused', () => {
    expect(problems('OPENAI_API_KEY', 'fakesecret\nmore')).toEqual([
      'OPENAI_API_KEY contains a line break',
    ]);
    expect(problems('OPENAI_API_KEY', 'fakesecret\rmore')).toEqual([
      'OPENAI_API_KEY contains a line break',
    ]);
    expect(problems('OPENAI_API_KEY', 'fakesecret\0more')).toEqual([
      'OPENAI_API_KEY contains a NUL character',
    ]);
  });

  test.each(['localhost', 'LocalHost', '127.0.0.1', 'host.docker.internal'])(
    'a value naming %s is refused as a laptop value',
    (host) => {
      expect(problems('UPSTASH_REDIS_REST_URL', `http://${host}:8079/fakesecret`)).toEqual([
        `UPSTASH_REDIS_REST_URL names ${host.toLowerCase()}, a laptop-only address; production needs the hosted service`,
      ]);
    },
  );
});

describe('tokens', () => {
  test.each([
    'SERVICE_TOKEN_TRIGGER',
    'SERVICE_TOKEN_PORTAL',
    'COMP_FORWARDED_IP_TOKEN',
    'INTERNAL_API_TOKEN',
  ])('%s must be at least 32 characters', (key) => {
    expect(problems(key, token(key))).toEqual([]);
    expect(problems(key, 'fakesecret'.padEnd(31, 'x'))).toEqual([
      `${key} must be at least 32 characters`,
    ]);
  });
});

describe('Trigger.dev', () => {
  test('secret keys must be prod keys', () => {
    expect(problems('TRIGGER_SECRET_KEY_API', 'tr_prod_fakesecret')).toEqual([]);
    expect(problems('TRIGGER_SECRET_KEY_APP', 'tr_dev_fakesecret')).toEqual([
      'TRIGGER_SECRET_KEY_APP is a dev key (tr_dev_); use the prod key (tr_prod_...) of the project',
    ]);
    expect(problems('TRIGGER_SECRET_KEY_API', 'fakesecret')).toEqual([
      'TRIGGER_SECRET_KEY_API must be a Trigger.dev prod key (tr_prod_...)',
    ]);
  });

  test('the access token must be a personal access token', () => {
    expect(problems('TRIGGER_ACCESS_TOKEN', 'tr_pat_fakesecret')).toEqual([]);
    expect(problems('TRIGGER_ACCESS_TOKEN', 'tr_prod_fakesecret')).toEqual([
      'TRIGGER_ACCESS_TOKEN must be a Trigger.dev personal access token (tr_pat_...)',
    ]);
  });

  test('project refs must be well formed and never the upstream Comp AI projects', () => {
    expect(problems('TRIGGER_PROJECT_REF_API', 'proj_fakesecretapi0000000')).toEqual([]);
    expect(problems('TRIGGER_PROJECT_REF_APP', 'proj_short')).toEqual([
      'TRIGGER_PROJECT_REF_APP must be a Trigger.dev project ref (proj_ and 20 lowercase letters or digits)',
    ]);
    for (const upstream of ['proj_zhioyrusqertqgafqgpj', 'proj_lhxjliiqgcdyqbgtucda']) {
      expect(valueProblems({ key: 'TRIGGER_PROJECT_REF_API', value: upstream, target: TARGET })).toEqual([
        'TRIGGER_PROJECT_REF_API is an upstream Comp AI project; use the Revola project ref',
      ]);
    }
  });
});

describe('database URLs', () => {
  test('the production session pooler and direct host pass', () => {
    expect(problems('DATABASE_URL', RUNTIME_URL)).toEqual([]);
    expect(problems('DATABASE_MIGRATION_URL', MIGRATION_URL)).toEqual([]);
  });

  test('another database is refused', () => {
    expect(problems('DATABASE_URL', DEV_URL)).toEqual([
      'DATABASE_URL does not name the production database (packages/db/production-target.json)',
    ]);
    expect(problems('DATABASE_MIGRATION_URL', DEV_URL)).toEqual([
      'DATABASE_MIGRATION_URL does not name the production database (packages/db/production-target.json)',
    ]);
  });

  test('the transaction pooler (port 6543) is refused', () => {
    const url = RUNTIME_URL.replace(':5432/', ':6543/');
    expect(problems('DATABASE_MIGRATION_URL', url)).toEqual([
      'DATABASE_MIGRATION_URL uses port 6543, the transaction pooler; use the session pooler (5432) or the direct host',
    ]);
  });

  test('a value that is not a URL is refused', () => {
    expect(problems('DATABASE_URL', 'fakesecret not a url')).toEqual([
      'DATABASE_URL is not a valid URL; percent-encode the user and password',
    ]);
  });

  test('a URL of another scheme is refused', () => {
    expect(problems('DATABASE_URL', RUNTIME_URL.replace('postgresql:', 'mysql:'))).toEqual([
      'DATABASE_URL must be a postgres:// or postgresql:// URL',
    ]);
  });

  test.each(['/', '?', '#', '@'])('an unescaped %s in the password is refused', (character) => {
    const value = `postgresql://postgres.${PROD_REF}:fakesecret${character}12@${POOLER}:5432/postgres`;
    const found = problems('DATABASE_URL', value);
    expect(found).toHaveLength(1);
    expect(found[0]).toStartWith('DATABASE_URL ');
    expect(found[0]).toContain('percent-encode the user and password');
  });

  test('an all-digit password before an unescaped / cannot pass as a port', () => {
    const value = `postgresql://postgres.${PROD_REF}:1234/fakesecret@${POOLER}:5432/postgres`;
    expect(problems('DATABASE_URL', value)).toEqual([
      'DATABASE_URL has no user and password before the host; an unescaped /, ?, # or @ in the password ends it early, so percent-encode the user and password',
    ]);
  });

  test('a percent-encoded password passes', () => {
    const value = `postgresql://postgres.${PROD_REF}:fakesecret%2F%3F%23%4012@${POOLER}:5432/postgres`;
    expect(problems('DATABASE_URL', value)).toEqual([]);
  });
});
