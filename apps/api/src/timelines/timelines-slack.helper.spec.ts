import { notifyReadyForReview } from './timelines-slack.helper';

const ENV_KEYS = [
  'SLACK_CX_WEBHOOK_URL',
  'NEXT_PUBLIC_APP_URL',
  'APP_URL',
  'BETTER_AUTH_URL',
] as const;

describe('timeline Slack notifications', () => {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  let fetchSpy: jest.SpyInstance<Promise<Response>, Parameters<typeof fetch>>;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.SLACK_CX_WEBHOOK_URL = 'https://hooks.slack.test/cx';
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('ok'));
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    warn.mockRestore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const postedText = async () => {
    await notifyReadyForReview({
      orgId: 'org_1',
      orgName: 'Revola',
      frameworkName: 'SOC 2',
      phaseName: 'Readiness',
    });
    return fetchSpy.mock.calls[0]?.[1]?.body as string;
  };

  it('links the org to its admin timeline on the app', async () => {
    process.env.APP_URL = 'https://app.comp.revola.ai/';
    process.env.BETTER_AUTH_URL = 'https://api.comp.revola.ai';
    expect(await postedText()).toContain(
      '<https://app.comp.revola.ai/org_1/admin/organizations/org_1|Revola>',
    );
  });

  it('posts the org name without a link, never the API host or an upstream one', async () => {
    process.env.BETTER_AUTH_URL = 'https://api.comp.revola.ai';
    const text = await postedText();
    expect(text).toContain('*Revola*');
    expect(text).not.toContain('api.comp.revola.ai');
    expect(text).not.toContain('trycomp.ai');
  });
});
