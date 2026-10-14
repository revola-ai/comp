import type { Request, Response, NextFunction } from 'express';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { identityTracker } from '../throttle/identity-tracker';

const MAX_REQUESTS = 10;
const WINDOW = '60 s';

const hasUpstashConfig =
  !!process.env.UPSTASH_REDIS_REST_URL &&
  !!process.env.UPSTASH_REDIS_REST_TOKEN;

const ratelimit = hasUpstashConfig
  ? new Ratelimit({
      redis: new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL!,
        token: process.env.UPSTASH_REDIS_REST_TOKEN!,
      }),
      limiter: Ratelimit.slidingWindow(MAX_REQUESTS, WINDOW),
      prefix: 'ratelimit:admin-auth',
    })
  : null;

/**
 * Express middleware that rate-limits requests to /api/auth/admin/*.
 *
 * better-auth admin routes (impersonation, set-role, ban, etc.) are handled
 * by better-auth's own request handler and never reach NestJS controllers,
 * so the Nest throttler does not apply to them. This middleware fills that gap
 * with a sliding window (10 req/min) backed by Upstash Redis so limits are
 * shared across all ECS instances. It keys on the same identityTracker as the
 * Nest throttler; no identity is resolved this early, so that is the verified
 * client IP (never a forgeable X-Forwarded-For or CF-Connecting-IP).
 */
export async function adminAuthRateLimiter(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.path.startsWith('/api/auth/admin')) {
    return next();
  }

  if (!ratelimit) {
    return next();
  }

  try {
    const { success } = await ratelimit.limit(identityTracker({ req }));

    if (!success) {
      res.status(429).json({
        error: 'Too many requests to admin endpoints. Try again later.',
      });
      return;
    }
  } catch {
    // If Redis is unreachable, allow the request through rather than
    // blocking all admin operations. The WAF still provides baseline protection.
  }

  return next();
}
