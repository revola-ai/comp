import * as Sentry from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('../sentry.server.config');
    await exitOnDatabaseConfigError();
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config');
  }
}

export const onRequestError = Sentry.captureRequestError;

// Builds the database connection options once at boot so a broken connection policy
// (ca_file_missing in production, an invalid DATABASE_POOL_MAX, no DATABASE_URL) stops
// the server before it serves, instead of failing the first query. Skipped while
// `next build` loads this file.
async function exitOnDatabaseConfigError(): Promise<void> {
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  const { buildPgAdapterOptions, DatabaseConfigError } = await import('@trycompai/db');
  try {
    buildPgAdapterOptions({ databaseUrl: process.env.DATABASE_URL, env: process.env });
  } catch (error) {
    if (!(error instanceof DatabaseConfigError)) throw error;
    // The message carries the code and never the connection string.
    console.error(`[db] ${error.message}`);
    process.exit(1);
  }
}
