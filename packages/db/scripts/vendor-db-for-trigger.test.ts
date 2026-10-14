import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assertWorkspaceDbBuilt, vendorWorkspaceDb } from './vendor-db-for-trigger';

let sandbox = '';
let repoRoot = '';
let outputPath = '';

function write({ path, content }: { path: string; content: string }): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function writeJson({ path, value }: { path: string; value: unknown }): void {
  write({ path, content: JSON.stringify(value, null, 2) });
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'vendor-db-'));
  repoRoot = join(sandbox, 'repo');
  outputPath = join(sandbox, 'out');
  const dbDir = join(repoRoot, 'packages', 'db');
  writeJson({
    path: join(dbDir, 'package.json'),
    value: {
      name: '@trycompai/db',
      version: '2.3.0',
      exports: { '.': { default: './dist/index.js' } },
      dependencies: { '@prisma/client': '7.6.0', zod: '^4.3.6', dotenv: '^16.4.5' },
      devDependencies: { prisma: '7.6.0' },
      scripts: { postinstall: 'node scripts/generate-prisma-client-js.js || true' },
    },
  });
  write({
    path: join(dbDir, 'dist', 'index.js'),
    content: 'exports.resolveSslConfig = () => undefined;\n',
  });
  write({
    path: join(dbDir, 'dist', 'framework-manifest', 'index.js'),
    content: 'module.exports = {};\n',
  });
  write({ path: join(dbDir, 'src', 'index.ts'), content: 'export {};\n' });
  // Hoisted install at the repo root, one package nested under packages/db.
  writeJson({
    path: join(repoRoot, 'node_modules', '@prisma', 'client', 'package.json'),
    value: { version: '7.6.0' },
  });
  writeJson({
    path: join(repoRoot, 'node_modules', 'zod', 'package.json'),
    value: { version: '4.4.3' },
  });
  writeJson({
    path: join(dbDir, 'node_modules', 'dotenv', 'package.json'),
    value: { version: '16.6.1' },
  });
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('vendorWorkspaceDb', () => {
  it('copies dist and package.json into node_modules/@trycompai/db', () => {
    vendorWorkspaceDb({ repoRoot, outputPath });
    const vendored = join(outputPath, 'node_modules', '@trycompai', 'db');
    expect(readFileSync(join(vendored, 'dist', 'index.js'), 'utf8')).toContain('resolveSslConfig');
    expect(existsSync(join(vendored, 'dist', 'framework-manifest', 'index.js'))).toBe(true);
    expect(existsSync(join(vendored, 'src'))).toBe(false);
    const pkg = JSON.parse(readFileSync(join(vendored, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('@trycompai/db');
    expect(pkg.version).toBe('2.3.0');
    expect(pkg.exports).toEqual({ '.': { default: './dist/index.js' } });
  });

  it('drops install scripts and dev dependencies from the vendored package.json', () => {
    vendorWorkspaceDb({ repoRoot, outputPath });
    const pkg = JSON.parse(
      readFileSync(join(outputPath, 'node_modules', '@trycompai', 'db', 'package.json'), 'utf8'),
    );
    expect(pkg.scripts).toBeUndefined();
    expect(pkg.devDependencies).toBeUndefined();
  });

  it("returns packages/db's runtime dependencies at their installed exact versions", () => {
    const { dependencies } = vendorWorkspaceDb({ repoRoot, outputPath });
    expect(dependencies).toEqual({ '@prisma/client': '7.6.0', zod: '4.4.3', dotenv: '16.6.1' });
  });

  it('replaces a stale tree or a dev symlink instead of writing through it', () => {
    const vendored = join(outputPath, 'node_modules', '@trycompai', 'db');
    mkdirSync(dirname(vendored), { recursive: true });
    symlinkSync(join(repoRoot, 'packages', 'db'), vendored, 'dir');
    vendorWorkspaceDb({ repoRoot, outputPath });
    expect(existsSync(join(vendored, 'src'))).toBe(false);
    expect(existsSync(join(repoRoot, 'packages', 'db', 'src', 'index.ts'))).toBe(true);
  });

  it('throws the named error when dist/index.js is missing', () => {
    rmSync(join(repoRoot, 'packages', 'db', 'dist'), { recursive: true, force: true });
    expect(() => vendorWorkspaceDb({ repoRoot, outputPath })).toThrow(
      /run bun run build in packages\/db/,
    );
    expect(existsSync(join(outputPath, 'node_modules', '@trycompai', 'db'))).toBe(false);
  });

  it('throws when a runtime dependency is not installed', () => {
    rmSync(join(repoRoot, 'node_modules', 'zod'), { recursive: true, force: true });
    expect(() => vendorWorkspaceDb({ repoRoot, outputPath })).toThrow(/zod/);
  });
});

describe('assertWorkspaceDbBuilt', () => {
  it('passes when dist/index.js exists', () => {
    expect(() => assertWorkspaceDbBuilt({ repoRoot })).not.toThrow();
  });

  it('throws the named error when dist/index.js is missing', () => {
    rmSync(join(repoRoot, 'packages', 'db', 'dist', 'index.js'));
    expect(() => assertWorkspaceDbBuilt({ repoRoot })).toThrow(/run bun run build in packages\/db/);
  });
});
