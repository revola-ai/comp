import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DOCKERIGNORE = join(import.meta.dir, '../../../.dockerignore');

function patterns(): string[] {
  return readFileSync(DOCKERIGNORE, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

describe('.dockerignore', () => {
  test.each([
    ['local env files', '**/.env*'],
    ['Terraform provider caches and local state', 'deploy/aws/terraform/.terraform'],
    ['Trigger.dev local build output', '**/.trigger'],
    ['installs', '**/node_modules'],
    ['git metadata', '.git'],
  ])('keeps %s out of the build context', (_what, pattern) => {
    expect(patterns()).toContain(pattern);
  });
});
