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
    // attempt of the verified client IP bucket first (429 once the bucket is
    // full, with no lookup), given back once the lookup accepts it; the same
    // rule as HybridAuthGuard. Cookies are signed, so a forged one is refused
    // before any lookup, and cookie-only requests never take an attempt.
    const release = authHeader
      ? credentialAttemptTaker({ limiter: this.attemptLimiter, context })()
      : () => undefined;

    // Resolve session via better-auth SDK
    const session = await auth.api.getSession({ headers });

    if (!session?.user?.id) {
      throw new UnauthorizedException('Invalid or expired session');
    }
    release();

    // Verify admin role from the database (better-auth managed field)
    const user = await db.user.findUnique({
      where: { id: session.user.id },
      select: {
        id: true,
        email: true,
        role: true,
      },
    });

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
