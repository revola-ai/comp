import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Every release builds the images on the production server, so the base images are pinned by
// the digest of their multi-architecture index: a retagged node or bun image changes nothing
// until the tag and the digest are bumped together.

const DOCKERFILE = readFileSync(join(import.meta.dir, '../Dockerfile'), 'utf8');

/** The default of `ARG <name>=<value>`, or undefined when the Dockerfile has none. */
function argDefault({ name }: { name: string }): string | undefined {
  return new RegExp(`^ARG ${name}=(\\S+)$`, 'm').exec(DOCKERFILE)?.[1];
}

describe('base images', () => {
  test.each([
    ['NODE_IMAGE', 'node:22-slim'],
    ['BUN_IMAGE', 'oven/bun:1.3.4'],
  ])('%s is %s pinned by digest', (name, image) => {
    const escaped = image.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    expect(argDefault({ name })).toMatch(new RegExp(`^${escaped}@sha256:[0-9a-f]{64}$`));
  });
});
