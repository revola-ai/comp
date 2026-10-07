import {
  AUTH_FAILURE_LIMIT,
  AUTH_FAILURE_WINDOW_MS,
  AuthFailureLimiter,
  type AuthFailureReservation,
} from './auth-failure-limiter';

describe('AuthFailureLimiter (slots reserved at arrival, refunded on success)', () => {
  const T0 = 1_000_000;

  function reserveTimes({
    limiter,
    key,
    times,
    now,
  }: {
    limiter: AuthFailureLimiter;
    key: string;
    times: number;
    now: number;
  }): AuthFailureReservation[] {
    return Array.from({ length: times }, () => limiter.reserve({ key, now }));
  }

  it('grants the limit of slots in a window, then refuses with the time left', () => {
    const limiter = new AuthFailureLimiter();
    const granted = reserveTimes({
      limiter,
      key: 'ip:a',
      times: AUTH_FAILURE_LIMIT,
      now: T0,
    });
    expect(granted.every((slot) => slot.granted)).toBe(true);
    expect(limiter.reserve({ key: 'ip:a', now: T0 + 10 })).toEqual({
      granted: false,
      retryAfterMs: AUTH_FAILURE_WINDOW_MS - 10,
    });
  });

  it('keeps other keys independent', () => {
    const limiter = new AuthFailureLimiter();
    reserveTimes({ limiter, key: 'ip:a', times: AUTH_FAILURE_LIMIT, now: T0 });
    expect(limiter.reserve({ key: 'ip:b', now: T0 }).granted).toBe(true);
  });

  it('gives a refunded slot back, once', () => {
    const limiter = new AuthFailureLimiter();
    const [first, ...rest] = reserveTimes({
      limiter,
      key: 'ip:a',
      times: AUTH_FAILURE_LIMIT,
      now: T0,
    });
    if (!first?.granted) throw new Error('expected a granted slot');
    first.refund();
    first.refund();
    expect(rest).toHaveLength(AUTH_FAILURE_LIMIT - 1);
    expect(limiter.reserve({ key: 'ip:a', now: T0 }).granted).toBe(true);
    expect(limiter.reserve({ key: 'ip:a', now: T0 }).granted).toBe(false);
  });

  it('ignores a refund from a window that has already ended', () => {
    const limiter = new AuthFailureLimiter();
    const stale = limiter.reserve({ key: 'ip:a', now: T0 });
    const later = T0 + AUTH_FAILURE_WINDOW_MS;
    reserveTimes({
      limiter,
      key: 'ip:a',
      times: AUTH_FAILURE_LIMIT,
      now: later,
    });
    if (!stale.granted) throw new Error('expected a granted slot');
    stale.refund();
    expect(limiter.reserve({ key: 'ip:a', now: later }).granted).toBe(false);
  });

  it('opens again when the window ends', () => {
    const limiter = new AuthFailureLimiter();
    reserveTimes({ limiter, key: 'ip:a', times: AUTH_FAILURE_LIMIT, now: T0 });
    const end = T0 + AUTH_FAILURE_WINDOW_MS;
    expect(limiter.reserve({ key: 'ip:a', now: end - 1 }).granted).toBe(false);
    expect(limiter.reserve({ key: 'ip:a', now: end }).granted).toBe(true);
  });

  it('drops expired windows so memory stays bounded by recent attempts', () => {
    const limiter = new AuthFailureLimiter();
    for (let i = 0; i < 50; i += 1)
      limiter.reserve({ key: `ip:${i}`, now: T0 });
    limiter.reserve({ key: 'ip:late', now: T0 + 2 * AUTH_FAILURE_WINDOW_MS });
    expect(limiter.trackedKeys()).toBe(1);
  });
});
