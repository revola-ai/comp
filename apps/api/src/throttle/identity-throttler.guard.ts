import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { identityTracker, type TrackableRequest } from './identity-tracker';

export function isPublicRoute({
  context,
  reflector,
}: {
  context: ExecutionContext;
  reflector: Reflector;
}): boolean {
  const isPublic = reflector.getAllAndOverride<boolean | undefined>(
    IS_PUBLIC_KEY,
    [context.getHandler(), context.getClass()],
  );
  return isPublic === true;
}

/**
 * The Nest throttler keyed by `identityTracker`. It honours @Throttle and
 * @SkipThrottle like the stock guard. Used by IdentityThrottleInterceptor,
 * which runs after the controller guards, so HybridAuthGuard has already set
 * the caller's identity.
 */
@Injectable()
export class IdentityThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    // The HTTP request object: headers, ip and socket from Express, identity
    // fields from HybridAuthGuard.
    const trackable = req as unknown as TrackableRequest;
    return Promise.resolve(identityTracker({ req: trackable }));
  }
}

/**
 * The global (APP_GUARD) limiter. Global guards run before HybridAuthGuard, so
 * no identity is known yet; it therefore throttles only @Public() routes, by
 * verified client IP. Every other route is throttled by the interceptor.
 */
@Injectable()
export class PublicRouteThrottlerGuard extends IdentityThrottlerGuard {
  protected shouldSkip(context: ExecutionContext): Promise<boolean> {
    return Promise.resolve(
      !isPublicRoute({ context, reflector: this.reflector }),
    );
  }
}
