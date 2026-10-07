import { describe, expect, test } from 'bun:test';
import { formatPlan, planPush } from './plan.ts';
import { expectNoValues, without } from './testing/fixtures.ts';

const DESIRED = {
  ENCRYPTION_KEY: 'fakesecret-enc',
  SECRET_KEY: 'fakesecret-sec',
  OPENAI_API_KEY: 'fakesecret-new',
  TUNNEL_TOKEN: 'fakesecret-tunnel',
  DATABASE_URL: 'fakesecret-db',
};

describe('planPush', () => {
  test('a first push adds every key', () => {
    const plan = planPush({ desired: DESIRED, current: undefined });
    expect(plan).toEqual({
      added: ['DATABASE_URL', 'ENCRYPTION_KEY', 'OPENAI_API_KEY', 'SECRET_KEY', 'TUNNEL_TOKEN'],
      changed: [],
      removed: [],
      unchanged: 0,
      problems: [],
    });
  });

  test('names what is added, changed and removed, and counts the rest', () => {
    const current = {
      ENCRYPTION_KEY: 'fakesecret-enc',
      SECRET_KEY: 'fakesecret-sec',
      OPENAI_API_KEY: 'fakesecret-old',
      DATABASE_URL: 'fakesecret-db',
      OLD_KEY: 'fakesecret-old-key',
    };
    const plan = planPush({ desired: DESIRED, current });
    expect(plan).toEqual({
      added: ['TUNNEL_TOKEN'],
      changed: ['OPENAI_API_KEY'],
      removed: ['OLD_KEY'],
      unchanged: 3,
      problems: [],
    });
    const lines = formatPlan({ plan });
    expect(lines).toEqual([
      'added (1): TUNNEL_TOKEN',
      'changed (1): OPENAI_API_KEY',
      'removed (1): OLD_KEY',
      'unchanged: 3',
    ]);
    expectNoValues(lines.join('\n'));
  });

  test('empty groups say none', () => {
    const plan = planPush({ desired: DESIRED, current: DESIRED });
    expect(formatPlan({ plan })).toEqual([
      'added: none',
      'changed: none',
      'removed: none',
      'unchanged: 5',
    ]);
  });

  test.each(['ENCRYPTION_KEY', 'SECRET_KEY'])('%s never changes once present', (key) => {
    const current = { ...DESIRED, [key]: 'fakesecret-other' };
    const { problems } = planPush({ desired: DESIRED, current });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toStartWith(`${key} would change; `);
    expectNoValues(problems.join('\n'));
  });

  test('ENCRYPTION_KEY can never be removed', () => {
    const desired = without({ record: DESIRED, keys: ['ENCRYPTION_KEY'] });
    const { problems } = planPush({ desired, current: DESIRED });
    expect(problems).toEqual([
      'ENCRYPTION_KEY would be removed; it encrypts stored credentials, so it never changes once set',
    ]);
  });
});
