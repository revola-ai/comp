import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Response } from 'express';
import { AuthFailureLimiter } from './auth-failure-limiter';
import {
  ipBucket,
  type TrackableRequest,
  verifiedClientIp,
} from './identity-tracker';

/**
 * The pre-authentication limiter (APP_GUARD, so it runs before HybridAuthGuard
 * on every route). Each 401 a client IP causes counts against it; once the IP
 * reaches the limit, its requests get 429 before any credential is looked up.
 * Successful requests never count, so the identity buckets of authenticated
 * callers behind a shared IP are untouched. The IP is the verified client IP
 * (verifiedClientIp), so forged proxy headers land on the socket address.
 */
@Injectable()
export class AuthFailureThrottleGuard implements CanActivate {
  constructor(private readonly limiter: AuthFailureLimiter) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const http = context.switchToHttp();
    const req = http.getRequest<TrackableRequest>();
    const res = http.getResponse<Response>();
    const ip = verifiedClientIp({ req });
    const key = `auth-failure:ip:${ip ? ipBucket(ip) : 'unknown'}`;

    const retryAfterMs = this.limiter.retryAfterMs({ key });
    if (retryAfterMs > 0) {
      res.header('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      throw new ThrottlerException();
    }
    res.once('finish', () => {
      if (res.statusCode === 401) this.limiter.recordFailure({ key });
    });
    return true;
  }
}
