import { ThrottlerException } from '@nestjs/throttler';
import type { Response } from 'express';
import type { AuthFailureLimiter } from './auth-failure-limiter';
import {
  ipBucket,
  type TrackableRequest,
  verifiedClientIp,
} from './identity-tracker';

/**
 * Takes one credential attempt from the request's verified client IP bucket
 * (IPv6 by /64) and returns the function that gives it back. Once the bucket
 * is full it answers 429 with Retry-After instead, so the caller performs no
 * credential lookup. The response is read only to set that header.
 */
export function reserveCredentialAttempt({
  limiter,
  request,
  response,
}: {
  limiter: AuthFailureLimiter;
  request: TrackableRequest;
  response: () => Response;
}): () => void {
  const ip = verifiedClientIp({ req: request });
  const key = `auth-failure:ip:${ip ? ipBucket(ip) : 'unknown'}`;
  const reservation = limiter.reserve({ key });
  if (!reservation.granted) {
    const seconds = Math.ceil(reservation.retryAfterMs / 1000);
    response().header('Retry-After', String(seconds));
    throw new ThrottlerException();
  }
  return reservation.refund;
}
