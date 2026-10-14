import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// X-Comp-Origin-Auth is the shared secret that proves a request came through
// Cloudflare. The API has no Sentry SDK and no request logger today; these
// tripwires keep it that way unless the newcomer scrubs the header.
const API_ROOT = resolve(__dirname, '../..');
const SRC = resolve(API_ROOT, 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    const isSource = /\.ts$/.test(name) && !/\.(spec|test)\.ts$/.test(name);
    return isSource ? [path] : [];
  });
}

describe('origin header never reaches API error reporting or request logs', () => {
  const files = sourceFiles(SRC);

  it('scans the API sources', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('has no Sentry SDK; adding one requires a beforeSend that drops x-comp-origin-auth', () => {
    const pkg = readFileSync(resolve(API_ROOT, 'package.json'), 'utf8');
    expect(pkg).not.toMatch(/@sentry\//);
    const offenders = files.filter((file) =>
      /from ['"]@sentry\//.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map((file) => relative(API_ROOT, file))).toEqual([]);
  });

  it('never logs a whole request header object', () => {
    const logCall =
      /\b(console|logger|this\.logger)\.(log|info|warn|error|debug|verbose)\([^;]*\b(req|request)\.(headers|rawHeaders)\s*[,)]/;
    const offenders = files.filter((file) =>
      logCall.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map((file) => relative(API_ROOT, file))).toEqual([]);
  });
});
