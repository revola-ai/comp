import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appPolicyUrl, appTaskUrl, portalPolicyUrl } from './app-links';

const ids = { organizationId: 'org_1' };

describe('links in scheduled task and policy notifications', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    warn.mockRestore();
  });

  it('point at this deployment when the public URLs are set', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.comp.revola.ai/');
    vi.stubEnv('NEXT_PUBLIC_PORTAL_URL', 'https://portal.comp.revola.ai');
    expect(appTaskUrl({ ...ids, taskId: 'tsk_1' })).toBe(
      'https://app.comp.revola.ai/org_1/tasks/tsk_1',
    );
    expect(appPolicyUrl({ ...ids, policyId: 'pol_1' })).toBe(
      'https://app.comp.revola.ai/org_1/policies/pol_1',
    );
    expect(portalPolicyUrl({ ...ids, policyId: 'pol_1' })).toBe(
      'https://portal.comp.revola.ai/org_1/policy/pol_1',
    );
  });

  it('are left out, never pointing at an upstream host, when the public URLs are unset', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', undefined);
    vi.stubEnv('NEXT_PUBLIC_PORTAL_URL', undefined);
    expect(appTaskUrl({ ...ids, taskId: 'tsk_1' })).toBeUndefined();
    expect(appPolicyUrl({ ...ids, policyId: 'pol_1' })).toBeUndefined();
    expect(portalPolicyUrl({ ...ids, policyId: 'pol_1' })).toBeUndefined();
  });
});
