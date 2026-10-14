import { db } from '@db';
import { API_KEY_VALIDATION_SELECT } from './api-key-validation';

/** How long the boot check waits for the database before carrying on. */
const SCHEMA_CHECK_TIMEOUT_MS = 5000;
const MAX_CHAIN = 16;

/**
 * The database lacks a column this API build reads from ApiKey: the image
 * was deployed before its migrations were applied (deploy order: migrations
 * first, then the image).
 */
export class ApiKeySchemaOutOfDateError extends Error {
  constructor(column: string) {
    super(
      `The database is missing ${column}, which this API build reads to validate API keys. ` +
        'Apply the pending migrations before deploying this image (packages/db, prisma migrate deploy).',
    );
    this.name = 'ApiKeySchemaOutOfDateError';
  }
}

function field({ node, key }: { node: unknown; key: string }): unknown {
  return typeof node === 'object' && node !== null
    ? Reflect.get(node, key)
    : undefined;
}

/**
 * The missing column named by a Prisma "column does not exist" error (P2022,
 * the driver adapter's ColumnNotFound, or Postgres 42703) anywhere in the
 * error's cause chain, or null when the error is something else.
 */
export function missingColumn(error: unknown): string | null {
  let node: unknown = error;
  for (let depth = 0; depth < MAX_CHAIN && node; depth += 1) {
    const adapterCause = field({
      node: field({
        node: field({ node, key: 'meta' }),
        key: 'driverAdapterError',
      }),
      key: 'cause',
    });
    const column = field({ node: adapterCause, key: 'column' });
    if (
      field({ node, key: 'code' }) === 'P2022' ||
      field({ node: adapterCause, key: 'kind' }) === 'ColumnNotFound' ||
      field({ node: adapterCause, key: 'originalCode' }) === '42703'
    ) {
      return typeof column === 'string' ? column : 'an ApiKey column';
    }
    node = field({ node, key: 'cause' });
  }
  return null;
}

/** `error` as ApiKeySchemaOutOfDateError when it reports a missing column. */
export function asApiKeySchemaError(error: unknown): unknown {
  const column = missingColumn(error);
  return column ? new ApiKeySchemaOutOfDateError(column) : error;
}

/**
 * Boot check: reads one key with every column API-key validation selects.
 * A missing column fails the boot with ApiKeySchemaOutOfDateError, so an
 * image deployed before its migrations stops at once with a clear message
 * instead of answering 500 to every API-key request. Anything else (the
 * database unreachable, or no answer within 5 seconds) is only a warning:
 * it says nothing about the schema.
 */
export async function assertApiKeySchema({
  warn,
}: {
  warn: (message: string) => void;
}): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), SCHEMA_CHECK_TIMEOUT_MS);
  });
  try {
    const outcome = await Promise.race([
      db.apiKey.findFirst({ select: API_KEY_VALIDATION_SELECT }),
      timeout,
    ]);
    if (outcome === 'timeout') {
      warn('Could not check the ApiKey columns at boot: no database answer');
    }
  } catch (error) {
    const checked = asApiKeySchemaError(error);
    if (checked instanceof ApiKeySchemaOutOfDateError) throw checked;
    warn('Could not check the ApiKey columns at boot: the query failed');
  } finally {
    clearTimeout(timer);
  }
}
