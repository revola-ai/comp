import { ServiceUnavailableException } from '@nestjs/common';

/** The reason a credential check answers 503: the store behind it is down. */
export const CREDENTIAL_STORE_UNAVAILABLE = 'credential_store_unavailable';

/** 503 with a named reason and no details of the underlying failure. */
export function credentialStoreUnavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    statusCode: 503,
    error: 'Service Unavailable',
    reason: CREDENTIAL_STORE_UNAVAILABLE,
    message: 'Authentication is temporarily unavailable. Retry shortly.',
  });
}

// Prisma's connection-level failures: P1xxx (cannot reach, timed out, TLS...),
// P2024 (pool timeout) and P2010 (a raw query the driver adapter failed).
const PRISMA_INFRA_CODE = /^P1\d{3}$|^P2024$|^P2010$/;
const PRISMA_INFRA_ERRORS = new Set([
  'PrismaClientInitializationError',
  'PrismaClientRustPanicError',
  'PrismaClientUnknownRequestError',
  'DriverAdapterError',
]);
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);
const MAX_CHAIN = 16;

function isInfrastructureNode(node: Record<string, unknown>): boolean {
  if (typeof node.name === 'string' && PRISMA_INFRA_ERRORS.has(node.name)) {
    return true;
  }
  const code = typeof node.code === 'string' ? node.code : '';
  if (node.name === 'PrismaClientKnownRequestError') {
    return PRISMA_INFRA_CODE.test(code);
  }
  return NETWORK_CODES.has(code);
}

/**
 * Whether an error (or anything in its `cause` chain) is a database or network
 * failure rather than a verdict about the credential.
 */
export function isCredentialStoreFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CHAIN; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    const node = current as Record<string, unknown>;
    if (isInfrastructureNode(node)) return true;
    current = node.cause;
  }
  return false;
}
