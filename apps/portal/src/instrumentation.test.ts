import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

vi.mock('@sentry/nextjs', () => ({ captureRequestError: vi.fn() }));
vi.mock('../sentry.server.config', () => ({}));
vi.mock('../sentry.edge.config', () => ({}));

import { register } from './instrumentation';

const REMOTE_URL = 'postgresql://postgres.ref:s3cret@pooler.example.com:5432/postgres';

describe('register', () => {
  let exit: MockInstance<typeof process.exit>;
  let consoleError: MockInstance<typeof console.error>;

  beforeEach(() => {
    exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PHASE', '');
    vi.stubEnv('DATABASE_URL', REMOTE_URL);
    vi.stubEnv('DATABASE_SSL_CA', '');
    vi.stubEnv('PRISMA_ALLOW_INSECURE_TLS', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('exits 1 at boot with ca_file_missing when production has no DATABASE_SSL_CA', async () => {
    await register();
    expect(exit).toHaveBeenCalledWith(1);
    const printed = consoleError.mock.calls.flat().join('\n');
    expect(printed).toContain('ca_file_missing');
    expect(printed).not.toContain('s3cret');
    expect(printed).not.toContain('pooler.example.com');
  });

  it('does not check the database during next build', async () => {
    vi.stubEnv('NEXT_PHASE', 'phase-production-build');
    await register();
    expect(exit).not.toHaveBeenCalled();
  });

  it('boots when the opt-out is explicit', async () => {
    vi.stubEnv('PRISMA_ALLOW_INSECURE_TLS', '1');
    await register();
    expect(exit).not.toHaveBeenCalled();
  });

  it('does not check the database in the edge runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    await register();
    expect(exit).not.toHaveBeenCalled();
  });
});
