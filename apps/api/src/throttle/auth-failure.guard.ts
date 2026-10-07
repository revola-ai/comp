import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Response } from 'express';
import { presentsMachineCredential } from '../auth/credential-headers';
import { AuthFailureLimiter } from './auth-failure-limiter';
import {
  ipBucket,
  type TrackableRequest,
  verifiedClientIp,
} from './identity-tracker';

/**
 * A credential failure: 401, or 403 before any credential was accepted.
 * A 403 after authentication (missing scope or role) is not one.
 */
function isCredentialFailure({
  status,
  req,
}: {
  status: number;
  req: TrackableRequest;
}): boolean {
  if (status === 401) return true;
  return status === 403 && !req.authType;
}

/**
 * The pre-authentication limiter (APP_GUARD, so it runs before HybridAuthGuard
 * on every route) for requests that present a machine credential (API key or
 * service token). Each such request takes a slot of its verified client IP's
 * bucket on arrival; once the bucket is full the request gets 429 before any
 * credential lookup. A request that finishes without a credential failure
 * (success, 403 for scope, 503 when the credential store is down) gives its
 * slot back; one that fails or never finishes keeps it. Cookie and Bearer
 * session requests are never counted, so a stale browser tab cannot block its
 * office IP. The IP is the verified client IP, so forged proxy headers land on
 * the socket address.
 */
@Injectable()
export class AuthFailureThrottleGuard implements CanActivate {
  constructor(private readonly limiter: AuthFailureLimiter) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const http = context.switchToHttp();
    const req = http.getRequest<TrackableRequest>();
    if (!presentsMachineCredential(req.headers)) return true;
    const res = http.getResponse<Response>();
    const ip = verifiedClientIp({ req });
    const key = `auth-failure:ip:${ip ? ipBucket(ip) : 'unknown'}`;

    const reservation = this.limiter.reserve({ key });
    if (!reservation.granted) {
      const seconds = Math.ceil(reservation.retryAfterMs / 1000);
      res.header('Retry-After', String(seconds));
      throw new ThrottlerException();
    }
    res.once('finish', () => {
      if (!isCredentialFailure({ status: res.statusCode, req })) {
        reservation.refund();
      }
    });
    return true;
  }
}
