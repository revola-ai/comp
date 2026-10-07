import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule as BetterAuthModule } from '@thallesp/nestjs-better-auth';
import { AuthFailureLimiter } from '../throttle/auth-failure-limiter';
import { auth } from './auth.server';
import { ActingUserResolver } from './acting-user.service';
import { ApiKeyService } from './api-key.service';
import { AuthController } from './auth.controller';
import { CredentialStoreUnavailableFilter } from './credential-store-unavailable.filter';
import { HybridAuthGuard } from './hybrid-auth.guard';
import { PermissionGuard } from './permission.guard';

@Module({
  imports: [
    // Better Auth NestJS integration - handles /api/auth/* routes
    BetterAuthModule.forRoot({
      auth,
      // Don't register global auth guard - we use HybridAuthGuard
      disableGlobalAuthGuard: true,
      // CORS is already configured in main.ts — prevent the module from
      // overriding it with its own trustedOrigins-based CORS.
      disableTrustedOriginsCors: true,
      // Body parsing for non-auth routes is handled in main.ts with a
      // custom middleware that skips /api/auth paths. Disable the module's
      // own SkipBodyParsingMiddleware to avoid conflicts.
      disableBodyParser: true,
    }),
  ],
  controllers: [AuthController],
  providers: [
    // One instance for the whole app: HybridAuthGuard's per-IP attempt buckets.
    AuthFailureLimiter,
    ApiKeyService,
    HybridAuthGuard,
    PermissionGuard,
    ActingUserResolver,
    // Credential-store outages answer 503 with Retry-After.
    { provide: APP_FILTER, useClass: CredentialStoreUnavailableFilter },
  ],
  exports: [
    AuthFailureLimiter,
    ApiKeyService,
    HybridAuthGuard,
    PermissionGuard,
    ActingUserResolver,
    BetterAuthModule,
  ],
})
export class AuthModule {}
