import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILD_URL_NAMES } from './build-urls.cjs';

// turbo runs tasks in strict env mode: a variable not declared for the task is
// dropped, so the required build URLs would never reach electron-vite and every
// root `bun run build` would fail (and a URL change would not bust the cache).

type TurboTask = {
  dependsOn?: string[];
  inputs?: string[];
  outputs?: string[];
  env?: string[];
};

const turbo = JSON.parse(readFileSync(resolve(__dirname, '../../../../turbo.json'), 'utf8')) as {
  tasks: Record<string, TurboTask>;
};

describe('turbo build task for the device agent', () => {
  const task = turbo.tasks['@trycompai/device-agent#build'];

  it('declares the build URLs and the agent version', () => {
    expect(task?.env).toEqual(expect.arrayContaining([...BUILD_URL_NAMES, 'AGENT_VERSION']));
  });

  it('keeps the generic build settings', () => {
    const build = turbo.tasks.build;
    expect(task?.dependsOn).toEqual(build?.dependsOn);
    expect(task?.inputs).toEqual(build?.inputs);
    expect(task?.outputs).toEqual(build?.outputs);
  });
});
