const ENV_KEYS = [
  'NEXT_PUBLIC_APP_URL',
  'BETTER_AUTH_URL',
  'NEXT_PUBLIC_PORTAL_URL',
] as const;

/** A fresh copy of the module, so its once-per-process warnings start unsent. */
function freshModule(): typeof import('./public-url') {
  let mod: typeof import('./public-url') | undefined;
  jest.isolateModules(() => {
    mod = jest.requireActual<typeof import('./public-url')>('./public-url');
  });
  if (!mod) throw new Error('public-url did not load');
  return mod;
}

describe('public URLs for links in emails and notifications', () => {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  let warn: jest.SpyInstance;

  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('uses NEXT_PUBLIC_APP_URL, then BETTER_AUTH_URL, trimmed and without a trailing slash', () => {
    const { appBaseUrl } = freshModule();
    process.env.BETTER_AUTH_URL = ' https://api.comp.revola.ai/ ';
    expect(appBaseUrl()).toBe('https://api.comp.revola.ai');
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.comp.revola.ai//';
    expect(appBaseUrl()).toBe('https://app.comp.revola.ai');
  });

  it('returns undefined, never an upstream host, and warns once naming the variables', () => {
    const { appBaseUrl, portalBaseUrl, appLink } = freshModule();
    process.env.NEXT_PUBLIC_APP_URL = '   ';
    expect(appBaseUrl()).toBeUndefined();
    expect(appLink({ path: '/org_1/tasks/tsk_1' })).toBeUndefined();
    expect(portalBaseUrl()).toBeUndefined();
    expect(portalBaseUrl()).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]?.[0])).toContain('NEXT_PUBLIC_APP_URL');
    expect(String(warn.mock.calls[0]?.[0])).toContain('BETTER_AUTH_URL');
    expect(String(warn.mock.calls[1]?.[0])).toContain('NEXT_PUBLIC_PORTAL_URL');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('trycomp.ai');
  });

  it('builds app links with search parameters and a hash', () => {
    const { appLink } = freshModule();
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.comp.revola.ai/';
    expect(
      appLink({
        path: '/org_1/vendors/vnd_1',
        searchParams: { taskItemId: 'tki_1' },
        hash: 'task-items',
      }),
    ).toBe(
      'https://app.comp.revola.ai/org_1/vendors/vnd_1?taskItemId=tki_1#task-items',
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('portalBaseUrl reads NEXT_PUBLIC_PORTAL_URL only', () => {
    const { portalBaseUrl } = freshModule();
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.comp.revola.ai';
    process.env.NEXT_PUBLIC_PORTAL_URL = 'https://portal.comp.revola.ai/';
    expect(portalBaseUrl()).toBe('https://portal.comp.revola.ai');
  });
});
