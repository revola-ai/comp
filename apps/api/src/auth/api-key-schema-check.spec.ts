// The API reads ApiKey columns added by recent migrations (organizationOwned,
// legacyCreatorless), so its image must not run before they are applied. At
// boot it reads one key with the columns API-key validation selects and
// refuses to start, with a named error saying to migrate first, when the
// database lacks one; validation raises the same error instead of a bare 500.
const mockFindFirst = jest.fn();
const mockFindMany = jest.fn();
const mockCount = jest.fn();
jest.mock('@db', () => ({
  db: {
    apiKey: {
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
      findMany: (...args: unknown[]) => mockFindMany(...args),
      count: (...args: unknown[]) => mockCount(...args),
    },
  },
}));
jest.mock('@trycompai/auth', () => ({ statement: {} }));

import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ApiKeySchemaOutOfDateError,
  assertApiKeySchema,
} from './api-key-schema-check';
import { ApiKeyService } from './api-key.service';
import { API_KEY_VALIDATION_SELECT } from './api-key-validation';

/** Prisma's error for a selected column the database does not have. */
function columnMissing(column: string): Error {
  return new Prisma.PrismaClientKnownRequestError(
    `The column \`${column}\` does not exist in the current database.`,
    {
      code: 'P2022',
      clientVersion: Prisma.prismaVersion.client,
      meta: {
        modelName: 'ApiKey',
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: { kind: 'ColumnNotFound', column },
        },
      },
    },
  );
}

function outage(): Error {
  return Object.assign(new Error("Can't reach database server"), {
    name: 'PrismaClientInitializationError',
  });
}

describe('ApiKey schema check', () => {
  const warn = jest.fn();

  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    mockCount.mockResolvedValue(0);
  });

  it('reads one key with every column validation selects', async () => {
    mockFindFirst.mockResolvedValue(null);
    await expect(assertApiKeySchema({ warn })).resolves.toBeUndefined();
    expect(mockFindFirst).toHaveBeenCalledWith({
      select: API_KEY_VALIDATION_SELECT,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('fails with a named error naming the column when one is missing', async () => {
    mockFindFirst.mockRejectedValue(columnMissing('ApiKey.organizationOwned'));
    const failure = assertApiKeySchema({ warn });
    await expect(failure).rejects.toBeInstanceOf(ApiKeySchemaOutOfDateError);
    await expect(failure).rejects.toThrow(
      /ApiKey\.organizationOwned.*apply the pending migrations before/is,
    );
  });

  it('only warns when the database cannot be reached (an outage is not a stale schema)', async () => {
    mockFindFirst.mockRejectedValue(outage());
    await expect(assertApiKeySchema({ warn })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('stops the API at boot when a column is missing', async () => {
    mockFindFirst.mockRejectedValue(columnMissing('ApiKey.legacyCreatorless'));
    await expect(
      new ApiKeyService().onApplicationBootstrap(),
    ).rejects.toBeInstanceOf(ApiKeySchemaOutOfDateError);
  });

  it('raises the named error from API-key validation too', async () => {
    mockFindMany.mockRejectedValue(columnMissing('ApiKey.organizationOwned'));
    await expect(
      new ApiKeyService().validateApiKey(`comp_${'ab'.repeat(32)}`),
    ).rejects.toBeInstanceOf(ApiKeySchemaOutOfDateError);
  });
});
