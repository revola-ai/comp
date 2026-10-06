import { Injectable } from '@nestjs/common';

/** Rejected credentials (401 responses) one client IP may cause per window. */
export const AUTH_FAILURE_LIMIT = 30;
export const AUTH_FAILURE_WINDOW_MS = 60_000;

type FailureWindow = { failures: number; endsAt: number };

/**
 * Fixed-window count of authentication failures per key (a verified client IP
 * bucket). A key that reaches AUTH_FAILURE_LIMIT stays blocked until its
 * window ends. In memory, like the Nest throttler storage: correct for one task
 * per service; more tasks need a shared store.
 */
@Injectable()
export class AuthFailureLimiter {
  private readonly windows = new Map<string, FailureWindow>();
  private nextSweepAt = 0;

  /** Milliseconds until the key may try again; 0 when it is not blocked. */
  retryAfterMs({
    key,
    now = Date.now(),
  }: {
    key: string;
    now?: number;
  }): number {
    const window = this.windows.get(key);
    if (!window || window.endsAt <= now) return 0;
    if (window.failures < AUTH_FAILURE_LIMIT) return 0;
    return window.endsAt - now;
  }

  recordFailure({
    key,
    now = Date.now(),
  }: {
    key: string;
    now?: number;
  }): void {
    this.sweepExpired(now);
    const window = this.windows.get(key);
    if (!window || window.endsAt <= now) {
      this.windows.set(key, {
        failures: 1,
        endsAt: now + AUTH_FAILURE_WINDOW_MS,
      });
      return;
    }
    window.failures += 1;
  }

  /** Number of keys currently held in memory. */
  trackedKeys(): number {
    return this.windows.size;
  }

  // At most once per window, drop windows that have ended, so memory holds only
  // the keys that failed recently.
  private sweepExpired(now: number): void {
    if (now < this.nextSweepAt) return;
    this.nextSweepAt = now + AUTH_FAILURE_WINDOW_MS;
    for (const [key, window] of this.windows) {
      if (window.endsAt <= now) this.windows.delete(key);
    }
  }
}
