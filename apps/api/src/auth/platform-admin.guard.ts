import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { db } from '@db';
import { AuthFailureLimiter } from '../throttle/auth-failure-limiter';
import { credentialAttemptTaker } from '../throttle/credential-attempt';
import { auth } from './auth.server';
import {
  credentialStoreUnavailable,
  isCredentialStoreFailure,
  isSessionLookupFailure,
} from './credential-store-error';
import { isSessionStoreOutage } from './session-store-outage';

interface PlatformAdminRequest {
  userId?: string;
  userEmail?: string;
  isPlatformAdmin?: boolean;
  headers: {
    authorization?: string;
    cookie?: string;
    [key: string]: string | undefined;
  };
}

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(private readonly attemptLimiter: AuthFailureLimiter) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PlatformAdminRequest>();

    // Build headers for better-auth SDK
    const headers = new Headers();
    const authHeader = request.headers['authorization'];
    if (authHeader) {
      headers.set('authorization', authHeader);
    }
    const cookieHeader = request.headers['cookie'];
    if (cookieHeader) {
      headers.set('cookie', cookieHeader);
    }

    if (!authHeader && !cookieHeader) {
      throw new UnauthorizedException(
        'Platform admin routes require authentication',
      );
    }

    // A bearer token is looked up in the database as it is, so it takes an
    // attempt of the verified client IP bucket and of that token from that IP
    // first (429 once either is full, with no lookup), given back once the lookup accepts it or the
    // credential store is down; the same rule as HybridAuthGuard. Cookies are
    // signed, so a forged one is refused before any lookup, and cookie-only
    // requests never take an attempt.
    const release = authHeader
      ? credentialAttemptTaker({
          limiter: this.attemptLimiter,
          context,
          credential: authHeader,
        })()
      : () => undefined;
    // A database outage answers 503 (with Retry-After), never 401 or 500.
    const outage = (): never => {
      release();
      throw credentialStoreUnavailable();
    };
    const storeOutage = (error: unknown): never => {
      if (!isCredentialStoreFailure(error)) throw error;
      return outage();
    };

    // Resolve session via better-auth SDK. Its causeless FAILED_TO_GET_SESSION
    // is an outage only if a database probe agrees (session-store-outage.ts);
    // otherwise the session is invalid (401) and the attempt is kept.
    const session = await auth.api
      .getSession({ headers })
      .catch(async (error: unknown) => {
        if (await isSessionStoreOutage({ error })) outage();
        if (isSessionLookupFailure(error)) return null;
        throw error;
      });

    if (!session?.user?.id) {
      throw new UnauthorizedException('Invalid or expired session');
    }
    release();

    // Verify admin role from the database (better-auth managed field)
    const user = await db.user
      .findUnique({
        where: { id: session.user.id },
        select: {
          id: true,
          email: true,
          role: true,
        },
      })
      .catch(storeOutage);

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (user.role !== 'admin') {
      throw new ForbiddenException(
        'Access denied: Platform admin privileges required',
      );
    }

    // Set request context
    request.userId = user.id;
    request.userEmail = user.email;
    request.isPlatformAdmin = true;

    return true;
  }
}
