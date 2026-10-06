import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';
import {
  IdentityThrottlerGuard,
  isPublicRoute,
} from './identity-throttler.guard';

/**
 * Throttles every non-public HTTP route by verified identity. Interceptors run
 * after all guards, so HybridAuthGuard has already set the API key ID, service
 * name or session user ID; routes without such a guard fall back to the
 * verified client IP. Over the limit it throws ThrottlerException (429).
 */
@Injectable()
export class IdentityThrottleInterceptor implements NestInterceptor {
  constructor(
    private readonly throttler: IdentityThrottlerGuard,
    private readonly reflector: Reflector,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const throttled =
      context.getType() === 'http' &&
      !isPublicRoute({ context, reflector: this.reflector });
    if (throttled) await this.throttler.canActivate(context);
    return next.handle();
  }
}
