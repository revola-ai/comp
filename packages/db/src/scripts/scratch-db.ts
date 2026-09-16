/**
 * Guard for database test suites: they may only run against a scratch database whose
 * name (the URL's last path segment) ends in `_test`, never against the working
 * database `comp`, and never against a prod or staging host.
 */
export function isScratchDatabaseUrl(databaseUrl: string | undefined): boolean {
  if (!databaseUrl) return false;
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (host.includes('prod') || host.includes('staging')) return false;
  const databaseName = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
  return databaseName.endsWith('_test');
}
