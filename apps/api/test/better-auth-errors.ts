import { nativeModule } from './native-module';

type CoreError = typeof import('@better-auth/core/error');

/**
 * The error better-auth's getSession throws when its session lookup fails
 * for any reason other than an APIError, such as an unreachable database
 * (better-auth 1.6.23, api/routes/session.mjs): the real APIError, built the
 * way the library builds it, with the underlying cause dropped.
 */
export function failedToGetSessionError(): Error {
  const { APIError, BASE_ERROR_CODES } = nativeModule<CoreError>(
    '@better-auth/core/error',
  );
  return APIError.from(
    'INTERNAL_SERVER_ERROR',
    BASE_ERROR_CODES.FAILED_TO_GET_SESSION,
  );
}

/** A real better-auth APIError with the given status and body code. */
export function betterAuthApiError({
  status,
  code,
}: {
  status: 'INTERNAL_SERVER_ERROR' | 'UNAUTHORIZED' | 'BAD_REQUEST';
  code: string;
}): Error {
  const { APIError } = nativeModule<CoreError>('@better-auth/core/error');
  return new APIError(status, { code, message: code });
}
