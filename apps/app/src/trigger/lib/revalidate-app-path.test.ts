import axios, { AxiosError, AxiosHeaders, type InternalAxiosRequestConfig } from 'axios';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logged: unknown[][] = [];
vi.mock('@trigger.dev/sdk', () => {
  const record =
    (level: string) =>
    (...args: unknown[]) =>
      logged.push([level, ...args]);
  return { logger: { info: record('info'), warn: record('warn'), error: record('error') } };
});

import { revalidateAppPath } from './revalidate-app-path';

const SECRET = 'revalidation-secret-never-logged';
const APP_URL = 'https://app.comp.revola.ai';

/** The AxiosError axios throws for a refused POST: its config carries the body. */
function refusedPost(status: number): AxiosError {
  const config: InternalAxiosRequestConfig = {
    url: `${APP_URL}/api/revalidate/path`,
    method: 'post',
    headers: new AxiosHeaders({ 'Content-Type': 'application/json' }),
    data: JSON.stringify({ path: '/org_1', secret: SECRET }),
  };
  return new AxiosError(
    `Request failed with status code ${status}`,
    AxiosError.ERR_BAD_RESPONSE,
    config,
    {},
    { status, statusText: 'Error', headers: {}, config, data: { secret: SECRET } },
  );
}

function allLogs(): string {
  return JSON.stringify(logged, (_key, value: unknown) =>
    value instanceof Error ? { ...value, message: value.message, stack: value.stack } : value,
  );
}

describe('revalidateAppPath', () => {
  beforeEach(() => {
    logged.length = 0;
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL);
    vi.stubEnv('REVALIDATION_SECRET', SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('posts the path, type and secret to the app revalidation route', async () => {
    const post = vi
      .spyOn(axios, 'post')
      .mockResolvedValue({ status: 200, data: { revalidated: true } });

    await expect(revalidateAppPath({ path: '/org_1', type: 'layout' })).resolves.toBe(true);

    expect(post).toHaveBeenCalledWith(`${APP_URL}/api/revalidate/path`, {
      path: '/org_1',
      type: 'layout',
      secret: SECRET,
    });
  });

  it('logs only the message and HTTP status when the route refuses, never the secret', async () => {
    vi.spyOn(axios, 'post').mockRejectedValue(refusedPost(500));

    await expect(revalidateAppPath({ path: '/org_1' })).resolves.toBe(false);

    expect(allLogs()).not.toContain(SECRET);
    const failure = logged.find(([level]) => level === 'error');
    expect(failure?.[2]).toEqual({
      path: '/org_1',
      status: 500,
      error: 'Request failed with status code 500',
    });
  });

  it('logs a network failure without the secret', async () => {
    vi.spyOn(axios, 'post').mockRejectedValue(new Error(`connect ECONNREFUSED ${SECRET}`));

    await expect(revalidateAppPath({ path: '/org_1' })).resolves.toBe(false);

    expect(allLogs()).not.toContain(SECRET);
  });

  it('logs the status when the route answers without revalidating', async () => {
    vi.spyOn(axios, 'post').mockResolvedValue({
      status: 200,
      data: { revalidated: false, secret: SECRET },
    });

    await expect(revalidateAppPath({ path: '/org_1' })).resolves.toBe(false);

    expect(allLogs()).not.toContain(SECRET);
    expect(logged.some(([level]) => level === 'error')).toBe(true);
  });

  it('never throws when the app URL is not configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    await expect(revalidateAppPath({ path: '/org_1' })).resolves.toBe(false);
  });
});

describe('trigger revalidation call sites', () => {
  const TRIGGER_DIR = resolve(__dirname, '..');
  const HELPER = 'lib/revalidate-app-path.ts';

  function listSourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return listSourceFiles(full);
      return /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) ? [full] : [];
    });
  }

  it('only the helper posts to the revalidation route or reads REVALIDATION_SECRET', () => {
    const offenders = listSourceFiles(TRIGGER_DIR)
      .map((file) => ({ rel: relative(TRIGGER_DIR, file), source: readFileSync(file, 'utf8') }))
      .filter(({ rel }) => rel !== HELPER && rel !== 'lib/revalidate-url.ts')
      .filter(({ source }) => /getRevalidateUrl\(|REVALIDATION_SECRET/.test(source))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });
});
