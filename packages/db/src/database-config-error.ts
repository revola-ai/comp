export type DatabaseConfigErrorCode =
  'ca_file_missing' | 'database_url_invalid' | 'database_url_missing' | 'pool_max_invalid';

// A connection setting that makes it unsafe or impossible to build a Prisma client.
// The code leads the message so it shows up in a crashed container's stderr; the
// message never carries the connection string.
export class DatabaseConfigError extends Error {
  readonly code: DatabaseConfigErrorCode;

  constructor({ code, detail }: { code: DatabaseConfigErrorCode; detail: string }) {
    super(`${code}: ${detail}`);
    this.name = 'DatabaseConfigError';
    this.code = code;
  }
}
