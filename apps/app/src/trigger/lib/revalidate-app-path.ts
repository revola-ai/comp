import { logger } from '@trigger.dev/sdk';
import axios from 'axios';
import { getRevalidateUrl } from './revalidate-url';

/**
 * Busts the app's cache for one path from a Trigger.dev task. The request body
 * carries REVALIDATION_SECRET, and an AxiosError holds the request config (body
 * included), so a failure is logged as its message and HTTP status only, never
 * as the error object. Never throws: a stale page is not worth failing a task.
 */
export async function revalidateAppPath({
  path,
  type,
}: {
  path: string;
  type?: 'layout' | 'page';
}): Promise<boolean> {
  const secret = process.env.REVALIDATION_SECRET;
  try {
    const response = await axios.post<{ revalidated?: boolean }>(getRevalidateUrl(), {
      path,
      ...(type ? { type } : {}),
      secret,
    });
    if (response.data?.revalidated) {
      logger.info('Revalidated app path', { path });
      return true;
    }
    logger.error('App path was not revalidated', { path, status: response.status });
    return false;
  } catch (error) {
    logger.error('Failed to revalidate app path', {
      path,
      ...describeFailure({ error, secret }),
    });
    return false;
  }
}

function describeFailure({ error, secret }: { error: unknown; secret: string | undefined }): {
  status?: number;
  error: string;
} {
  const message = error instanceof Error ? error.message : 'Unknown error';
  const redacted = secret ? message.split(secret).join('[redacted]') : message;
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  return status === undefined ? { error: redacted } : { status, error: redacted };
}
