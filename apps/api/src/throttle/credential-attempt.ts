import type { ExecutionContext } from '@nestjs/common';
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

/**
 * The attempt taker an auth guard hands to its credential paths: each call
 * takes one attempt for the request in `context` (reserveCredentialAttempt).
 * Every guard that looks a presented credential up in the database (API keys,
 * bearer tokens) takes the attempt right before that lookup and gives it back
 * once the credential is accepted; cookie-only sessions never take one.
 */
export function credentialAttemptTaker({
  limiter,
  context,
}: {
  limiter: AuthFailureLimiter;
  context: ExecutionContext;
}): () => () => void {
  const http = context.switchToHttp();
  return () =>
    reserveCredentialAttempt({
      limiter,
      request: http.getRequest<TrackableRequest>(),
      response: () => http.getResponse<Response>(),
    });
}
