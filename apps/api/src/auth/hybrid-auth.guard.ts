import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { db } from '@db';
import type { Response } from 'express';
import { AuthFailureLimiter } from '../throttle/auth-failure-limiter';
import { reserveCredentialAttempt } from '../throttle/credential-attempt';
import type { TrackableRequest } from '../throttle/identity-tracker';
import { authenticateApiKey } from './api-key-auth';
import { ApiKeyService } from './api-key.service';
import { auth } from './auth.server';
import { API_KEY_HEADER, SERVICE_TOKEN_HEADER } from './credential-headers';
import {
  credentialStoreUnavailable,
  isCredentialStoreFailure,
} from './credential-store-error';
import { authenticateMcpOAuth } from './mcp-oauth-auth';
import { IS_PUBLIC_KEY } from './public.decorator';
import { SKIP_ORG_CHECK_KEY } from './skip-org-check.decorator';
import { authenticateServiceToken } from './service-token-auth';
import { AuthenticatedRequest } from './types';

@Injectable()
export class HybridAuthGuard implements CanActivate {
  constructor(
    private readonly apiKeyService: ApiKeyService,
    private readonly reflector: Reflector,
    private readonly attemptLimiter: AuthFailureLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    // Machine credentials that fail cost an attempt of the caller's verified
    // client IP bucket (429 once it is full); sessions never do.
    const takeAttempt = () =>
      reserveCredentialAttempt({
        limiter: this.attemptLimiter,
        request: context.switchToHttp().getRequest<TrackableRequest>(),
        response: () => context.switchToHttp().getResponse<Response>(),
      });

    // Try API Key authentication first (for external customers)
    const apiKey = request.headers[API_KEY_HEADER] as string;
    if (apiKey) {
      return authenticateApiKey({
        request,
        header: apiKey,
        apiKeyService: this.apiKeyService,
        takeAttempt,
      });
    }

    // Try Service Token authentication (for internal services)
    const serviceToken = request.headers[SERVICE_TOKEN_HEADER] as string;
    if (serviceToken) {
      return authenticateServiceToken({
        request,
        token: serviceToken,
        takeAttempt,
      });
    }

    // Try session-based authentication (bearer token or cookies)
    const skipOrgCheck = this.reflector.getAllAndOverride<boolean>(
      SKIP_ORG_CHECK_KEY,
      [context.getHandler(), context.getClass()],
    );
    return this.handleSessionAuth(request, skipOrgCheck);
  }

  private async handleSessionAuth(
    request: AuthenticatedRequest,
    skipOrgCheck = false,
  ): Promise<boolean> {
    try {
      // Build headers for better-auth SDK
      // Forwards both Authorization (bearer session token) and Cookie headers
      const headers = new Headers();
      const authHeader = request.headers['authorization'] as string;
      if (authHeader) {
        headers.set('authorization', authHeader);
      }
      const cookieHeader = request.headers['cookie'] as string;
      if (cookieHeader) {
        headers.set('cookie', cookieHeader);
      }

      if (!authHeader && !cookieHeader) {
        throw new UnauthorizedException(
          'Authentication required: Provide either X-API-Key, Bearer token, or session cookie',
        );
      }

      // Use better-auth SDK to resolve session
      // Works with both bearer session tokens and httpOnly cookies
      const session = await auth.api.getSession({ headers });

      if (!session) {
        // Fallback: the hosted MCP server (Gram) sends an OAuth access token as a
        // Bearer token, which getSession does not resolve. Try the MCP OAuth path.
        if (await authenticateMcpOAuth({ request, headers })) {
          return true;
        }
        throw new UnauthorizedException('Invalid or expired session');
      }

      const { user, session: sessionData } = session;

      if (!user?.id) {
        throw new UnauthorizedException(
          'Invalid session: missing user information',
        );
      }

      const organizationId = sessionData.activeOrganizationId;
      if (!organizationId && !skipOrgCheck) {
        throw new UnauthorizedException(
          'No active organization. Please select an organization.',
        );
      }

      // Fetch member data for role and department info
      // Skip if no active org or if org check is skipped (e.g., during onboarding)
      let userRoles: string[] | null = null;
      if (organizationId && !skipOrgCheck) {
        const member = await db.member.findFirst({
          where: {
            userId: user.id,
            organizationId,
            deactivated: false,
          },
          select: {
            id: true,
            role: true,
            department: true,
          },
        });

        if (!member) {
          throw new UnauthorizedException(
            `User is not a member of the active organization`,
          );
        }

        userRoles = member.role ? member.role.split(',') : null;
        request.memberId = member.id;
        request.memberDepartment = member.department;
      }

      // Set request context for session auth
      request.userId = user.id;
      request.userEmail = user.email;
      request.userRoles = userRoles;
      request.organizationId = organizationId || '';
      request.authType = 'session';
      request.isApiKey = false;
      request.isServiceToken = false;
      request.sessionId = sessionData.id;
      request.sessionDeviceAgent =
        (sessionData as Record<string, unknown>).deviceAgent === true;
      // Resolve isPlatformAdmin from the User.role column (via better-auth session),
      // not from the member relation. This ensures the flag is set regardless of
      // org membership or skipOrgCheck.
      request.isPlatformAdmin =
        (user as { role?: string | null }).role === 'admin';

      const rawImpersonatedBy = (sessionData as Record<string, unknown>)
        .impersonatedBy;
      if (typeof rawImpersonatedBy === 'string' && rawImpersonatedBy) {
        request.impersonatedBy = rawImpersonatedBy;
      }

      return true;
    } catch (error) {
      // Re-throw deliberate auth/permission errors as-is (e.g. the 403 from the
      // MCP org-resolution path). Only unexpected failures collapse to a 401.
      if (error instanceof HttpException) {
        throw error;
      }

      console.error('[HybridAuthGuard] Session verification failed:', error);
      // A database outage is not an invalid session: answer 503 so clients
      // retry instead of signing the user out.
      if (isCredentialStoreFailure(error)) throw credentialStoreUnavailable();
      throw new UnauthorizedException('Invalid or expired session');
    }
  }
}
