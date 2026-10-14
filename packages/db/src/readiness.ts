// Database readiness: run a probe (SELECT 1) under a timeout and turn any failure
// into a short, non-sensitive reason. Reasons, in order of precedence:
// `tls_<CODE>` (a Node TLS code anywhere in the error), the Prisma code,
// `timeout`, else `unknown`. Never returns messages, hosts or addresses.
// The probe that talks to the database is in readiness-probe.ts (server only).
//
// No imports: this module is part of the package index, which browser bundles
// reach through the apps' `@db` re-exports.

export const READINESS_TIMEOUT_MS = 2000;

// How long a readiness result is reused before the next check probes again. The
// ALB health checks use the liveness routes, so readiness this fresh is enough,
// and back-to-back callers do not each cost a handshake with the database.
export const READINESS_CACHE_MS = 2000;

export type ReadinessResult = { status: 'ok' } | { status: 'unavailable'; reason: string };

// Node's X509 verification codes (https://nodejs.org/api/tls.html, "X509 certificate
// error codes"), which are OpenSSL's verify results.
const X509_CODES = new Set([
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_CRL',
  'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
  'UNABLE_TO_DECRYPT_CRL_SIGNATURE',
  'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
  'CERT_SIGNATURE_FAILURE',
  'CRL_SIGNATURE_FAILURE',
  'CERT_NOT_YET_VALID',
  'CERT_HAS_EXPIRED',
  'CRL_NOT_YET_VALID',
  'CRL_HAS_EXPIRED',
  'ERROR_IN_CERT_NOT_BEFORE_FIELD',
  'ERROR_IN_CERT_NOT_AFTER_FIELD',
  'ERROR_IN_CRL_LAST_UPDATE_FIELD',
  'ERROR_IN_CRL_NEXT_UPDATE_FIELD',
  'OUT_OF_MEM',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_CHAIN_TOO_LONG',
  'CERT_REVOKED',
  'INVALID_CA',
  'PATH_LENGTH_EXCEEDED',
  'INVALID_PURPOSE',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'HOSTNAME_MISMATCH',
]);

const NODE_TLS_CODE = /^ERR_(TLS|SSL)_[A-Z0-9_]+$/;
const PRISMA_CODE = /^P\d{4}$/;

// @prisma/adapter-pg replaces a TLS error with `{ kind: 'TlsConnectionError', reason:
// err.message }` and drops the code, so the code is recovered from OpenSSL's verify
// message (OpenSSL 3 wording; keys are lowercased with hyphens as spaces).
const TLS_MESSAGE_CODES: Record<string, string> = {
  'unable to get issuer certificate': 'UNABLE_TO_GET_ISSUER_CERT',
  'unable to get certificate crl': 'UNABLE_TO_GET_CRL',
  "unable to decrypt certificate's signature": 'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
  "unable to decrypt crl's signature": 'UNABLE_TO_DECRYPT_CRL_SIGNATURE',
  'unable to decode issuer public key': 'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
  'certificate signature failure': 'CERT_SIGNATURE_FAILURE',
  'crl signature failure': 'CRL_SIGNATURE_FAILURE',
  'certificate is not yet valid': 'CERT_NOT_YET_VALID',
  'certificate has expired': 'CERT_HAS_EXPIRED',
  'crl is not yet valid': 'CRL_NOT_YET_VALID',
  'crl has expired': 'CRL_HAS_EXPIRED',
  "format error in certificate's notbefore field": 'ERROR_IN_CERT_NOT_BEFORE_FIELD',
  "format error in certificate's notafter field": 'ERROR_IN_CERT_NOT_AFTER_FIELD',
  "format error in crl's lastupdate field": 'ERROR_IN_CRL_LAST_UPDATE_FIELD',
  "format error in crl's nextupdate field": 'ERROR_IN_CRL_NEXT_UPDATE_FIELD',
  'out of memory': 'OUT_OF_MEM',
  'self signed certificate': 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'self signed certificate in certificate chain': 'SELF_SIGNED_CERT_IN_CHAIN',
  'unable to get local issuer certificate': 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'unable to verify the first certificate': 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'certificate chain too long': 'CERT_CHAIN_TOO_LONG',
  'certificate revoked': 'CERT_REVOKED',
  'invalid ca certificate': 'INVALID_CA',
  'path length constraint exceeded': 'PATH_LENGTH_EXCEEDED',
  'unsupported certificate purpose': 'INVALID_PURPOSE',
  'certificate not trusted': 'CERT_UNTRUSTED',
  'certificate rejected': 'CERT_REJECTED',
  'hostname mismatch': 'HOSTNAME_MISMATCH',
  // Node's own check of the certificate's subjectAltName (not an OpenSSL verify result).
  'invalid subject alternative name string': 'ERR_TLS_CERT_ALTNAME_FORMAT',
};
const ALTNAME_MESSAGE_PREFIX = "hostname/ip does not match certificate's altnames";
const MAX_CHAIN_NODES = 32;

type ErrorNode = Record<string, unknown>;

function isObject(value: unknown): value is ErrorNode {
  return typeof value === 'object' && value !== null;
}

