import { S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';

// The S3 client for the application's own storage (evidence, policy PDFs,
// questionnaires, knowledge base) in Trigger tasks. APP_AWS_ENDPOINT points it at
// an S3-compatible store (Supabase Storage, MinIO), which needs path-style URLs.
// Clients that scan a customer's own AWS account are built elsewhere and must not
// use this.

const emptyAsUnset = (value: unknown) => (value === '' ? undefined : value);

const storageEnvSchema = z.object({
  APP_AWS_REGION: z.preprocess(emptyAsUnset, z.string().optional()),
  APP_AWS_ENDPOINT: z.preprocess(
    emptyAsUnset,
    z.string().url({ message: 'APP_AWS_ENDPOINT must be a URL' }).optional(),
  ),
  APP_AWS_ACCESS_KEY_ID: z.preprocess(emptyAsUnset, z.string().optional()),
  APP_AWS_SECRET_ACCESS_KEY: z.preprocess(emptyAsUnset, z.string().optional()),
});

type StorageEnv = Partial<Record<string, string | undefined>>;

export function createAppStorageClient({ env = process.env }: { env?: StorageEnv } = {}): S3Client {
  const parsed = storageEnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => issue.message).join('; ');
    throw new Error(`Invalid application storage configuration: ${issues}`);
  }
  const { APP_AWS_REGION, APP_AWS_ENDPOINT, APP_AWS_ACCESS_KEY_ID, APP_AWS_SECRET_ACCESS_KEY } =
    parsed.data;
  if (!APP_AWS_ACCESS_KEY_ID || !APP_AWS_SECRET_ACCESS_KEY) {
    throw new Error(
      'AWS S3 credentials are missing. Set APP_AWS_ACCESS_KEY_ID and APP_AWS_SECRET_ACCESS_KEY in the Trigger.dev environment.',
    );
  }
  return new S3Client({
    region: APP_AWS_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: APP_AWS_ACCESS_KEY_ID,
      secretAccessKey: APP_AWS_SECRET_ACCESS_KEY,
    },
    ...(APP_AWS_ENDPOINT ? { endpoint: APP_AWS_ENDPOINT, forcePathStyle: true } : {}),
  });
}
