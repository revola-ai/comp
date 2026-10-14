import type { ReadinessCheck } from '@trycompai/db';
import { checkApiReadiness } from '../health/readiness';
import {
  isCredentialStoreFailure,
  isSessionLookupFailure,
} from './credential-store-error';

/**
 * Whether a failed session lookup means the credential store is down (503,
 * the attempt given back) rather than a bad credential (401, the attempt
 * kept). A database or network failure in the error says so outright.
 * better-auth's causeless FAILED_TO_GET_SESSION does not: a malformed
 * session_data cookie next to any bearer token produces it too, which would
 * otherwise let a client turn every guess into a refunded 503. It counts as
 * an outage only when a short database probe also fails: `checkApiReadiness`
 * (`SELECT 1` on its own connection, a 2-second deadline, results shared by
 * concurrent callers and reused for 2 seconds, so a flood of such requests
 * opens at most one probe connection at a time).
 */
export async function isSessionStoreOutage({
  error,
  checkReadiness = checkApiReadiness,
}: {
  error: unknown;
  checkReadiness?: ReadinessCheck;
}): Promise<boolean> {
  if (isCredentialStoreFailure(error)) return true;
  if (!isSessionLookupFailure(error)) return false;
  const readiness = await checkReadiness();
  return readiness.status !== 'ok';
}
