import { Injectable } from '@nestjs/common';

/**
 * Unrefunded credential attempts (API keys, bearer and service tokens) per
 * window. A failure costs two buckets (credential-attempt.ts):
 *
 * - one presented credential from one client IP: 5. A client repeating one
 *   stale token (an MCP server behind Gram's shared egress, a device agent
 *   with an expired session behind an office NAT) is refused after 5 tries
 *   and from then on costs the IP's allowance nothing.
 * - one client IP, across all credentials: 60, double the former per-IP
 *   limit. Spraying distinct junk values still ends in 429 after 60 database
 *   lookups a minute, and 12 clients with distinct stale credentials can
 *   share an IP before the valid ones behind it are refused too. It stays
 *   below the 100 requests a minute ThrottleModule allows one identity.
 */
export const AUTH_FAILURE_CREDENTIAL_LIMIT = 5;
export const AUTH_FAILURE_LIMIT = 60;
export const AUTH_FAILURE_WINDOW_MS = 60_000;

/** A counter key and the attempts it allows per window. */
export interface AuthFailureBucket {
  key: string;
  limit: number;
}

type AttemptWindow = { attempts: number; endsAt: number };

export type AuthFailureReservation =
  | { granted: true; refund: () => void }
  | { granted: false; retryAfterMs: number };

/**
 * Fixed-window attempt counts per key. An attempt takes a slot in every
 * bucket it names before its credential is checked, all or none: a refused
 * attempt takes nothing (and creates no window), so a client refused for
 * repeating one credential does not use up its IP's allowance. The auth
 * guards (HybridAuthGuard, PlatformAdminGuard) give the slots back only when
 * they accept the credential or the credential store is down. A request that
 * never finishes (client abort, crash) keeps its slots. In memory, like the
 * Nest throttler storage: correct for one task per service; more tasks need
 * a shared store.
 */
@Injectable()
export class AuthFailureLimiter {
  private readonly windows = new Map<string, AttemptWindow>();
  private nextSweepAt = 0;

  reserve({
    buckets,
    now = Date.now(),
  }: {
    buckets: readonly AuthFailureBucket[];
    now?: number;
  }): AuthFailureReservation {
    this.sweepExpired(now);
    let retryAfterMs = 0;
    for (const { key, limit } of buckets) {
      const window = this.liveWindow({ key, now });
      if (window && window.attempts >= limit) {
        retryAfterMs = Math.max(retryAfterMs, window.endsAt - now);
      }
    }
    if (retryAfterMs > 0) return { granted: false, retryAfterMs };

    const taken = buckets.map(({ key }) => {
      let window = this.liveWindow({ key, now });
      if (!window) {
        window = { attempts: 0, endsAt: now + AUTH_FAILURE_WINDOW_MS };
        this.windows.set(key, window);
      }
      window.attempts += 1;
      return { key, window };
    });
    let refunded = false;
    return {
      granted: true,
      refund: () => {
        if (refunded) return;
        refunded = true;
        for (const { key, window } of taken) {
          if (this.windows.get(key) !== window) continue;
          window.attempts = Math.max(0, window.attempts - 1);
        }
      },
    };
  }

  /** Number of keys currently held in memory. */
  trackedKeys(): number {
    return this.windows.size;
  }

  private liveWindow({
    key,
    now,
  }: {
    key: string;
    now: number;
  }): AttemptWindow | undefined {
    const window = this.windows.get(key);
    return window && window.endsAt > now ? window : undefined;
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
