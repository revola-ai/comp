import type * as NodeFs from 'node:fs';
import type * as NodePath from 'node:path';
import type * as NodeTls from 'node:tls';
import { DatabaseConfigError } from './database-config-error';

export type SslConfig =
  | undefined
  | { ca: string[] }
  | { checkServerIdentity: () => undefined }
  | { rejectUnauthorized: false };

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

// pg connects to a `host` query parameter instead of the authority host, so every
// host the URL could reach must be local.
export function isLocalhostUrl(connectionString: string): boolean {
  try {
    const url = new URL(connectionString);
    const queryHosts = url.searchParams.getAll('host');
    const hosts = (queryHosts.length > 0 ? queryHosts : [url.hostname]).flatMap((value) =>
      value.split(','),
    );
    return hosts.every((host) => LOCAL_HOSTNAMES.has(host.replace(/^\[/, '').replace(/\]$/, '')));
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
//
// The built-ins are loaded through process.getBuiltinModule (Node 22, Bun) instead of
// static imports: this package's index is reachable from Next.js client bundles through
// the apps' `@db` re-exports, and a static `node:fs` import breaks those bundles even
// though this function only ever runs on the server.
function trustStoreWith(caPath: string): string[] {
  const fs = process.getBuiltinModule('node:fs') as typeof NodeFs;
  const path = process.getBuiltinModule('node:path') as typeof NodePath;
  const tls = process.getBuiltinModule('node:tls') as typeof NodeTls;
  const absolute = path.resolve(caPath);
  if (!fs.existsSync(absolute)) {
    throw new DatabaseConfigError({
      code: 'ca_file_missing',
      detail: `DATABASE_SSL_CA points to a file that does not exist: ${absolute}`,
    });
  }
  return [...tls.rootCertificates, fs.readFileSync(absolute, 'utf8')];
}

// `sslmode` in the URL conflicts with an explicit `ssl` option; strip it when one is passed.
export function stripSslMode(connectionString: string): string {
  const url = new URL(connectionString);
  url.searchParams.delete('sslmode');
  return url.toString();
}
