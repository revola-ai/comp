import { renderToStaticMarkup } from 'react-dom/server';
import { createElement, type ReactElement } from 'react';
import { AutomationBulkFailuresEmail } from './automation-bulk-failures';
import { AutomationFailuresEmail } from './automation-failures';
import { CommentMentionedEmail } from './comment-mentioned';
import { EvidenceAccessRequestSubmittedEmail } from './evidence-access-request-submitted';
import { EvidenceBulkReviewRequestedEmail } from './evidence-bulk-review-requested';
import { EvidenceReviewRequestedEmail } from './evidence-review-requested';
import { FindingNotificationEmail } from './finding-notification';
import { TaskAssigneeChangedEmail } from './task-assignee-changed';
import { TaskBulkAssigneeChangedEmail } from './task-bulk-assignee-changed';
import { TaskBulkStatusChangedEmail } from './task-bulk-status-changed';
import { TaskItemAssignedEmail } from './task-item-assigned';
import { TaskItemMentionedEmail } from './task-item-mentioned';
import { TaskStatusChangedEmail } from './task-status-changed';
import { UnassignedItemsNotificationEmail } from './unassigned-items-notification';

const EMAIL = 'person@revola.ai';
const base = { toName: 'Kyle', toEmail: EMAIL, organizationName: 'Revola' };
const url = 'https://app.comp.revola.ai/org_1/tasks/tsk_1';
const mention = {
  mentionedByName: 'Ana',
  entityName: 'Vendor',
  entityRoutePath: 'vendors',
  entityId: 'vnd_1',
  organizationId: 'org_1',
};

const cases: Array<{ name: string; element: ReactElement }> = [
  {
    name: 'automation-bulk-failures',
    element: createElement(AutomationBulkFailuresEmail, {
      ...base,
      tasksUrl: url,
      tasks: [],
    }),
  },
  {
    name: 'automation-failures',
    element: createElement(AutomationFailuresEmail, {
      ...base,
      taskTitle: 'T',
      failedCount: 1,
      totalCount: 2,
      taskStatusChanged: false,
      taskUrl: url,
    }),
  },
  {
    name: 'comment-mentioned',
    element: createElement(CommentMentionedEmail, {
      ...base,
      ...mention,
      commentContent: 'hi',
      commentUrl: url,
    }),
  },
  {
    name: 'evidence-access-request-submitted',
    element: createElement(EvidenceAccessRequestSubmittedEmail, {
      ...base,
      requesterName: 'Ana',
      accountsNeeded: 'a',
      permissionsNeeded: 'p',
      reasonForRequest: 'r',
      reviewUrl: url,
    }),
  },
  {
    name: 'evidence-bulk-review-requested',
    element: createElement(EvidenceBulkReviewRequestedEmail, {
      ...base,
      taskCount: 1,
      submittedByName: 'Ana',
      tasksUrl: url,
      tasks: [],
    }),
  },
  {
    name: 'evidence-review-requested',
    element: createElement(EvidenceReviewRequestedEmail, {
      ...base,
      taskTitle: 'T',
      submittedByName: 'Ana',
      taskUrl: url,
    }),
  },
  {
    name: 'finding-notification',
    element: createElement(FindingNotificationEmail, {
      ...base,
      heading: 'h',
      message: 'm',
      taskTitle: 'T',
      findingType: 'f',
      findingContent: 'c',
      findingUrl: url,
    }),
  },
  {
    name: 'task-assignee-changed',
    element: createElement(TaskAssigneeChangedEmail, {
      ...base,
      taskTitle: 'T',
      oldAssigneeName: 'A',
      newAssigneeName: 'B',
      changedByName: 'C',
      taskUrl: url,
    }),
  },
  {
    name: 'task-bulk-assignee-changed',
    element: createElement(TaskBulkAssigneeChangedEmail, {
      ...base,
      taskCount: 2,
      newAssigneeName: 'B',
      changedByName: 'C',
      tasksUrl: url,
    }),
  },
  {
    name: 'task-bulk-status-changed',
    element: createElement(TaskBulkStatusChangedEmail, {
      ...base,
      taskCount: 2,
      newStatus: 'done',
      changedByName: 'C',
      tasksUrl: url,
    }),
  },
  {
    name: 'task-item-assigned',
    element: createElement(TaskItemAssignedEmail, {
      ...base,
      taskTitle: 'T',
      assignedByName: 'Ana',
      taskUrl: url,
    }),
  },
  {
    name: 'task-item-mentioned',
    element: createElement(TaskItemMentionedEmail, {
      ...base,
      ...mention,
      taskTitle: 'T',
      taskUrl: url,
    }),
  },
  {
    name: 'task-status-changed',
    element: createElement(TaskStatusChangedEmail, {
      ...base,
      taskTitle: 'T',
      oldStatus: 'todo',
      newStatus: 'done',
      changedByName: 'C',
      taskUrl: url,
    }),
  },
  {
    name: 'unassigned-items-notification',
    element: createElement(UnassignedItemsNotificationEmail, {
      userName: 'Kyle',
      organizationName: 'Revola',
      organizationId: 'org_1',
      removedMemberName: 'Ana',
      unassignedItems: [],
      email: EMAIL,
    }),
  },
];

describe('notification templates and the unsubscribe secret', () => {
  const saved = {
    UNSUBSCRIBE_SECRET: process.env.UNSUBSCRIBE_SECRET,
    AUTH_SECRET: process.env.AUTH_SECRET,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  };
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it.each(cases)(
    '$name renders without an unsubscribe link when no secret is set',
    ({ element }) => {
      delete process.env.UNSUBSCRIBE_SECRET;
      delete process.env.AUTH_SECRET;
      const html = renderToStaticMarkup(element);
      expect(html).toContain('<body');
      // No dead link: the whole unsubscribe footer is left out.
      expect(html).not.toContain('/unsubscribe/preferences');
      expect(html).not.toContain('Manage your email preferences');
      expect(html).not.toContain('>Unsubscribe<');
    },
  );

  it.each(cases)(
    '$name links to the preferences page when the secret is set',
    ({ element }) => {
      process.env.UNSUBSCRIBE_SECRET = 'unsubscribe-test-secret';
      process.env.NEXT_PUBLIC_APP_URL = 'https://app.comp.revola.ai';
      const html = renderToStaticMarkup(element);
      expect(html).toContain(
        'https://app.comp.revola.ai/unsubscribe/preferences?email=person%40revola.ai',
      );
    },
  );
});
