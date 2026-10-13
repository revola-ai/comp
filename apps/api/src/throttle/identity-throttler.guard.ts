import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerGuard, type ThrottlerRequest } from '@nestjs/throttler';
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
 * Requests per minute a service-token caller may make to one route for one
 * organization, whatever the route's own limit. Service tokens are long
 * secrets checked in memory (no database work before the limit), and their
 * callers are our own Trigger.dev tasks, which fan out per record: a policy
 * publish or task reminder sends one request per employee. The limit only
 * stops a runaway loop; the service-only email routes are not throttled at all
 * (EmailController), so no email is lost to a 429.
 */
export const SERVICE_THROTTLE_LIMIT = 1_000;
const SERVICE_THROTTLE_TTL_MS = 60_000;

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

  protected handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const req = requestProps.context
      .switchToHttp()
      .getRequest<TrackableRequest>();
    if (req.authType !== 'service') return super.handleRequest(requestProps);
    return super.handleRequest({
      ...requestProps,
      limit: SERVICE_THROTTLE_LIMIT,
      ttl: SERVICE_THROTTLE_TTL_MS,
    });
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
