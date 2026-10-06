import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { buildPgAdapterOptions } from '@trycompai/db';

const globalForPrisma = global as unknown as { prisma?: PrismaClient };

function createPrismaClient(): PrismaClient {
  // One connection policy for every client (packages/db buildPgAdapterOptions): TLS from
  // resolveSslConfig, DATABASE_POOL_MAX, and ca_file_missing when a production process
  // would reach a remote database without DATABASE_SSL_CA.
  const adapter = new PrismaPg(
    buildPgAdapterOptions({ databaseUrl: process.env.DATABASE_URL }),
  );
  return new PrismaClient({
    adapter,
    transactionOptions: {
      timeout: 60000,
    },
  });
}

// Lazy initialization. Importing this module does NOT construct a Prisma client
// - that only happens on first property access on `db`. Critical so that
// Next.js `next build` (which imports every route handler to analyze it) does
// not trigger the strict TLS check at build time when no actual queries run.
function getClient(): PrismaClient {
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = createPrismaClient();
  }
  return globalForPrisma.prisma;
}

// Builds the client eagerly (no connection is opened). The API calls this at boot so a
// broken connection policy (ca_file_missing, an invalid DATABASE_POOL_MAX) stops the
// process before it listens, instead of failing the first query.
export function initDatabaseClient(): void {
  getClient();
}

export const db = new Proxy({} as PrismaClient, {
  get(_target, prop, _receiver) {
    const client = getClient();
    const value = Reflect.get(client, prop, client);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});
