import {
  type ProductionTarget,
  productionVerdict,
} from '../../../packages/db/src/production-target.ts';

// The checks every value of comp/production/config passes before push-secrets writes it.
// Messages name the key and never the value, not even a part of it.

const MIN_TOKEN_LENGTH = 32;
const TOKEN_KEY = /^(SERVICE_TOKEN_[A-Z0-9_]+|COMP_FORWARDED_IP_TOKEN|INTERNAL_API_TOKEN)$/;
const LAPTOP_HOSTS = ['localhost', '127.0.0.1', 'host.docker.internal'] as const;
const PROJECT_REF = /^proj_[a-z0-9]{20}$/;
const UPSTREAM_PROJECT_REFS: readonly string[] = ['proj_zhioyrusqertqgafqgpj', 'proj_lhxjliiqgcdyqbgtucda'];
const DATABASE_KEYS: readonly string[] = ['DATABASE_URL', 'DATABASE_MIGRATION_URL'];
const TRANSACTION_POOLER_PORT = '6543';
const ENCODE = 'percent-encode the user and password';

/** Why a value cannot be pushed under `key`; empty when it can. */
export function valueProblems({
  key,
  value,
  target,
}: {
  key: string;
  value: string;
  target: ProductionTarget;
}): string[] {
  if (value === '') return [`${key} is empty`];
  if (/[\r\n]/.test(value)) return [`${key} contains a line break`];
  if (value.includes('\0')) return [`${key} contains a NUL character`];
  const lowered = value.toLowerCase();
  const laptopHost = LAPTOP_HOSTS.find((host) => lowered.includes(host));
  if (laptopHost) {
    return [`${key} names ${laptopHost}, a laptop-only address; production needs the hosted service`];
  }
  if (TOKEN_KEY.test(key) && value.length < MIN_TOKEN_LENGTH) {
    return [`${key} must be at least ${MIN_TOKEN_LENGTH} characters`];
  }
  if (DATABASE_KEYS.includes(key)) return databaseUrlProblems({ key, value, target });
  if (key.startsWith('TRIGGER_SECRET_KEY_')) return triggerSecretKeyProblems({ key, value });
  if (key.startsWith('TRIGGER_PROJECT_REF_')) return projectRefProblems({ key, value });
  if (key === 'TRIGGER_ACCESS_TOKEN' && !value.startsWith('tr_pat_')) {
    return [`${key} must be a Trigger.dev personal access token (tr_pat_...)`];
  }
  return [];
}

function triggerSecretKeyProblems({ key, value }: { key: string; value: string }): string[] {
  if (value.startsWith('tr_prod_')) return [];
  if (value.startsWith('tr_dev_')) {
    return [`${key} is a dev key (tr_dev_); use the prod key (tr_prod_...) of the project`];
  }
  return [`${key} must be a Trigger.dev prod key (tr_prod_...)`];
}

function projectRefProblems({ key, value }: { key: string; value: string }): string[] {
  if (UPSTREAM_PROJECT_REFS.includes(value)) {
    return [`${key} is an upstream Comp AI project; use the Revola project ref`];
  }
  if (!PROJECT_REF.test(value)) {
    return [`${key} must be a Trigger.dev project ref (proj_ and 20 lowercase letters or digits)`];
  }
  return [];
}

/**
 * A database URL must parse, carry a user and password before the host, read back exactly as
 * written (so no unescaped character was reinterpreted: an unescaped /, ?, # or @ in the
 * password would otherwise be read as a host, port or path and echoed in a driver error), avoid
 * the transaction pooler, and name the production database (packages/db/production-target.ts).
 */
function databaseUrlProblems({
  key,
  value,
  target,
}: {
  key: string;
  value: string;
  target: ProductionTarget;
}): string[] {
  if (!URL.canParse(value)) return [`${key} is not a valid URL; ${ENCODE}`];
  const url = new URL(value);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    return [`${key} must be a postgres:// or postgresql:// URL`];
  }
  if (url.username === '' || url.password === '') {
    return [
      `${key} has no user and password before the host; an unescaped /, ?, # or @ in the password ends it early, so ${ENCODE}`,
    ];
  }
  if (url.href !== value) {
    return [`${key} does not read back as written (an unescaped character in the user or password); ${ENCODE}`];
  }
  if (url.port === TRANSACTION_POOLER_PORT) {
    return [
      `${key} uses port ${TRANSACTION_POOLER_PORT}, the transaction pooler; use the session pooler (5432) or the direct host`,
    ];
  }
  const verdict = productionVerdict({ databaseUrl: value, env: {}, target });
  if (verdict === 'unverifiable') {
    return [`${key} cannot be checked against the production database; ${ENCODE}`];
  }
  if (verdict === 'not_production') {
    return [`${key} does not name the production database (packages/db/production-target.json)`];
  }
  return [];
}