function stringField({ node, key }: { node: ErrorNode; key: string }): string | undefined {
  const value = node[key];
  return typeof value === 'string' ? value : undefined;
}

// Every object reachable through `cause`, Prisma's `meta.driverAdapterError`
// and AggregateError's `errors`, breadth first, each visited once.
function errorChain(error: unknown): ErrorNode[] {
  const nodes: ErrorNode[] = [];
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0 && nodes.length < MAX_CHAIN_NODES) {
    const current = queue.shift();
    if (!isObject(current) || seen.has(current)) continue;
    seen.add(current);
    nodes.push(current);
    queue.push(current.cause);
    if (isObject(current.meta)) queue.push(current.meta.driverAdapterError);
    if (Array.isArray(current.errors)) queue.push(...current.errors);
  }
  return nodes;
}

function tlsCodeFromMessage(message: string): string {
  const normalized = message.trim().toLowerCase().replace(/-/g, ' ');
  if (normalized.startsWith(ALTNAME_MESSAGE_PREFIX)) return 'ERR_TLS_CERT_ALTNAME_INVALID';
  return TLS_MESSAGE_CODES[normalized] ?? 'UNKNOWN';
}

function tlsCode(node: ErrorNode): string | undefined {
  const code = stringField({ node, key: 'code' });
  if (code && (X509_CODES.has(code) || NODE_TLS_CODE.test(code))) return code;
  if (node.kind !== 'TlsConnectionError') return undefined;
  return tlsCodeFromMessage(stringField({ node, key: 'reason' }) ?? '');
}

// A probe that gives up at its own deadline rejects with this code.
const READINESS_TIMEOUT_CODE = 'READINESS_TIMEOUT';

export function readinessTimeoutError(): Error {
  return Object.assign(new Error('database probe exceeded its deadline'), {
    code: READINESS_TIMEOUT_CODE,
  });
}

function prismaCode(node: ErrorNode): string | undefined {
  for (const key of ['code', 'errorCode']) {
    const value = stringField({ node, key });
    if (value && PRISMA_CODE.test(value)) return value;
  }
  return undefined;
}

export function readinessReason(error: unknown): string {
  const chain = errorChain(error);
  for (const node of chain) {
    const code = tlsCode(node);
    if (code) return `tls_${code}`;
  }
  for (const node of chain) {
    const code = prismaCode(node);
    if (code) return code;
  }
  const timedOut = chain.some(
    (node) => stringField({ node, key: 'code' }) === READINESS_TIMEOUT_CODE,
  );
  return timedOut ? 'timeout' : 'unknown';
}

export async function checkDatabaseReadiness({
  probe,
  timeoutMs = READINESS_TIMEOUT_MS,
}: {
  probe: () => Promise<unknown>;
  timeoutMs?: number;
}): Promise<ReadinessResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    // Promise.race subscribes to the probe, so a rejection after the timeout is handled.
    const query = Promise.resolve()
      .then(probe)
      .then(() => 'ok' as const);
    const outcome = await Promise.race([query, timedOut]);
    if (outcome === 'timeout') return { status: 'unavailable', reason: 'timeout' };
    return { status: 'ok' };
  } catch (error) {
    return { status: 'unavailable', reason: readinessReason(error) };
  } finally {
    clearTimeout(timer);
  }
}

export type ReadinessCheck = (options?: { timeoutMs?: number }) => Promise<ReadinessResult>;

export type ReadinessProbe = (options: { timeoutMs: number }) => Promise<unknown>;

/**
 * A readiness check that reuses its last result for `cacheMs` (default
 * READINESS_CACHE_MS) and whose callers share one in-flight probe (single flight): a check
 * that arrives while a probe is outstanding waits on that same probe (with its own
 * timeout) and never starts another, so an outage cannot pile up probes or
 * connections. The probe gets the deadline of the check that starts it and must
 * settle shortly after on its own (createDatabaseReadinessCheck's probe closes its
 * connection at the deadline, or within a second of a successful query, and
 * settles only once it is closed); the next probe starts once it has settled.
 */
export function createReadinessCheck({
  probe,
  cacheMs = READINESS_CACHE_MS,
}: {
  probe: ReadinessProbe;
  cacheMs?: number;
}): ReadinessCheck {
  let last: { result: ReadinessResult; at: number } | undefined;
  let inFlight: Promise<unknown> | undefined;
  const sharedProbe = (timeoutMs: number): Promise<unknown> => {
    if (!inFlight) {
      const started = Promise.resolve().then(() => probe({ timeoutMs }));
      inFlight = started;
      const clear = () => {
        if (inFlight === started) inFlight = undefined;
      };
      started.then(clear, clear);
    }
    return inFlight;
  };
  return async ({ timeoutMs = READINESS_TIMEOUT_MS } = {}) => {
    // A clock that moved backwards (negative age) never keeps a result alive.
    const age = last ? Date.now() - last.at : -1;
    if (last && age >= 0 && age < cacheMs) return last.result;
    const result = await checkDatabaseReadiness({
      probe: () => sharedProbe(timeoutMs),
      timeoutMs,
    });
    last = { result, at: Date.now() };
    return result;
  };
}
