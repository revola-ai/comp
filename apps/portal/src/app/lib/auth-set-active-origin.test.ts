// @vitest-environment node
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { organization } from 'better-auth/plugins';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth } from './auth';

// The portal's server-side set-active call, sent through a real better-auth
// handler (memory adapter, organization plugin) so its origin check judges the
// exact headers the portal builds.
const API_URL = 'http://localhost:3333';
const PORTAL_URL = 'https://portal.example.test';

const authServer = betterAuth({
  baseURL: API_URL,
  secret: 'portal-origin-test-secret-0123456789abcdef',
  database: memoryAdapter({
    user: [],
    session: [],
    account: [],
    verification: [],
    organization: [],
    member: [],
    invitation: [],
  }),
  trustedOrigins: [PORTAL_URL],
  // better-auth skips its origin check under a test runner unless told otherwise;
  // production runs it, so the test does too.
  advanced: { disableOriginCheck: false },
  plugins: [organization()],
  logger: { disabled: true },
});

type Answer = { status: number; body: string };
const answers: Answer[] = [];

async function handleAsApi(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const path = new URL(String(input)).pathname;
  const response = await authServer.handler(new Request(`${API_URL}${path}`, init));
  answers.push({ status: response.status, body: await response.clone().text() });
  return response;
}

function incoming(extra: Record<string, string> = {}): Headers {
  return new Headers({ cookie: 'better-auth.session_token=abc.def', ...extra });
}

describe('portal setActiveOrganization against better-auth origin check', () => {
  beforeEach(() => {
    answers.length = 0;
    vi.stubEnv('BACKEND_API_URL', 'http://comp-api.comp.internal:3333');
    vi.stubEnv('NEXT_PUBLIC_API_URL', API_URL);
    vi.stubEnv('NEXT_PUBLIC_PORTAL_URL', PORTAL_URL);
    vi.stubGlobal('fetch', vi.fn(handleAsApi));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('passes the origin check when a server component renders (no incoming Origin)', async () => {
    await auth.api.setActiveOrganization({
      headers: incoming(),
      body: { organizationId: 'org_1' },
    });

    expect(answers).toHaveLength(1);
    expect(answers[0]?.body).not.toContain('MISSING_OR_NULL_ORIGIN');
    expect(answers[0]?.body).not.toContain('INVALID_ORIGIN');
    // Past the origin check, the fake session cookie is what better-auth refuses.
    expect(answers[0]?.status).toBe(401);
  });

  it('forwards the browser Origin when the request carries one', async () => {
    await auth.api.setActiveOrganization({
      headers: incoming({ origin: PORTAL_URL }),
      body: { organizationId: 'org_1' },
    });

    const init = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('origin')).toBe(PORTAL_URL);
    expect(answers[0]?.status).toBe(401);
  });

  it('falls back to the public API URL when the portal URL is unset', async () => {
    vi.stubEnv('NEXT_PUBLIC_PORTAL_URL', '');
    await auth.api.setActiveOrganization({
      headers: incoming(),
      body: { organizationId: 'org_1' },
    });

    const init = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('origin')).toBe(API_URL);
    expect(answers[0]?.status).toBe(401);
  });

  it('is refused for a cross-site Origin', async () => {
    await auth.api.setActiveOrganization({
      headers: incoming({ origin: 'https://evil.example' }),
      body: { organizationId: 'org_1' },
    });

    expect(answers[0]?.status).toBe(403);
    expect(answers[0]?.body).toContain('INVALID_ORIGIN');
  });
});
