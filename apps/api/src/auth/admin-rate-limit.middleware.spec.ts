import type { Request, Response } from 'express';

const mockLimit = jest.fn();

const MockRatelimit = jest.fn().mockImplementation(() => ({
  limit: mockLimit,
}));
(MockRatelimit as unknown as Record<string, unknown>).slidingWindow = jest
  .fn()
  .mockReturnValue('sliding-window-config');

jest.mock('@upstash/ratelimit', () => ({
  Ratelimit: MockRatelimit,
}));

jest.mock('@upstash/redis', () => ({
  Redis: jest.fn(),
}));

// Set env vars before importing the middleware
process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

import { adminAuthRateLimiter } from './admin-rate-limit.middleware';
import { identityTracker } from '../throttle/identity-tracker';

const ORIGIN = 'B'.repeat(64);
process.env.COMP_ORIGIN_AUTH = ORIGIN;

function buildReq(
  path: string,
  ip = '127.0.0.1',
  headers: Record<string, string> = {},
): Request {
  return {
    path,
    ip,
    headers,
    socket: { remoteAddress: ip },
  } as unknown as Request;
}

function buildRes(): Response & { statusCode: number; body: unknown } {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: unknown) {
      res.body = data;
      return res;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

describe('adminAuthRateLimiter', () => {
  beforeEach(() => {
    mockLimit.mockReset();
    mockLimit.mockResolvedValue({ success: true });
  });

  it('passes through requests that are not admin auth routes', async () => {
    const next = jest.fn();
    await adminAuthRateLimiter(buildReq('/api/auth/sign-in'), buildRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(mockLimit).not.toHaveBeenCalled();
  });

  it('passes through non-auth requests', async () => {
    const next = jest.fn();
    await adminAuthRateLimiter(buildReq('/v1/policies'), buildRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(mockLimit).not.toHaveBeenCalled();
  });

  it('allows admin auth requests when rate limit succeeds', async () => {
    const next = jest.fn();
    await adminAuthRateLimiter(
      buildReq('/api/auth/admin/impersonate-user'),
      buildRes(),
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(mockLimit).toHaveBeenCalledWith('ip:127.0.0.1');
  });

  it('rejects requests when rate limit is exceeded', async () => {
    mockLimit.mockResolvedValue({ success: false });

    const next = jest.fn();
    const res = buildRes();
    await adminAuthRateLimiter(buildReq('/api/auth/admin/set-role'), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual({
      error: 'Too many requests to admin endpoints. Try again later.',
    });
  });

  it('keys on the shared identity tracker', async () => {
    const next = jest.fn();
    for (const req of [
      buildReq('/api/auth/admin/set-role', '10.0.0.1'),
      buildReq('/api/auth/admin/set-role', '10.0.0.2', {
        'x-comp-origin-auth': ORIGIN,
        'cf-connecting-ip': '192.0.2.44',
      }),
    ]) {
      mockLimit.mockClear();
      await adminAuthRateLimiter(req, buildRes(), next);
      expect(mockLimit).toHaveBeenCalledWith(identityTracker({ req }));
    }
    expect(mockLimit).toHaveBeenCalledWith('ip:192.0.2.44');
  });

  it('ignores forged client IP headers without the origin header', async () => {
    await adminAuthRateLimiter(
      buildReq('/api/auth/admin/set-role', '10.0.0.1', {
        'cf-connecting-ip': '198.51.100.9',
        'x-forwarded-for': '198.51.100.9',
      }),
      buildRes(),
      jest.fn(),
    );
    expect(mockLimit).toHaveBeenCalledWith('ip:10.0.0.1');
  });

  it('allows request through when Redis is unreachable', async () => {
    mockLimit.mockRejectedValue(new Error('Redis connection failed'));

    const next = jest.fn();
    await adminAuthRateLimiter(
      buildReq('/api/auth/admin/set-role'),
      buildRes(),
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
  });
});
