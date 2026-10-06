import type { NextFunction, Request, Response } from 'express';
import { verifiedClientIp } from './identity-tracker';

/**
 * The only header better-auth reads the client IP from
 * (`advanced.ipAddress.ipAddressHeaders` in auth.server.ts), so its built-in
 * rate limiter keys on the verified client IP instead of a forgeable
 * X-Forwarded-For.
 */
export const CLIENT_IP_HEADER = 'x-comp-client-ip';

/** Replaces any client-supplied CLIENT_IP_HEADER with the verified client IP. */
export function clientIpHeaderMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  delete req.headers[CLIENT_IP_HEADER];
  const ip = verifiedClientIp({ req });
  if (ip) req.headers[CLIENT_IP_HEADER] = ip;
  next();
}
