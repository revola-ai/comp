import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REGION } from './aws-cli.ts';
import { awsSecretStore, SECRET_ID } from './secret-store.ts';

const store = awsSecretStore({
  run: async () => {
    throw new Error('describeWrite never runs aws');
  },
});

describe('describeWrite', () => {
  test.each([true, false])('names the region of aws-cli.ts (create: %p)', (create) => {
    const command = store.describeWrite({ create });
    expect(command).toStartWith('aws secretsmanager ');
    expect(command).toContain(SECRET_ID);
    expect(command).toEndWith(` --region ${REGION}`);
  });

  test('no module but aws-cli.ts spells the region in code', () => {
    const spelled = readdirSync(import.meta.dir)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'aws-cli.ts')
      .filter((name) =>
        readFileSync(join(import.meta.dir, name), 'utf8')
          .split('\n')
          .some((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && line.includes(`'${REGION}'`)),
      );
    expect(spelled).toEqual([]);
  });
});
