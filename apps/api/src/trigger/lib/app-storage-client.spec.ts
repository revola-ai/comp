import { createAppStorageClient } from './app-storage-client';

const CREDENTIALS = {
  APP_AWS_ACCESS_KEY_ID: 'test-access-key',
  APP_AWS_SECRET_ACCESS_KEY: 'test-secret-key',
};

describe('createAppStorageClient', () => {
  it('uses APP_AWS_ENDPOINT with path-style access', async () => {
    const client = createAppStorageClient({
      env: {
        ...CREDENTIALS,
        APP_AWS_REGION: 'us-east-2',
        APP_AWS_ENDPOINT: 'https://ref.storage.supabase.co/storage/v1/s3',
      },
    });
    expect(client.config.forcePathStyle).toBe(true);
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe('ref.storage.supabase.co');
    expect(endpoint?.path).toBe('/storage/v1/s3');
    expect(await client.config.region()).toBe('us-east-2');
  });

  it('uses the AWS default endpoint and virtual-hosted style without APP_AWS_ENDPOINT', async () => {
    const client = createAppStorageClient({
      env: { ...CREDENTIALS, APP_AWS_ENDPOINT: '' },
    });
    expect(client.config.forcePathStyle).toBe(false);
    expect(client.config.endpoint).toBeUndefined();
    expect(await client.config.region()).toBe('us-east-1');
  });

  it('passes the APP_AWS credentials', async () => {
    const client = createAppStorageClient({ env: CREDENTIALS });
    const credentials = await client.config.credentials();
    expect(credentials.accessKeyId).toBe('test-access-key');
    expect(credentials.secretAccessKey).toBe('test-secret-key');
  });

  it('throws a named error when credentials are missing', () => {
    expect(() =>
      createAppStorageClient({ env: { APP_AWS_ACCESS_KEY_ID: 'x' } }),
    ).toThrow(/APP_AWS_SECRET_ACCESS_KEY/);
  });

  it('rejects an APP_AWS_ENDPOINT that is not a URL', () => {
    expect(() =>
      createAppStorageClient({
        env: { ...CREDENTIALS, APP_AWS_ENDPOINT: 'not a url' },
      }),
    ).toThrow(/APP_AWS_ENDPOINT/);
  });
});
