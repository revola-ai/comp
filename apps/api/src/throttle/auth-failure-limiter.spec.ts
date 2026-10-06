import {
  AUTH_FAILURE_LIMIT,
  AUTH_FAILURE_WINDOW_MS,
  AuthFailureLimiter,
} from './auth-failure-limiter';

describe('AuthFailureLimiter', () => {
  const T0 = 1_000_000;

  function failTimes({
    limiter,
    key,
    times,
    now,
  }: {
    limiter: AuthFailureLimiter;
    key: string;
    times: number;
    now: number;
  }): void {
    for (let i = 0; i < times; i += 1) limiter.recordFailure({ key, now });
  }

  it('blocks a key once it reaches the limit within the window', () => {
    const limiter = new AuthFailureLimiter();
    failTimes({ limiter, key: 'ip:a', times: AUTH_FAILURE_LIMIT - 1, now: T0 });
    expect(limiter.retryAfterMs({ key: 'ip:a', now: T0 })).toBe(0);
    limiter.recordFailure({ key: 'ip:a', now: T0 });
    expect(limiter.retryAfterMs({ key: 'ip:a', now: T0 })).toBe(
      AUTH_FAILURE_WINDOW_MS,
    );
  });

  it('keeps other keys independent', () => {
    const limiter = new AuthFailureLimiter();
    failTimes({ limiter, key: 'ip:a', times: AUTH_FAILURE_LIMIT, now: T0 });
    expect(limiter.retryAfterMs({ key: 'ip:b', now: T0 })).toBe(0);
  });

  it('unblocks when the window that reached the limit ends', () => {
    const limiter = new AuthFailureLimiter();
    failTimes({ limiter, key: 'ip:a', times: AUTH_FAILURE_LIMIT, now: T0 });
    const end = T0 + AUTH_FAILURE_WINDOW_MS;
    expect(limiter.retryAfterMs({ key: 'ip:a', now: end - 1 })).toBe(1);
    expect(limiter.retryAfterMs({ key: 'ip:a', now: end })).toBe(0);
  });

  it('starts a fresh window after the previous one ends', () => {
    const limiter = new AuthFailureLimiter();
    failTimes({ limiter, key: 'ip:a', times: AUTH_FAILURE_LIMIT - 1, now: T0 });
    const later = T0 + AUTH_FAILURE_WINDOW_MS;
    limiter.recordFailure({ key: 'ip:a', now: later });
    expect(limiter.retryAfterMs({ key: 'ip:a', now: later })).toBe(0);
  });

  it('drops expired windows so memory stays bounded by recent failures', () => {
    const limiter = new AuthFailureLimiter();
    for (let i = 0; i < 50; i += 1) {
      limiter.recordFailure({ key: `ip:${i}`, now: T0 });
    }
    limiter.recordFailure({
      key: 'ip:late',
      now: T0 + 2 * AUTH_FAILURE_WINDOW_MS,
    });
    expect(limiter.trackedKeys()).toBe(1);
  });
});
