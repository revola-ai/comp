import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), update: vi.fn() }));

vi.mock('@db/server', () => ({
  db: { user: { findUnique: mocks.findUnique, update: mocks.update } },
}));

import { PUT } from './route';

const EMAIL = 'person@revola.ai';
const SECRET = 'unsubscribe-test-secret';
const preferences = {
  policyNotifications: true,
  taskReminders: false,
  weeklyTaskDigest: true,
  unassignedItemsNotifications: true,
  taskMentions: true,
  taskAssignments: true,
};

function put(token: string): Request {
  return new Request('http://localhost/api/email-preferences', {
    method: 'PUT',
    body: JSON.stringify({ email: EMAIL, token, preferences }),
  });
}

describe('PUT /api/email-preferences', () => {
  beforeEach(() => {
    vi.stubEnv('AUTH_SECRET', '');
    mocks.findUnique.mockReset().mockResolvedValue({ id: 'usr_1' });
    mocks.update.mockReset().mockResolvedValue({});
  });
  afterEach(() => vi.unstubAllEnvs());

  it('answers a named 503 when no unsubscribe secret is configured', async () => {
    vi.stubEnv('UNSUBSCRIBE_SECRET', '');
    const response = await PUT(put('any-token'));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'unsubscribe_not_configured',
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('keeps a 403 for a token not signed by the configured secret', async () => {
    vi.stubEnv('UNSUBSCRIBE_SECRET', SECRET);
    const forged = createHmac('sha256', 'fallback-secret').update(EMAIL).digest('base64url');
    const response = await PUT(put(forged));
    expect(response.status).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('saves preferences for a valid token', async () => {
    vi.stubEnv('UNSUBSCRIBE_SECRET', SECRET);
    const token = createHmac('sha256', SECRET).update(EMAIL).digest('base64url');
    const response = await PUT(put(token));
    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });
});
