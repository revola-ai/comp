import { render } from '@react-email/render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnassignedItemsNotificationEmail } from './unassigned-items-notification';

describe('email app links', () => {
  beforeEach(() => {
    vi.stubEnv('UNSUBSCRIBE_SECRET', 'unsubscribe-test-secret');
    vi.stubEnv('NEXT_PUBLIC_BETTER_AUTH_URL', 'https://api.comp.revola.ai');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.comp.revola.ai');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('unassigned-items links to the app host, never the API host', async () => {
    const html = await render(
      <UnassignedItemsNotificationEmail
        email="person@revola.ai"
        userName="Kyle"
        organizationName="Revola"
        organizationId="org_1"
        removedMemberName="Former Member"
        unassignedItems={[{ type: 'task', id: 'tsk_1', name: 'Task one' }]}
      />,
    );
    expect(html).toContain('https://app.comp.revola.ai/org_1');
    expect(html).not.toContain('https://api.comp.revola.ai');
  });
});
