import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../proxy';
import { APP_PUBLIC_ASSETS } from './public-assets';

const APP_ROOT = resolve(__dirname, '../..');
const REPO_ROOT = resolve(APP_ROOT, '../..');

/** Whether the proxy (session check) runs for a path, using its matcher as a regex. */
const proxyRunsFor = (path: string) =>
  config.matcher.some((pattern) => new RegExp(`^${pattern}$`).test(path));

describe('APP_PUBLIC_ASSETS', () => {
  it('lists the email logo', () => {
    expect(APP_PUBLIC_ASSETS).toContain('/email/logo.png');
  });

  it.each(APP_PUBLIC_ASSETS)('%s is a file in apps/app/public', (path) => {
    expect(existsSync(resolve(APP_ROOT, 'public', `.${path}`))).toBe(true);
  });

  it.each(APP_PUBLIC_ASSETS)('%s is served without the session proxy', (path) => {
    expect(proxyRunsFor(path)).toBe(false);
  });

  it('still runs the proxy for app pages (the matcher check is meaningful)', () => {
    expect(proxyRunsFor('/org_1/tasks')).toBe(true);
  });

  it.each(['packages/email/components/logo.tsx', 'apps/api/src/email/components/logo.tsx'])(
    'the logo path in %s is listed',
    (file) => {
      const match = readFileSync(resolve(REPO_ROOT, file), 'utf8').match(
        /EMAIL_LOGO_PATH = '([^']+)'/,
      );
      expect(APP_PUBLIC_ASSETS).toContain(match?.[1]);
    },
  );
});
