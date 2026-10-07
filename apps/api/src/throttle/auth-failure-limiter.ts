import { Injectable } from '@nestjs/common';

/** Machine-credential attempts one client IP may have unrefunded per window. */
export const AUTH_FAILURE_LIMIT = 30;
export const AUTH_FAILURE_WINDOW_MS = 60_000;

type AttemptWindow = { attempts: number; endsAt: number };

export type AuthFailureReservation =
  | { granted: true; refund: () => void }
  | { granted: false; retryAfterMs: number };

/**
 * Fixed-window attempt count per key (a verified client IP bucket). Every
 * attempt takes a slot when it arrives, so a burst is counted before any
 * credential is checked; a request that turns out not to be a credential
 * failure gives its slot back. A request that never finishes (client abort,
 * crash) keeps its slot. In memory, like the Nest throttler storage: correct
 * for one task per service; more tasks need a shared store.
 */
@Injectable()
export class AuthFailureLimiter {
  private readonly windows = new Map<string, AttemptWindow>();
  private nextSweepAt = 0;

  reserve({
    key,
    now = Date.now(),
  }: {
    key: string;
    now?: number;
  }): AuthFailureReservation {
    this.sweepExpired(now);
    let window = this.windows.get(key);
    if (!window || window.endsAt <= now) {
      window = { attempts: 0, endsAt: now + AUTH_FAILURE_WINDOW_MS };
      this.windows.set(key, window);
    }
    if (window.attempts >= AUTH_FAILURE_LIMIT) {
      return { granted: false, retryAfterMs: window.endsAt - now };
    }
    window.attempts += 1;
    const reserved = window;
    let refunded = false;
    return {
      granted: true,
      refund: () => {
        if (refunded || this.windows.get(key) !== reserved) return;
        refunded = true;
        reserved.attempts = Math.max(0, reserved.attempts - 1);
      },
    };
  }

  /** Number of keys currently held in memory. */
  trackedKeys(): number {
    return this.windows.size;
  }

  // At most once per window, drop windows that have ended, so memory holds only
  // the keys that made attempts recently.
  private sweepExpired(now: number): void {
    if (now < this.nextSweepAt) return;
    this.nextSweepAt = now + AUTH_FAILURE_WINDOW_MS;
    for (const [key, window] of this.windows) {
      if (window.endsAt <= now) this.windows.delete(key);
    }
  }
}
