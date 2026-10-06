// Mock module boundaries: the Trigger SDK (schemaTask returns its config, so a task IS
// its config and `run` can be called directly) and the Resend client.
const mockSend = jest.fn();
const mockBatchSend = jest.fn();

jest.mock('@trigger.dev/sdk', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  queue: jest.fn(() => ({})),
  schemaTask: (config: unknown) => config,
}));

jest.mock('../../email/resend', () => ({
  resend: { emails: { send: mockSend }, batch: { send: mockBatchSend } },
}));

import { sendBatchEmailTask } from './send-batch-email';
import { sendEmailTask } from './send-email';

type SendParams = { to: string; subject: string; html: string };
type Runnable<P> = { run: (params: P) => Promise<unknown> };
type SentHeaders = { headers?: Record<string, string> };

const EMAIL = 'person@revola.ai';
const message: SendParams = { to: EMAIL, subject: 'Hello', html: '<p>hi</p>' };

// schemaTask is mocked to return its config, so each task IS its config and has `run`.
const sendEmail = sendEmailTask as unknown as Runnable<SendParams>;
const sendBatch = sendBatchEmailTask as unknown as Runnable<{
  emails: SendParams[];
}>;

describe('email tasks and the List-Unsubscribe header', () => {
  const saved = {
    UNSUBSCRIBE_SECRET: process.env.UNSUBSCRIBE_SECRET,
    AUTH_SECRET: process.env.AUTH_SECRET,
    RESEND_FROM_SYSTEM: process.env.RESEND_FROM_SYSTEM,
    RESEND_TO_TEST: process.env.RESEND_TO_TEST,
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  };
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    process.env.RESEND_FROM_SYSTEM = 'Comp <noreply@revola.ai>';
    process.env.NEXT_PUBLIC_API_URL = 'https://api.comp.revola.ai';
    delete process.env.RESEND_TO_TEST;
    delete process.env.AUTH_SECRET;
    mockSend
      .mockReset()
      .mockResolvedValue({ data: { id: 'em_1' }, error: null });
    mockBatchSend
      .mockReset()
      .mockResolvedValue({ data: { data: [{ id: 'em_1' }] }, error: null });
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    warn.mockRestore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /** send-email holds its queue slot for 1s after sending; skip the wait. */
  async function runSendEmail(task: Runnable<SendParams>) {
    const done = task.run(message);
    await jest.runAllTimersAsync();
    return done;
  }

  const sentHeaders = (mock: jest.Mock, index = 0): SentHeaders =>
    mock.mock.calls[index]?.[0] as SentHeaders;

  describe('without an unsubscribe secret', () => {
    beforeEach(() => delete process.env.UNSUBSCRIBE_SECRET);

    // Runs first in this file: the email package warns once per process (module).
    it('send-email still sends, without List-Unsubscribe, warning once', async () => {
      await expect(runSendEmail(sendEmail)).resolves.toEqual({ id: 'em_1' });
      await runSendEmail(sendEmail);
      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(
        sentHeaders(mockSend).headers?.['List-Unsubscribe'],
      ).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('UNSUBSCRIBE_SECRET');
    });

    it('send-batch-email still sends every message, without List-Unsubscribe', async () => {
      await sendBatch.run({
        emails: [message, { ...message, to: 'second@revola.ai' }],
      });
      const payload = mockBatchSend.mock.calls[0]?.[0] as SentHeaders[];
      expect(payload).toHaveLength(2);
      for (const item of payload)
        expect(item.headers?.['List-Unsubscribe']).toBeUndefined();
      // Already warned by the previous test in this process: no second warning.
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('with an unsubscribe secret', () => {
    beforeEach(() => {
      process.env.UNSUBSCRIBE_SECRET = 'unsubscribe-test-secret';
    });

    it('send-email adds the one-click List-Unsubscribe headers', async () => {
      await runSendEmail(sendEmail);
      const { headers } = sentHeaders(mockSend);
      expect(headers?.['List-Unsubscribe']).toMatch(
        /^<https:\/\/api\.comp\.revola\.ai\/v1\/email\/unsubscribe\?email=person%40revola\.ai&token=[^>]+>$/,
      );
      expect(headers?.['List-Unsubscribe-Post']).toBe(
        'List-Unsubscribe=One-Click',
      );
      expect(warn).not.toHaveBeenCalled();
    });

    it('send-batch-email adds the headers to every message', async () => {
      await sendBatch.run({ emails: [message] });
      const [item] = mockBatchSend.mock.calls[0]?.[0] as SentHeaders[];
      expect(item?.headers?.['List-Unsubscribe']).toContain(
        '/v1/email/unsubscribe?email=',
      );
      expect(item?.headers?.['List-Unsubscribe-Post']).toBe(
        'List-Unsubscribe=One-Click',
      );
    });
  });
});
