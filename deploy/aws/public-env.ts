import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { config } from './config.ts';

// NEXT_PUBLIC_* values are compiled into the app and portal bundles at image build time, so
// each image carries exactly one environment's values (images are not promotable).
// docker-bake.hcl passes these build args, and the Dockerfile sets them as ENV in the build
// and runtime stages (server code reads some of them from process.env at runtime).
// `bun public-env.ts check <bake --print json>` (run by tests/images.smoke.sh) proves the
// bake file and this module agree and that every NEXT_PUBLIC_ key the code reads is either
// passed or deliberately left unset; `bun public-env.ts env <target>` lists the NAME=VALUE
// lines the smoke expects in each runtime image.

export type ImageTarget = 'app' | 'portal';
export type PublicUrls = Readonly<{ api: string; app: string; portal: string }>;

const REPO_ROOT = join(import.meta.dir, '../..');
const TARGETS: readonly ImageTarget[] = ['app', 'portal'];
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const PUBLIC_NAME = /NEXT_PUBLIC_[A-Z0-9_]+/g;

export const DEFAULT_URLS: PublicUrls = Object.freeze({
  api: `https://${config.hosts.api}`,
  app: `https://${config.hosts.app}`,
  portal: `https://${config.hosts.portal}`,
});

/** Keys the code reads that stay unset in these images, with the reason. */
export const INTENTIONALLY_UNSET: Readonly<Record<string, string>> = Object.freeze({
  NEXT_PUBLIC_POSTHOG_KEY: 'no product analytics in the Revola install',
  NEXT_PUBLIC_POSTHOG_HOST: 'no product analytics in the Revola install',
  NEXT_PUBLIC_SENTRY_DSN: 'Sentry is not used; unset keeps the upstream DSN disabled',
  NEXT_PUBLIC_VERCEL_ENV: 'not on Vercel; unset keeps client Sentry reporting off',
  NEXT_PUBLIC_NOVU_APPLICATION_IDENTIFIER: 'no Novu in-app notifications',
  NEXT_PUBLIC_IS_DUB_ENABLED: 'no Dub referral program',
  NEXT_PUBLIC_ENTERPRISE_API_URL: 'the enterprise automation API is not deployed',
});

/** The NEXT_PUBLIC_* build args a target's image is built with. */
export function publicBuildArgs({
  target,
  urls,
}: {
  target: ImageTarget;
  urls: PublicUrls;
}): Record<string, string> {
  const shared = {
    NEXT_PUBLIC_API_URL: urls.api,
    NEXT_PUBLIC_APP_URL: urls.app,
    NEXT_PUBLIC_PORTAL_URL: urls.portal,
  };
  if (target === 'portal') {
    // The portal calls its own routes through NEXT_PUBLIC_BETTER_AUTH_URL.
    return { ...shared, NEXT_PUBLIC_BETTER_AUTH_URL: urls.portal };
  }
  return {
    ...shared,
    // Upstream's meaning for the app: its own public origin (email links fall back to it).
    NEXT_PUBLIC_BETTER_AUTH_URL: urls.app,
    // Self-hosted: organizations get access without Stripe.
    NEXT_PUBLIC_SELF_HOSTED: 'true',
    NEXT_PUBLIC_APP_ENV: 'production',
  };
}

/** `NAME=VALUE` lines a target's runtime image must carry in its environment, sorted. */
export function publicEnvLines({
  target,
  urls,
}: {
  target: ImageTarget;
  urls: PublicUrls;
}): string[] {
  return Object.entries(publicBuildArgs({ target, urls }))
    .map(([name, value]) => `${name}=${value}`)
    .sort();
}

export function findPublicEnvNames({ source }: { source: string }): string[] {
  return [...new Set(source.match(PUBLIC_NAME) ?? [])].sort();
}

/** NEXT_PUBLIC_ keys read by tracked code in the target app and in the workspace packages. */
export function scanReadNames({
  repoRoot,
  target,
}: {
  repoRoot: string;
  target: ImageTarget;
}): string[] {
  const listed = execFileSync('git', ['ls-files', '-z', '--', `apps/${target}`, 'packages'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const names = new Set<string>();
  for (const file of listed.split('\0')) {
    if (!CODE_FILE.test(file)) continue;
    const source = readFileSync(join(repoRoot, file), 'utf8');
    for (const name of findPublicEnvNames({ source })) names.add(name);
  }
  return [...names].sort();
}

export function checkPublicEnv({
  target,
  readNames,
  bakeArgs,
  urls,
}: {
  target: ImageTarget;
  readNames: readonly string[];
  bakeArgs: Readonly<Record<string, string>>;
  urls: PublicUrls;
}): string[] {
  const expected = publicBuildArgs({ target, urls });
  const passed = Object.fromEntries(
    Object.entries(bakeArgs).filter(([name]) => name.startsWith('NEXT_PUBLIC_')),
  );
  const problems: string[] = [];
  for (const name of readNames) {
    if (name in expected || name in INTENTIONALLY_UNSET) continue;
    problems.push(
      `${target}: ${name} is read in code but is neither a build arg nor in INTENTIONALLY_UNSET`,
    );
  }
  for (const [name, value] of Object.entries(expected)) {
    if (!(name in passed)) {
      problems.push(`${target}: the bake file does not pass ${name}`);
    } else if (passed[name] !== value) {
      problems.push(`${target}: the bake file passes ${name}=${passed[name]}, expected ${value}`);
    }
  }
  for (const name of Object.keys(passed)) {
    if (!(name in expected)) {
      problems.push(`${target}: the bake file passes ${name}, which public-env.ts does not declare`);
    }
  }
  return problems;
}

const bakePrintSchema = z.object({
  target: z.record(z.string(), z.object({ args: z.record(z.string(), z.string()).optional() })),
});

function runCheck({ bakeJsonPath }: { bakeJsonPath: string }): number {
  const printed = bakePrintSchema.parse(JSON.parse(readFileSync(bakeJsonPath, 'utf8')));
  const problems = TARGETS.flatMap((target) => {
    const bakeTarget = printed.target[target];
    if (!bakeTarget) return [`${target}: the bake file has no ${target} target`];
    return checkPublicEnv({
      target,
      readNames: scanReadNames({ repoRoot: REPO_ROOT, target }),
      bakeArgs: bakeTarget.args ?? {},
      urls: DEFAULT_URLS,
    });
  });
  for (const problem of problems) console.error(problem);
  return problems.length === 0 ? 0 : 1;
}

function isImageTarget(value: string | undefined): value is ImageTarget {
  return TARGETS.some((target) => target === value);
}

const USAGE = [
  'usage: bun public-env.ts check <docker buildx bake --print output.json>',
  '       bun public-env.ts env <app|portal>   (NAME=VALUE lines the runtime image must carry)',
].join('\n');

if (import.meta.main) {
  const [command, operand] = process.argv.slice(2);
  if (command === 'check' && operand) {
    process.exit(runCheck({ bakeJsonPath: operand }));
  }
  if (command === 'env' && isImageTarget(operand)) {
    console.log(publicEnvLines({ target: operand, urls: DEFAULT_URLS }).join('\n'));
    process.exit(0);
  }
  console.error(USAGE);
  process.exit(2);
}
