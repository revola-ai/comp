import { afterEach, describe, expect, it, setSystemTime } from 'bun:test';
import { createReadinessCheck, READINESS_CACHE_MS, type ReadinessProbe } from './readiness';

// Readiness callers (the public API route, the app route, alarms, smoke tests)
// can arrive back to back from many places; each probe is a fresh TLS and SCRAM
// handshake to the production pooler, so a result is reused for two seconds.
const T0 = Date.UTC(2026, 9, 7, 12, 0, 0);
const at = (ms: number) => setSystemTime(new Date(T0 + ms));

function countingProbe(outcome: () => Promise<unknown>) {
  let calls = 0;
  const probe: ReadinessProbe = () => {
    calls += 1;
    return outcome();
  };
  return { probe, calls: () => calls };
}

afterEach(() => {
  setSystemTime();
});

describe('createReadinessCheck (result cache)', () => {
  it('keeps a result for two seconds by default', () => {
    expect(READINESS_CACHE_MS).toBe(2000);
  });

  it('answers a check within two seconds from the last result without probing, then probes again', async () => {
    const counting = countingProbe(async () => undefined);
    const check = createReadinessCheck({ probe: counting.probe });
    at(0);
    expect(await check()).toEqual({ status: 'ok' });
    at(1999);
    expect(await check()).toEqual({ status: 'ok' });
    expect(counting.calls()).toBe(1);
    at(2000);
    expect(await check()).toEqual({ status: 'ok' });
    expect(counting.calls()).toBe(2);
  });

  it('keeps an unavailable result too, so an outage does not mean a handshake per request', async () => {
    const counting = countingProbe(() =>
      Promise.reject(Object.assign(new Error('refused'), { code: 'P1001' })),
    );
    const check = createReadinessCheck({ probe: counting.probe });
    at(0);
    const first = await check({ timeoutMs: 50 });
    at(1000);
    const second = await check({ timeoutMs: 50 });
    expect([first, second]).toEqual(Array(2).fill({ status: 'unavailable', reason: 'P1001' }));
    expect(counting.calls()).toBe(1);
  });

  it('still shares one probe among concurrent checks before any result exists', async () => {
    let settle: () => void = () => undefined;
    const counting = countingProbe(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    const check = createReadinessCheck({ probe: counting.probe });
    at(0);
    const pending = Array.from({ length: 5 }, () => check({ timeoutMs: 100 }));
    await new Promise((resolve) => setTimeout(resolve, 1));
    settle();
    expect(await Promise.all(pending)).toEqual(Array(5).fill({ status: 'ok' }));
    expect(await check()).toEqual({ status: 'ok' });
    expect(counting.calls()).toBe(1);
  });

  it('does not keep serving a result when the clock moves backwards', async () => {
    const counting = countingProbe(async () => undefined);
    const check = createReadinessCheck({ probe: counting.probe });
    at(10_000);
    await check();
    at(5_000);
    await check();
    expect(counting.calls()).toBe(2);
  });

  it('can be turned off with cacheMs: 0', async () => {
    const counting = countingProbe(async () => undefined);
    const check = createReadinessCheck({ probe: counting.probe, cacheMs: 0 });
    at(0);
    await check();
    await check();
    expect(counting.calls()).toBe(2);
  });
});
