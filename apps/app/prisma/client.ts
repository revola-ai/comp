import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { buildPgAdapterOptions } from '@trycompai/db';

const globalForPrisma = global as unknown as { prisma?: PrismaClient };

function createPrismaClient(): PrismaClient {
  // One connection policy for every client (packages/db buildPgAdapterOptions): TLS from
  // resolveSslConfig, DATABASE_POOL_MAX, and ca_file_missing when a production process
  // would reach a remote database without DATABASE_SSL_CA.
  const adapter = new PrismaPg(buildPgAdapterOptions({ databaseUrl: process.env.DATABASE_URL }));
  return new PrismaClient({
    adapter,
    transactionOptions: {
      timeout: 60000,
    },
  });
}

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
