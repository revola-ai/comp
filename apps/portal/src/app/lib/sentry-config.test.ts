import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No DSN means no Sentry: the configs must never fall back to upstream Comp's
// Sentry project, which would ship Revola errors, request data and session replays
// to upstream.

const { init } = vi.hoisted(() => ({ init: vi.fn() }));

vi.mock('@sentry/nextjs', () => ({
  init,
  replayIntegration: vi.fn(() => ({})),
  captureRouterTransitionStart: vi.fn(),
}));
vi.mock('botid/client/core', () => ({ initBotId: vi.fn() }));

const CONFIGS = [
  {
    file: '../../../sentry.server.config',
    env: 'SENTRY_DSN',
    load: () => import('../../../sentry.server.config'),
  },
  {
    file: '../../../sentry.edge.config',
    env: 'SENTRY_DSN',
    load: () => import('../../../sentry.edge.config'),
  },
  {
    file: '../../instrumentation-client',
    env: 'NEXT_PUBLIC_SENTRY_DSN',
    load: () => import('../../instrumentation-client'),
  },
];

/** The options the config passed to Sentry.init. */
async function initOptions(load: () => Promise<unknown>): Promise<Record<string, unknown>> {
  vi.resetModules();
  init.mockClear();
  await load();
  return init.mock.calls[0]?.[0] as Record<string, unknown>;
}

describe('Sentry configs', () => {
  beforeEach(() => {
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_VERCEL_ENV', 'production');
  });
  afterEach(() => vi.unstubAllEnvs());

  for (const { file, env, load } of CONFIGS) {
    it(`${file} sends nothing without ${env}`, async () => {
      vi.stubEnv('SENTRY_DSN', undefined);
      vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', undefined);
      const options = await initOptions(load);
      expect(options.dsn).toBeUndefined();
      expect(options.enabled).toBe(false);
      expect(JSON.stringify(options)).not.toContain('sentry.io');
    });

    it(`${file} reports to the configured ${env}`, async () => {
      vi.stubEnv(env, 'https://key@o1.ingest.example.com/2');
      const options = await initOptions(load);
      expect(options.dsn).toBe('https://key@o1.ingest.example.com/2');
      expect(options.enabled).toBe(true);
    });
  }
});
