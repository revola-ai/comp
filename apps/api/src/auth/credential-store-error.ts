import { ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';

/** The reason a credential check answers 503: the store behind it is down. */
export const CREDENTIAL_STORE_UNAVAILABLE = 'credential_store_unavailable';

/** Seconds a client should wait before retrying after a credential-store 503. */
export const CREDENTIAL_STORE_RETRY_AFTER_SECONDS = 5;

/**
 * 503 with a named reason and no details of the underlying failure. Its own
 * class so the response gets Retry-After (CredentialStoreUnavailableFilter).
 * The attempt it ended is given back once a database probe confirms the
 * outage (api-key-auth.ts, session-store-outage.ts).
 */
export class CredentialStoreUnavailableException extends ServiceUnavailableException {
  constructor() {
    super({
      statusCode: 503,
      error: 'Service Unavailable',
      reason: CREDENTIAL_STORE_UNAVAILABLE,
      message: 'Authentication is temporarily unavailable. Retry shortly.',
    });
  }
}

export function credentialStoreUnavailable(): CredentialStoreUnavailableException {
  return new CredentialStoreUnavailableException();
}

/** Rethrows `error` as a credential-store 503 if it is a store failure, else as is. */
export function asCredentialStoreError(error: unknown): unknown {
  return isCredentialStoreFailure(error) ? credentialStoreUnavailable() : error;
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

// better-auth's getSession turns any failure inside it into this APIError and
// drops the cause (better-auth 1.6.23, api/routes/session.mjs): an unreachable
// database, but also a malformed session_data cookie next to any bearer token
// (the bearer plugin signs whatever token it is given). It is therefore not
// evidence of an outage by itself; see session-store-outage.ts. Read
// structurally: the class comes from an ESM-only package.
const betterAuthSessionLookupFailure = z.object({
  name: z.literal('APIError'),
  status: z.literal('INTERNAL_SERVER_ERROR'),
  body: z.object({ code: z.literal('FAILED_TO_GET_SESSION') }),
});

/** Whether `error` is better-auth's causeless FAILED_TO_GET_SESSION (500). */
export function isSessionLookupFailure(error: unknown): boolean {
  return betterAuthSessionLookupFailure.safeParse(error).success;
}

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
 * failure rather than a verdict about the credential. better-auth's
 * FAILED_TO_GET_SESSION is not one by itself (isSessionLookupFailure): a
 * client can produce it at will, so session guards confirm it with a database
 * probe first (session-store-outage.ts).
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
