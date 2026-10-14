/**
 * Path building for server-side API calls. The caller appends the path to the
 * API base URL, and URL parsing removes dot segments, so an unencoded id such
 * as `../internal/x` would move the request onto a different API route. Every
 * interpolated segment goes through encodePathSegment(), and the server API
 * clients run assertSafeApiPath() on the finished path as a second line.
 */

export class InvalidApiPathError extends Error {
  constructor(reason: string) {
    super(`Invalid API path: ${reason}`);
    this.name = 'InvalidApiPathError';
  }
}

/** `.`, `..` and their percent-encoded spellings, which URL parsers resolve. */
function isDotSegment(segment: string): boolean {
  const normalized = segment.replace(/%2e/gi, '.');
  return normalized === '.' || normalized === '..';
}

/**
 * One path segment: percent-encoded (so `/`, `?` and `#` stay inside it), and
 * never empty, `.` or `..`, which no resource id legitimately is.
 */
export function encodePathSegment(value: string): string {
  if (value === '' || isDotSegment(value)) {
    throw new InvalidApiPathError('empty or dot path segment');
  }
  return encodeURIComponent(value);
}

/**
 * Refuses a path that would not stay where it says once resolved against the
 * API base URL: not starting with a single `/`, containing a backslash, or
 * containing a dot segment. The query string is not inspected.
 */
export function assertSafeApiPath(path: string): void {
  const [pathname = ''] = path.split(/[?#]/, 1);
  if (!pathname.startsWith('/') || pathname.startsWith('//')) {
    throw new InvalidApiPathError('must start with a single /');
  }
  if (pathname.includes('\\')) {
    throw new InvalidApiPathError('backslash in path');
  }
  if (pathname.split('/').some(isDotSegment)) {
    throw new InvalidApiPathError('dot segment in path');
  }
}
