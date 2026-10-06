import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@trigger.dev/sdk', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from '@trigger.dev/sdk';
import { isScheduledRunAllowed, shouldRunScheduledTask } from './schedule-guard';

const TRIGGER_DIR = resolve(__dirname, '..');

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('shouldRunScheduledTask', () => {
  it.each([
    ['PRODUCTION', undefined, true],
    ['PRODUCTION', 'false', true],
    ['DEVELOPMENT', undefined, false],
    ['STAGING', undefined, false],
    ['PREVIEW', undefined, false],
    ['DEVELOPMENT', 'true', true],
    ['STAGING', 'true', true],
    ['PREVIEW', 'true', true],
    ['DEVELOPMENT', 'false', false],
    ['DEVELOPMENT', '1', false],
    ['DEVELOPMENT', 'TRUE', false],
    ['DEVELOPMENT', '', false],
  ])(
    'environment %s with COMP_RUN_SCHEDULES_IN_DEV=%s -> %s',
    (environmentType, flag, expected) => {
      const env = flag === undefined ? {} : { COMP_RUN_SCHEDULES_IN_DEV: flag };
      expect(shouldRunScheduledTask({ environmentType, env })).toBe(expected);
    },
  );

  it('fails closed on an unknown environment type', () => {
    expect(shouldRunScheduledTask({ environmentType: 'SOMETHING_NEW', env: {} })).toBe(false);
  });
});

describe('isScheduledRunAllowed', () => {
  it('logs the skip with the opt-in hint outside production', () => {
    vi.stubEnv('COMP_RUN_SCHEDULES_IN_DEV', undefined);
    const allowed = isScheduledRunAllowed({
      ctx: { environment: { type: 'DEVELOPMENT' }, task: { id: 'weekly-task-reminder' } },
    });

    expect(allowed).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('COMP_RUN_SCHEDULES_IN_DEV=true'),
      expect.objectContaining({ taskId: 'weekly-task-reminder', environmentType: 'DEVELOPMENT' }),
    );
    vi.unstubAllEnvs();
  });

  it('allows production runs without logging a skip', () => {
    const allowed = isScheduledRunAllowed({
      ctx: { environment: { type: 'PRODUCTION' }, task: { id: 'weekly-task-reminder' } },
    });
    expect(allowed).toBe(true);
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe('every schedules.task calls the schedule guard', () => {
  const scheduleFiles = listSourceFiles(TRIGGER_DIR)
    .map((file) => ({ rel: relative(TRIGGER_DIR, file), source: readFileSync(file, 'utf8') }))
    .filter(({ source }) => source.includes('schedules.task('));

  it('finds the scheduled tasks (scanner sanity check)', () => {
    expect(scheduleFiles.length).toBeGreaterThanOrEqual(6);
  });

  it.each(scheduleFiles.map(({ rel }) => rel))('%s calls the guard', (rel) => {
    const { source } = scheduleFiles.find((file) => file.rel === rel)!;
    const tasks = source.split('schedules.task(').length - 1;
    const guards = source.match(/isScheduledRunAllowed\(\{ ctx \}\)/g)?.length ?? 0;
    expect(guards).toBeGreaterThanOrEqual(tasks);
  });
});
