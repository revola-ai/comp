import { render } from '@react-email/render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AllPolicyNotificationEmail } from './all-policy-notification';
import { InvitePortalEmail } from './invite-portal';
import { PolicyAcknowledgmentDigestEmail } from './policy-acknowledgment-digest';
import { PolicyNotificationEmail } from './policy-notification';
import { TaskReminderEmail } from './reminders/task-reminder';
import { TaskStatusNotificationEmail } from './reminders/task-status-notification';
import { WeeklyTaskDigestEmail } from './reminders/weekly-task-digest';
import { UnassignedItemsNotificationEmail } from './unassigned-items-notification';

// A laptop without the public URLs must never link recipients to upstream Comp's hosts
// (which would hand them org and record ids, addresses and signed unsubscribe tokens):
// the link is left out instead.

const UPSTREAM_HOST = /(app|portal|api)\.trycomp\.ai/;
const EMAIL = 'person@revola.ai';

const cases = [
  {
    name: 'all-policy-notification',
    host: 'https://portal.comp.revola.ai/org_1',
    el: () => (
      <AllPolicyNotificationEmail
        email={EMAIL}
        userName="Kyle"
        organizationName="Revola"
        organizationId="org_1"
      />
    ),
  },
  {
    name: 'invite-portal',
    host: undefined,
    el: () => <InvitePortalEmail email={EMAIL} organizationName="Revola" />,
  },
  {
    name: 'policy-notification',
    host: 'https://portal.comp.revola.ai/org_1',
    el: () => (
      <PolicyNotificationEmail
        email={EMAIL}
        userName="Kyle"
        policyName="Access Policy"
        organizationName="Revola"
        organizationId="org_1"
        notificationType="new"
      />
    ),
  },
  {
    name: 'policy-acknowledgment-digest',
    host: 'https://portal.comp.revola.ai/org_1',
    el: () => (
      <PolicyAcknowledgmentDigestEmail
        email={EMAIL}
        userName="Kyle"
        orgs={[{ id: 'org_1', name: 'Revola', policies: [{ id: 'p1', name: 'Access Policy' }] }]}
      />
    ),
  },
  {
    name: 'task-reminder',
    host: 'https://app.comp.revola.ai/org_1/tasks/t1',
    el: () => (
      <TaskReminderEmail
        email={EMAIL}
        name="Kyle"
        dueDate="2026-10-07"
        recordId="/org_1/tasks/t1"
      />
    ),
  },
  {
    name: 'task-status-notification',
    host: undefined,
    el: () => (
      <TaskStatusNotificationEmail
        email={EMAIL}
        userName="Kyle"
        taskName="Task"
        taskStatus="todo"
        organizationName="Revola"
      />
    ),
  },
  {
    name: 'weekly-task-digest',
    host: 'https://app.comp.revola.ai/org_1/tasks',
    el: () => (
      <WeeklyTaskDigestEmail
        email={EMAIL}
        userName="Kyle"
        organizationName="Revola"
        organizationId="org_1"
        tasks={[{ id: 't1', title: 'Task one' }]}
      />
    ),
  },
  {
    name: 'unassigned-items-notification',
    host: 'https://app.comp.revola.ai/org_1',
    el: () => (
      <UnassignedItemsNotificationEmail
        email={EMAIL}
        userName="Kyle"
        organizationName="Revola"
        organizationId="org_1"
        removedMemberName="Former Member"
        unassignedItems={[{ type: 'task', id: 't1', name: 'Task one' }]}
      />
    ),
  },
];

/** Every href in the rendered HTML. */
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1] ?? '');

describe('email links without the public URLs', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv('UNSUBSCRIBE_SECRET', 'unsubscribe-test-secret');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', undefined);
    vi.stubEnv('NEXT_PUBLIC_PORTAL_URL', undefined);
    vi.stubEnv('NEXT_PUBLIC_API_URL', undefined);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    warn.mockRestore();
  });

  for (const { name, el } of cases) {
    it(`${name} renders without links to upstream hosts or empty links`, async () => {
      const html = await render(el());
      expect(html).toContain('<body');
      expect(html).not.toMatch(UPSTREAM_HOST);
      expect(html).not.toContain('copy and paste this URL');
      expect(html).not.toContain('/unsubscribe/preferences');
      for (const href of hrefs(html)) expect(href).not.toBe('');
    });
  }
});

describe('email links with the public URLs', () => {
  beforeEach(() => {
    vi.stubEnv('UNSUBSCRIBE_SECRET', 'unsubscribe-test-secret');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.comp.revola.ai/');
    vi.stubEnv('NEXT_PUBLIC_PORTAL_URL', 'https://portal.comp.revola.ai/');
  });
  afterEach(() => vi.unstubAllEnvs());

  for (const { name, host, el } of cases) {
    if (!host) continue;
    it(`${name} links to this deployment`, async () => {
      const html = await render(el());
      expect(hrefs(html)).toContain(host);
      expect(html).toContain('https://app.comp.revola.ai/unsubscribe/preferences?');
      expect(html).not.toMatch(UPSTREAM_HOST);
    });
  }

  it('task-status-notification links to the task URL it is given', async () => {
    const html = await render(
      <TaskStatusNotificationEmail
        email={EMAIL}
        userName="Kyle"
        taskName="Task"
        taskStatus="failed"
        organizationName="Revola"
        taskUrl="https://app.comp.revola.ai/org_1/tasks/t1"
      />,
    );
    expect(hrefs(html)).toContain('https://app.comp.revola.ai/org_1/tasks/t1');
    expect(html).toContain('copy and paste this URL');
  });
});
