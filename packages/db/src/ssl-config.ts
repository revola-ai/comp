import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rootCertificates } from 'node:tls';

export type SslConfig =
  | undefined
  | { ca: string[] }
  | { checkServerIdentity: () => undefined }
  | { rejectUnauthorized: false };

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

function isLocalhostUrl(connectionString: string): boolean {
  try {
    const { hostname } = new URL(connectionString);
    const stripped = hostname.replace(/^\[/, '').replace(/\]$/, '');
    return LOCAL_HOSTNAMES.has(stripped);
  } catch {
    // Malformed URL — be conservative and treat as remote so we don't
    // accidentally disable TLS verification.
    return false;
  }
}

export function resolveSslConfig(
  databaseUrl: string,
  env: Partial<NodeJS.ProcessEnv> = process.env,
): SslConfig {
  if (isLocalhostUrl(databaseUrl)) return undefined;
  if (env.DATABASE_SSL_CA) return { ca: trustStoreWith(env.DATABASE_SSL_CA) };
  if (env.PRISMA_ALLOW_INSECURE_TLS === '1') return { rejectUnauthorized: false };
  // Verified TLS via Node's default trust store, which includes Amazon Root
  // CA 1 — where AWS RDS Proxy chains terminate. Hostname check is skipped
  // because connections traverse an AWS NLB whose hostname isn't in the RDS
  // Proxy cert's SAN list; the chain check still rejects forged or wrong-CA
  // certs.
  //
  // Previously this returned `{ ca: RDS_CA_BUNDLE, ... }` — but `ssl.ca`
  // *replaces* Node's trust store rather than augmenting it, and the bundle
  // only contains regional RDS CAs (not Amazon Root CA 1), so RDS Proxy
  // chain validation failed at runtime (P1011 / TlsConnectionError).
  return { checkServerIdentity: () => undefined };
}

// Full verification (chain and hostname) against Node's default trust store plus the
// CA file named by DATABASE_SSL_CA, for providers whose server certificate is signed
// by their own root (Supabase). `ssl.ca` replaces the trust store, so the defaults
// are included explicitly. Relative paths resolve against the working directory;
// use an absolute path in .env files.
function trustStoreWith(caPath: string): string[] {
  const absolute = resolve(caPath);
  if (!existsSync(absolute)) {
    throw new Error(`DATABASE_SSL_CA points to a file that does not exist: ${absolute}`);
  }
  return [...rootCertificates, readFileSync(absolute, 'utf8')];
}
