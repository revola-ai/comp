import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { resolveSslConfig } from '@trycompai/db';

const globalForPrisma = global as unknown as { prisma?: PrismaClient };

function stripSslMode(connectionString: string): string {
  const url = new URL(connectionString);
  url.searchParams.delete('sslmode');
  return url.toString();
}

function createPrismaClient(): PrismaClient {
  const rawUrl = process.env.DATABASE_URL!;
  // TLS policy is shared with packages/db (resolveSslConfig):
  // - localhost: TLS off;
  // - DATABASE_SSL_CA set: full verification against Node's trust store plus that CA;
  // - PRISMA_ALLOW_INSECURE_TLS=1: unverified TLS, opt-in only;
  // - otherwise: chain verified against Node's trust store (NODE_EXTRA_CA_CERTS
  //   augments it), hostname check skipped for RDS Proxy behind an NLB.
  const ssl = resolveSslConfig(rawUrl);
  // Strip sslmode from the connection string to avoid conflicts with the explicit ssl option
  const url = ssl !== undefined ? stripSslMode(rawUrl) : rawUrl;
  const adapter = new PrismaPg({ connectionString: url, ssl });
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

export const db = new Proxy({} as PrismaClient, {
  get(_target, prop, _receiver) {
    const client = getClient();
    const value = Reflect.get(client, prop, client);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});
