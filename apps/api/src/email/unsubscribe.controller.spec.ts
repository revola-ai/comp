import { BadRequestException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { UnsubscribeController } from './unsubscribe.controller';

const mockFindUnique = jest.fn();
const mockUpdate = jest.fn();
jest.mock('@db', () => ({
  db: {
    user: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
  },
}));

const EMAIL = 'person@revola.ai';
const SECRET = 'unsubscribe-test-secret';
const sign = (secret: string) =>
  createHmac('sha256', secret).update(EMAIL).digest('base64url');

describe('UnsubscribeController', () => {
  const controller = new UnsubscribeController();
  const saved = {
    UNSUBSCRIBE_SECRET: process.env.UNSUBSCRIBE_SECRET,
    AUTH_SECRET: process.env.AUTH_SECRET,
  };

  beforeEach(() => {
    process.env.UNSUBSCRIBE_SECRET = SECRET;
    delete process.env.AUTH_SECRET;
    mockFindUnique.mockReset().mockResolvedValue({ id: 'usr_1' });
    mockUpdate.mockReset().mockResolvedValue({});
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('unsubscribes with a token signed by the configured secret', async () => {
    await expect(controller.unsubscribe(EMAIL, sign(SECRET))).resolves.toEqual({
      success: true,
    });
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it('rejects a token forged with the old public fallback secret', async () => {
    await expect(
      controller.unsubscribe(EMAIL, sign('fallback-secret')),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('refuses to verify anything when no secret is configured', async () => {
    delete process.env.UNSUBSCRIBE_SECRET;
    await expect(
      controller.unsubscribe(EMAIL, sign('fallback-secret')),
    ).rejects.toThrow('UNSUBSCRIBE_SECRET');
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
