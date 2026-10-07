import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// PlatformAdminGuard takes credential attempts from the AuthFailureLimiter that
// AuthModule provides, so Nest can only build it in modules that import
// AuthModule; a module without it fails at boot. better-auth (ESM only) cannot
// load under this jest setup, so the wiring is checked in the source.
const SRC = resolve(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  path,
  source: readFileSync(path, 'utf8'),
}));

const guardedControllers = new Set(
  files
    .filter(({ source }) =>
      /@UseGuards\([^)]*\bPlatformAdminGuard\b/.test(source),
    )
    .flatMap(({ source }) =>
      [...source.matchAll(/export class (\w+Controller)\b/g)].map(
        (match) => match[1],
      ),
    ),
);

function listed({ source, key }: { source: string; key: string }): string[] {
  const list = source.match(new RegExp(`\\b${key}:\\s*\\[([^\\]]*)\\]`));
  return list ? list[1].split(',').map((name) => name.trim()) : [];
}

describe('modules hosting PlatformAdminGuard', () => {
  const hosts = files
    .filter(({ path }) => path.endsWith('.module.ts'))
    .map(({ path, source }) => ({
      module: path.slice(SRC.length + 1),
      controllers: listed({ source, key: 'controllers' }).filter((name) =>
        guardedControllers.has(name),
      ),
      importsAuth: listed({ source, key: 'imports' }).includes('AuthModule'),
    }))
    .filter(({ controllers }) => controllers.length > 0);

  it('finds the admin and framework-editor modules', () => {
    expect(hosts.map(({ module }) => module)).toEqual(
      expect.arrayContaining([
        'admin-organizations/admin-organizations.module.ts',
        'admin-feature-flags/admin-feature-flags.module.ts',
        'framework-editor-versions/framework-versions.module.ts',
        'finding-template/finding-template.module.ts',
      ]),
    );
  });

  it('import AuthModule, which provides the shared AuthFailureLimiter', () => {
    expect(
      hosts
        .filter(({ importsAuth }) => !importsAuth)
        .map(({ module }) => module),
    ).toEqual([]);
  });
});
