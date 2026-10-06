import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { db } from '@db';
import { statement } from '@trycompai/auth';
import { randomBytes } from 'node:crypto';
import { lockKeyCreator } from './api-key-creator-lock';
import type { ApiKeyProvenance } from './api-key-provenance';
import {
  extractKeyPrefix,
  findMatchingApiKey,
  hashApiKey,
} from './api-key-lookup';
import {
  type ApiKeyValidationResult,
  apiKeyRejection,
  LEGACY_KEY_SCAN_LIMIT,
  toValidationResult,
} from './api-key-validation';

export type { ApiKeyValidationResult } from './api-key-validation';

@Injectable()
export class ApiKeyService {
  private readonly logger = new Logger(ApiKeyService.name);

  private generateApiKey(): string {
    const apiKey = randomBytes(32).toString('hex');
    return `comp_${apiKey}`;
  }

  private generateSalt(): string {
    return randomBytes(16).toString('hex');
  }

  async create({
    organizationId,
    name,
    expiresAt,
    scopes,
    provenance,
  }: {
    organizationId: string;
    name: string;
    expiresAt?: string;
    scopes?: string[];
    provenance: ApiKeyProvenance;
  }) {
    // New keys must have explicit scopes — no more legacy empty-scope keys
    if (!scopes || scopes.length === 0) {
      throw new BadRequestException(
        'API keys must have at least one scope. Use the "Full Access" preset to grant all permissions.',
      );
    }
    // Validate all scopes against the allowlist
    const availableScopes = this.getAvailableScopes();
    const invalid = scopes.filter((s) => !availableScopes.includes(s));
    if (invalid.length > 0) {
      throw new BadRequestException(`Invalid scopes: ${invalid.join(', ')}`);
    }

    const apiKey = this.generateApiKey();
    const salt = this.generateSalt();
    const hashedKey = hashApiKey({ apiKey, salt });

    let expirationDate: Date | null = null;
    if (expiresAt && expiresAt !== 'never') {
      const now = new Date();
      switch (expiresAt) {
        case '30days':
          expirationDate = new Date(now.setDate(now.getDate() + 30));
          break;
        case '90days':
          expirationDate = new Date(now.setDate(now.getDate() + 90));
          break;
        case '1year':
          expirationDate = new Date(now.setFullYear(now.getFullYear() + 1));
          break;
        default:
          throw new BadRequestException(
            `Invalid expiresAt value: ${expiresAt}. Must be "never", "30days", "90days", or "1year".`,
          );
      }
    }

    const keyPrefix = extractKeyPrefix(apiKey);

    // The creator's row stays locked until the key is committed, so a
    // concurrent removal or deactivation either runs first (and creation is
    // refused) or after (and revokes this key).
    const record = await db.$transaction(async (tx) => {
      const createdByMemberId = await lockKeyCreator({
        tx,
        organizationId,
        provenance,
      });
      return tx.apiKey.create({
        data: {
          name,
          key: hashedKey,
          keyPrefix,
          salt,
          expiresAt: expirationDate,
          organizationId,
          scopes,
          createdByMemberId,
          organizationOwned: provenance.organizationOwned,
        },
        select: {
          id: true,
          name: true,
          createdAt: true,
          expiresAt: true,
        },
      });
    });

    return {
      ...record,
      key: apiKey,
      createdAt: record.createdAt.toISOString(),
      expiresAt: record.expiresAt ? record.expiresAt.toISOString() : null,
    };
  }

  async revoke(apiKeyId: string, organizationId: string) {
    const result = await db.apiKey.updateMany({
      where: {
        id: apiKeyId,
        organizationId,
      },
      data: {
        isActive: false,
      },
    });

    if (result.count === 0) {
      throw new NotFoundException(
        'API key not found or not authorized to revoke',
      );
    }

    return { success: true };
  }

  /**
   * Extract API key from request headers
   * @param apiKeyHeader X-API-Key header value
   * @returns The API key if found, null otherwise
   */
  extractApiKey(apiKeyHeader?: string): string | null {
    // Check if it's an X-API-Key header
    if (apiKeyHeader) {
      return apiKeyHeader;
    }

    return null;
  }

  /**
   * Validate an API key and return the organization ID + scopes
   * @param apiKey The API key to validate
   * @returns The validation result if valid, null otherwise
   */
  async validateApiKey(apiKey: string): Promise<ApiKeyValidationResult | null> {
    if (!apiKey) {
      return null;
    }

    try {
      // Check if the model exists in the Prisma client
      if (typeof db.apiKey === 'undefined') {
        this.logger.error(
          'ApiKey model not found. Make sure to run migrations.',
        );
        return null;
      }

      const match = await findMatchingApiKey({
        apiKey,
        onLegacyLimitReached: () =>
          this.logger.warn(
            `Legacy API key lookup hit its limit of ${LEGACY_KEY_SCAN_LIMIT} keys without a stored prefix`,
          ),
      });
      if (!match) {
        this.logger.warn('Invalid or expired API key attempted');
        return null;
      }
      const { record: matchingRecord, backfillPrefix } = match;

      // Offboarding: a personal key stops working once its creator is no
      // longer an active member, even before revocation has run, and a
      // creatorless personal key newer than the legacy cutoff is an orphan.
      const rejection = apiKeyRejection(matchingRecord);
      if (rejection) {
        this.logger.warn(
          `API key ${matchingRecord.id} rejected (${rejection}): its creator is no longer an active member`,
        );
        return null;
      }

      await db.apiKey.update({
        where: { id: matchingRecord.id },
        data: {
          lastUsedAt: new Date(),
          ...(backfillPrefix ? { keyPrefix: backfillPrefix } : {}),
        },
      });

      this.logger.log(
        `Valid API key used for organization: ${matchingRecord.organizationId}`,
      );

      return toValidationResult(matchingRecord);
    } catch (error) {
      this.logger.error('Error validating API key:', error);
      return null;
    }
  }

  /**
   * Resources from better-auth that are not used by any API endpoint's @RequirePermission.
   * These are handled internally by better-auth for session-based auth only.
   */
  private static readonly INTERNAL_ONLY_RESOURCES = ['invitation', 'team'];

  /**
   * Returns all valid `resource:action` scope pairs derived from the permission statement.
   * Excludes internal-only resources that no API endpoint uses via @RequirePermission.
   */
  getAvailableScopes(): string[] {
    const scopes: string[] = [];
    for (const [resource, actions] of Object.entries(statement)) {
      if (ApiKeyService.INTERNAL_ONLY_RESOURCES.includes(resource)) {
        continue;
      }
      for (const action of actions) {
        scopes.push(`${resource}:${action}`);
      }
    }
    return scopes;
  }
}
