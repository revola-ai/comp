/**
 * An error's name and code only, for logs: never its message, which could
 * echo data such as an email address, a token or a secret.
 */
export function describeFailure(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'unknown error';
  const name = Reflect.get(error, 'name');
  const code = Reflect.get(error, 'code');
  const parts = [name, code].filter((part) => typeof part === 'string');
  return parts.length > 0 ? parts.join(' ') : 'unknown error';
}
