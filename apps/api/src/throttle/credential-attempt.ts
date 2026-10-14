import type { ExecutionContext } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Response } from 'express';
import { createHash } from 'node:crypto';
import {
  AUTH_FAILURE_CREDENTIAL_LIMIT,
  AUTH_FAILURE_LIMIT,
  type AuthFailureBucket,
  type AuthFailureLimiter,
} from './auth-failure-limiter';
import {
  ipBucket,
  type TrackableRequest,
  verifiedClientIp,
} from './identity-tracker';

/**
 * The buckets one credential attempt costs: the verified client IP bucket
 * (IPv6 by /64), and that IP bucket together with the presented credential,
 * which is held only as a SHA-256 digest, never as itself.
 */
export function credentialAttemptBuckets({
  request,
  credential,
}: {
  request: TrackableRequest;
  credential: string;
}): AuthFailureBucket[] {
  const ip = verifiedClientIp({ req: request });
  const client = ip ? ipBucket(ip) : 'unknown';
  const digest = createHash('sha256').update(credential).digest('base64url');
  return [
    { key: `auth-failure:ip:${client}`, limit: AUTH_FAILURE_LIMIT },
    {
      key: `auth-failure:credential:${client}:${digest}`,
      limit: AUTH_FAILURE_CREDENTIAL_LIMIT,
    },
  ];
}

/**
 * Takes one credential attempt (credentialAttemptBuckets) and returns the
 * function that gives it back. Once either bucket is full it answers 429
 * with Retry-After instead, so the caller performs no credential lookup. The
 * response is read only to set that header.
 */
export function reserveCredentialAttempt({
  limiter,
  request,
  response,
  credential,
}: {
  limiter: AuthFailureLimiter;
  request: TrackableRequest;
  response: () => Response;
  credential: string;
}): () => void {
  const reservation = limiter.reserve({
    buckets: credentialAttemptBuckets({ request, credential }),
  });
  if (!reservation.granted) {
    const seconds = Math.ceil(reservation.retryAfterMs / 1000);
    response().header('Retry-After', String(seconds));
    throw new ThrottlerException();
  }
  return reservation.refund;
}

/**
 * The attempt taker an auth guard hands to a credential path: each call
 * takes one attempt for `credential` on the request in `context`
 * (reserveCredentialAttempt). Every guard that looks a presented credential
 * up in the database (API keys, bearer tokens) takes the attempt right before
 * that lookup and gives it back once the credential is accepted; cookie-only
 * sessions never take one.
 */
export function credentialAttemptTaker({
  limiter,
  context,
  credential,
}: {
  limiter: AuthFailureLimiter;
  context: ExecutionContext;
  credential: string;
}): () => () => void {
  const http = context.switchToHttp();
  return () =>
    reserveCredentialAttempt({
      limiter,
      request: http.getRequest<TrackableRequest>(),
      response: () => http.getResponse<Response>(),
      credential,
    });
}
