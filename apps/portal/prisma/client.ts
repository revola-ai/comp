import { PrismaClient } from '../src/generated/prisma/client';
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
  // TLS policy is shared with packages/db (resolveSslConfig): localhost off;
  // DATABASE_SSL_CA verified against Node's roots plus that CA; otherwise
  // Node's trust store with the hostname check skipped (RDS Proxy behind an NLB);
  // PRISMA_ALLOW_INSECURE_TLS=1 is an explicit opt-out.
  const ssl = resolveSslConfig(rawUrl);

  const url = ssl !== undefined ? stripSslMode(rawUrl) : rawUrl;
  const adapter = new PrismaPg({ connectionString: url, ssl });
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
