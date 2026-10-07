import type { HeaderBag } from '../throttle/verified-headers';
import { headerValue } from '../throttle/verified-headers';

/** The machine credentials HybridAuthGuard accepts, checked in this order. */
export const API_KEY_HEADER = 'x-api-key';
export const SERVICE_TOKEN_HEADER = 'x-service-token';

/**
 * Whether the request presents a machine credential (an API key or a service
 * token). Session cookies and Bearer session tokens are not machine
 * credentials; HybridAuthGuard accepts no API key in a Bearer header.
 */
export function presentsMachineCredential(headers: HeaderBag): boolean {
  return [API_KEY_HEADER, SERVICE_TOKEN_HEADER].some((name) =>
    Boolean(headerValue({ headers, name })),
  );
}
