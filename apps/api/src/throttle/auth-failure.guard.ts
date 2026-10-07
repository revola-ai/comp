import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Response } from 'express';
import {
  presentsMachineCredential,
  presentsValidServiceToken,
} from '../auth/credential-headers';
import { holdCredentialSlot } from '../auth/credential-slot';
import { AuthFailureLimiter } from './auth-failure-limiter';
import {
  ipBucket,
  type TrackableRequest,
  verifiedClientIp,
} from './identity-tracker';

/**
 * The pre-authentication limiter (APP_GUARD, so it runs before HybridAuthGuard
 * on every route) for requests that present a machine credential (API key or
 * service token). Such a request takes a slot of its verified client IP's
 * bucket on arrival; once the bucket is full the request gets 429 before any
 * credential lookup. HybridAuthGuard gives the slot back the moment it accepts
 * the credential, or finds the credential store down (credential-slot.ts), so
 * long-running authenticated requests and scope denials hold no slot; a
 * request that fails authentication or is aborted during validation keeps it.
 * Cookie and Bearer session requests are never counted. The IP is the verified
 * client IP, so forged proxy headers land on the socket address.
 *
 * A valid service token skips the bucket entirely: anyone sharing an egress IP
 * with an internal service (Trigger.dev cloud, a NAT) could otherwise fill the
 * bucket with junk API keys and lock the service out. Checking it costs a few
 * in-memory constant-time comparisons on every machine-credential request,
 * including ones that end in 429, and needs no database. API keys keep
 * reserve-before-lookup because checking them needs the database.
 */
@Injectable()
export class AuthFailureThrottleGuard implements CanActivate {
  constructor(private readonly limiter: AuthFailureLimiter) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const http = context.switchToHttp();
    const req = http.getRequest<TrackableRequest>();
    if (!presentsMachineCredential(req.headers)) return true;
    if (presentsValidServiceToken(req.headers)) return true;
    const ip = verifiedClientIp({ req });
    const key = `auth-failure:ip:${ip ? ipBucket(ip) : 'unknown'}`;

    const reservation = this.limiter.reserve({ key });
    if (!reservation.granted) {
      const seconds = Math.ceil(reservation.retryAfterMs / 1000);
      http.getResponse<Response>().header('Retry-After', String(seconds));
      throw new ThrottlerException();
    }
    holdCredentialSlot({ request: req, refund: reservation.refund });
    return true;
  }
}
