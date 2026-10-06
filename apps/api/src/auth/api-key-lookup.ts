import { db } from '@db';
import { createHash } from 'node:crypto';
import {
  API_KEY_VALIDATION_SELECT,
  type ApiKeyCandidate,
  LEGACY_KEY_SCAN_LIMIT,
} from './api-key-validation';

/** Keys minted since key prefixes exist: `comp_` and 64 hex characters. */
const PREFIXED_KEY = /^comp_[0-9a-f]{64}$/;

/** SHA-256 of the key plus its salt; legacy keys were hashed without one. */
export function hashApiKey({
  apiKey,
  salt,
}: {
  apiKey: string;
  salt?: string | null;
}): string {
  return createHash('sha256')
    .update(salt ? apiKey + salt : apiKey)
    .digest('hex');
}

/** The first 8 characters after `comp_`, stored (and indexed) as `keyPrefix`. */
export function extractKeyPrefix(apiKey: string): string {
  return apiKey.slice(5, 13);
}

function activeAndUnexpired() {
  return {
    isActive: true,
    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
  };
}

function findByHash({
  apiKey,
  candidates,
}: {
  apiKey: string;
  candidates: ApiKeyCandidate[];
}): ApiKeyCandidate | undefined {
  return candidates.find(
    (record) => hashApiKey({ apiKey, salt: record.salt }) === record.key,
  );
}

export type ApiKeyMatch = {
  record: ApiKeyCandidate;
  /** Set when a prefixed key matched a legacy row, so its prefix can be stored. */
  backfillPrefix: string | null;
};

/**
 * The stored key matching a presented one. A well-formed key is looked up by
 * its indexed prefix; only if that finds nothing are legacy rows (no stored
 * prefix) tried. Anything else gets the legacy lookup alone. The legacy lookup
 * is bounded, so a junk key never reads or hashes the whole table.
 */
export async function findMatchingApiKey({
  apiKey,
  onLegacyLimitReached,
}: {
  apiKey: string;
  onLegacyLimitReached: () => void;
}): Promise<ApiKeyMatch | undefined> {
  const keyPrefix = PREFIXED_KEY.test(apiKey) ? extractKeyPrefix(apiKey) : null;
  if (keyPrefix) {
    const byPrefix = findByHash({
      apiKey,
      candidates: await db.apiKey.findMany({
        where: { ...activeAndUnexpired(), keyPrefix },
        select: API_KEY_VALIDATION_SELECT,
      }),
    });
    if (byPrefix) return { record: byPrefix, backfillPrefix: null };
  }
  const legacy = await db.apiKey.findMany({
    where: { ...activeAndUnexpired(), keyPrefix: null },
    select: API_KEY_VALIDATION_SELECT,
    orderBy: { lastUsedAt: { sort: 'desc', nulls: 'last' } },
    take: LEGACY_KEY_SCAN_LIMIT,
  });
  if (legacy.length >= LEGACY_KEY_SCAN_LIMIT) onLegacyLimitReached();
  const match = findByHash({ apiKey, candidates: legacy });
  return match ? { record: match, backfillPrefix: keyPrefix } : undefined;
}
