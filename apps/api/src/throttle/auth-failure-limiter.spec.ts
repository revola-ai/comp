import {
  AUTH_FAILURE_WINDOW_MS,
  AuthFailureLimiter,
  type AuthFailureBucket,
  type AuthFailureReservation,
} from './auth-failure-limiter';

describe('AuthFailureLimiter (slots reserved at arrival, refunded on success)', () => {
  const T0 = 1_000_000;
  const LIMIT = 4;
  const ip = (name: string): AuthFailureBucket => ({
    key: `ip:${name}`,
    limit: LIMIT,
  });

  function reserveTimes({
    limiter,
    buckets,
    times,
    now,
  }: {
    limiter: AuthFailureLimiter;
    buckets: AuthFailureBucket[];
    times: number;
    now: number;
  }): AuthFailureReservation[] {
    return Array.from({ length: times }, () =>
      limiter.reserve({ buckets, now }),
    );
  }

  it('grants the limit of slots in a window, then refuses with the time left', () => {
    const limiter = new AuthFailureLimiter();
    const granted = reserveTimes({
      limiter,
      buckets: [ip('a')],
      times: LIMIT,
      now: T0,
    });
    expect(granted.every((slot) => slot.granted)).toBe(true);
    expect(limiter.reserve({ buckets: [ip('a')], now: T0 + 10 })).toEqual({
      granted: false,
      retryAfterMs: AUTH_FAILURE_WINDOW_MS - 10,
    });
  });

  it('keeps other keys independent', () => {
    const limiter = new AuthFailureLimiter();
    reserveTimes({ limiter, buckets: [ip('a')], times: LIMIT, now: T0 });
    expect(limiter.reserve({ buckets: [ip('b')], now: T0 }).granted).toBe(true);
  });

  it('gives a refunded slot back, once', () => {
    const limiter = new AuthFailureLimiter();
    const [first] = reserveTimes({
      limiter,
      buckets: [ip('a')],
      times: LIMIT,
      now: T0,
    });
    if (!first?.granted) throw new Error('expected a granted slot');
    first.refund();
    first.refund();
    expect(limiter.reserve({ buckets: [ip('a')], now: T0 }).granted).toBe(true);
    expect(limiter.reserve({ buckets: [ip('a')], now: T0 }).granted).toBe(
      false,
    );
  });

  it('ignores a refund from a window that has already ended', () => {
    const limiter = new AuthFailureLimiter();
    const stale = limiter.reserve({ buckets: [ip('a')], now: T0 });
    const later = T0 + AUTH_FAILURE_WINDOW_MS;
    reserveTimes({ limiter, buckets: [ip('a')], times: LIMIT, now: later });
    if (!stale.granted) throw new Error('expected a granted slot');
    stale.refund();
    expect(limiter.reserve({ buckets: [ip('a')], now: later }).granted).toBe(
      false,
    );
  });

  it('opens again when the window ends', () => {
    const limiter = new AuthFailureLimiter();
    reserveTimes({ limiter, buckets: [ip('a')], times: LIMIT, now: T0 });
    const end = T0 + AUTH_FAILURE_WINDOW_MS;
    expect(limiter.reserve({ buckets: [ip('a')], now: end - 1 }).granted).toBe(
      false,
    );
    expect(limiter.reserve({ buckets: [ip('a')], now: end }).granted).toBe(
      true,
    );
  });

  it('drops expired windows so memory stays bounded by recent attempts', () => {
    const limiter = new AuthFailureLimiter();
    for (let i = 0; i < 50; i += 1) {
      limiter.reserve({ buckets: [ip(`${i}`)], now: T0 });
    }
    limiter.reserve({
      buckets: [ip('late')],
      now: T0 + 2 * AUTH_FAILURE_WINDOW_MS,
    });
    expect(limiter.trackedKeys()).toBe(1);
  });

  describe('several buckets in one reservation', () => {
    const credential = (name: string): AuthFailureBucket => ({
      key: `ip:a:credential:${name}`,
      limit: 2,
    });

    it('is refused when any bucket is full, taking nothing from the others', () => {
      const limiter = new AuthFailureLimiter();
      const both = [ip('a'), credential('stale')];
      reserveTimes({ limiter, buckets: both, times: 2, now: T0 });
      expect(limiter.reserve({ buckets: both, now: T0 }).granted).toBe(false);
      // The two refused attempts above did not use the IP bucket's slots.
      const others = reserveTimes({
        limiter,
        buckets: [ip('a'), credential('fresh')],
        times: 2,
        now: T0,
      });
      expect(others.every((slot) => slot.granted)).toBe(true);
      expect(
        limiter.reserve({ buckets: [ip('a'), credential('third')], now: T0 })
          .granted,
      ).toBe(false);
    });

    it('creates no window for a refused reservation', () => {
      const limiter = new AuthFailureLimiter();
      reserveTimes({ limiter, buckets: [ip('a')], times: LIMIT, now: T0 });
      for (let i = 0; i < 20; i += 1) {
        limiter.reserve({ buckets: [ip('a'), credential(`${i}`)], now: T0 });
      }
      expect(limiter.trackedKeys()).toBe(1);
    });

    it('answers the longest wait among the full buckets', () => {
      const limiter = new AuthFailureLimiter();
      reserveTimes({
        limiter,
        buckets: [credential('stale')],
        times: 2,
        now: T0,
      });
      reserveTimes({ limiter, buckets: [ip('a')], times: LIMIT, now: T0 + 30 });
      expect(
        limiter.reserve({
          buckets: [ip('a'), credential('stale')],
          now: T0 + 40,
        }),
      ).toEqual({ granted: false, retryAfterMs: AUTH_FAILURE_WINDOW_MS - 10 });
    });

    it('refunds every bucket it took', () => {
      const limiter = new AuthFailureLimiter();
      const both = [ip('a'), credential('valid')];
      for (let i = 0; i < 10; i += 1) {
        const slot = limiter.reserve({ buckets: both, now: T0 });
        if (!slot.granted) throw new Error('expected a granted slot');
        slot.refund();
      }
      expect(limiter.reserve({ buckets: both, now: T0 }).granted).toBe(true);
    });
  });
});
