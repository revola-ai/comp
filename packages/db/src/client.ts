import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { buildPgAdapterOptions } from './pg-adapter-options';

export { resolveSslConfig, stripSslMode } from './ssl-config';
export type { SslConfig } from './ssl-config';

const globalForPrisma = global as unknown as { prisma?: PrismaClient };

function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg(buildPgAdapterOptions({ databaseUrl: process.env.DATABASE_URL }));
  return new PrismaClient({
    adapter,
    transactionOptions: { timeout: 60000 },
  });
}

// Lazy initialization. Importing this module does NOT construct a Prisma client
// — that only happens on first property access on `db`. Critical so that
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
