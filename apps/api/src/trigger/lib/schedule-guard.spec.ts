import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const mockLoggerInfo = jest.fn();
jest.mock('@trigger.dev/sdk', () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import {
  isScheduledRunAllowed,
  shouldRunScheduledTask,
} from './schedule-guard';

const TRIGGER_DIR = resolve(__dirname, '..');

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(full);
    return /\.ts$/.test(entry.name) && !/\.(test|spec)\.ts$/.test(entry.name)
      ? [full]
      : [];
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
    expect(
      shouldRunScheduledTask({ environmentType: 'SOMETHING_NEW', env: {} }),
    ).toBe(false);
  });
});

describe('isScheduledRunAllowed', () => {
  const original = process.env.COMP_RUN_SCHEDULES_IN_DEV;
  beforeEach(() => {
    delete process.env.COMP_RUN_SCHEDULES_IN_DEV;
    jest.clearAllMocks();
  });
  afterAll(() => {
    if (original === undefined) delete process.env.COMP_RUN_SCHEDULES_IN_DEV;
    else process.env.COMP_RUN_SCHEDULES_IN_DEV = original;
  });

  it('logs the skip with the opt-in hint outside production', () => {
    const allowed = isScheduledRunAllowed({
      ctx: {
        environment: { type: 'DEVELOPMENT' },
        task: { id: 'cloud-security-schedule' },
      },
    });

    expect(allowed).toBe(false);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining('COMP_RUN_SCHEDULES_IN_DEV=true'),
      expect.objectContaining({
        taskId: 'cloud-security-schedule',
        environmentType: 'DEVELOPMENT',
      }),
    );
  });

  it('allows production runs without logging a skip', () => {
    const allowed = isScheduledRunAllowed({
      ctx: {
        environment: { type: 'PRODUCTION' },
        task: { id: 'cloud-security-schedule' },
      },
    });
    expect(allowed).toBe(true);
    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });
});

describe('every schedules.task calls the schedule guard', () => {
  const scheduleFiles = listSourceFiles(TRIGGER_DIR)
    .map((file) => ({
      rel: relative(TRIGGER_DIR, file),
      source: readFileSync(file, 'utf8'),
    }))
    .filter(({ source }) => source.includes('schedules.task('));

  it('finds the scheduled tasks (scanner sanity check)', () => {
    expect(scheduleFiles.length).toBeGreaterThanOrEqual(8);
  });

  it.each(scheduleFiles.map(({ rel }) => [rel]))(
    '%s calls the guard',
    (rel) => {
      const file = scheduleFiles.find((candidate) => candidate.rel === rel);
      const source = file?.source ?? '';
      const tasks = source.split('schedules.task(').length - 1;
      const guards =
        source.match(/isScheduledRunAllowed\(\{ ctx \}\)/g)?.length ?? 0;
      expect(guards).toBeGreaterThanOrEqual(tasks);
    },
  );
});
