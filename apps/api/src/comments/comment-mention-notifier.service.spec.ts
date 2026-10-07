const mockDb = {
  user: { findUnique: jest.fn() },
  member: { findMany: jest.fn() },
  taskItem: { findFirst: jest.fn() },
  task: { findFirst: jest.fn() },
};

jest.mock('@db', () => ({
  db: mockDb,
  CommentEntityType: {
    task: 'task',
    vendor: 'vendor',
    risk: 'risk',
    finding: 'finding',
    policy: 'policy',
  },
}));

jest.mock('../utils/org-participation', () => ({
  orgParticipantMemberWhere: jest.fn().mockResolvedValue({}),
}));

jest.mock('@trycompai/email', () => ({
  isUserUnsubscribed: jest.fn().mockResolvedValue(false),
}));

jest.mock('../email/trigger-email', () => ({
  triggerEmail: jest.fn().mockResolvedValue({ id: 'email_1' }),
}));

const commentMentionedEmailMock = jest.fn<null, [unknown]>(() => null);
jest.mock('../email/templates/comment-mentioned', () => ({
  CommentMentionedEmail: (props: unknown) => commentMentionedEmailMock(props),
}));

import { CommentMentionNotifierService } from './comment-mention-notifier.service';

const ENV_KEYS = ['NEXT_PUBLIC_APP_URL', 'BETTER_AUTH_URL'] as const;

describe('CommentMentionNotifierService links', () => {
  const novu = { trigger: jest.fn().mockResolvedValue(undefined) };
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  let warn: jest.SpyInstance;
  let service: CommentMentionNotifierService;

  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of ENV_KEYS) delete process.env[key];
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockDb.user.findUnique.mockResolvedValue({ id: 'usr_actor', name: 'Ana' });
    mockDb.member.findMany.mockResolvedValue([
      { user: { id: 'usr_kyle', name: 'Kyle', email: 'person@revola.ai' } },
    ]);
    mockDb.taskItem.findFirst.mockResolvedValue(null);
    mockDb.task.findFirst.mockResolvedValue({ title: '2FA' });
    service = new CommentMentionNotifierService(novu as never);
  });

  afterEach(() => {
    warn.mockRestore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const notify = (contextUrl?: string) =>
    service.notifyMentionedUsers({
      organizationId: 'org_1',
      commentId: 'cmt_1',
      commentContent: 'hi',
      entityType: 'task',
      entityId: 'tsk_1',
      contextUrl,
      mentionedUserIds: ['usr_kyle'],
      mentionedByUserId: 'usr_actor',
    });

  const sentCommentUrl = () => {
    const props = commentMentionedEmailMock.mock.calls[0]?.[0] as {
      commentUrl?: string;
    };
    return props.commentUrl;
  };

  it('links to the comment on this deployment', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.comp.revola.ai';
    await notify();
    expect(sentCommentUrl()).toBe(
      'https://app.comp.revola.ai/org_1/tasks/tsk_1',
    );
  });

  it('keeps a context URL on this deployment', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.comp.revola.ai';
    await notify('https://app.comp.revola.ai/org_1/tasks/tsk_1?tab=comments');
    expect(sentCommentUrl()).toBe(
      'https://app.comp.revola.ai/org_1/tasks/tsk_1?tab=comments',
    );
  });

  it('rejects a context URL on an upstream host', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.comp.revola.ai';
    await notify('https://app.trycomp.ai/org_1/tasks/tsk_1');
    expect(sentCommentUrl()).toBe(
      'https://app.comp.revola.ai/org_1/tasks/tsk_1',
    );
  });

  it('still sends, without a link and never an upstream one, when the app URL is unset', async () => {
    await notify('https://app.trycomp.ai/org_1/tasks/tsk_1');
    expect(commentMentionedEmailMock).toHaveBeenCalledTimes(1);
    expect(sentCommentUrl()).toBeUndefined();
    expect(JSON.stringify(novu.trigger.mock.calls)).not.toContain('trycomp.ai');
  });
});
