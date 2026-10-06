import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthFailureThrottleGuard } from './auth-failure.guard';
import { AuthFailureLimiter } from './auth-failure-limiter';
import { IdentityThrottleInterceptor } from './identity-throttle.interceptor';
import {
  IdentityThrottlerGuard,
  PublicRouteThrottlerGuard,
} from './identity-throttler.guard';

/**
 * Request throttling: 100 requests per minute per verified identity by default
 * (@Throttle overrides per route). Public routes are limited by the global guard
 * on the verified client IP; all other routes by the interceptor, after
 * HybridAuthGuard, on the caller's identity. Rejected credentials never reach
 * the interceptor, so a global pre-authentication guard counts 401s per
 * verified client IP and answers 429 on every route once an IP reaches the
 * limit. Storage is in memory, which is correct for one task per service; more
 * tasks need a shared (Redis) store.
 */
@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
  providers: [
    IdentityThrottlerGuard,
    AuthFailureLimiter,
    { provide: APP_GUARD, useClass: AuthFailureThrottleGuard },
    { provide: APP_GUARD, useClass: PublicRouteThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: IdentityThrottleInterceptor },
  ],
})
export class ThrottleModule {}
