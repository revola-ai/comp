import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import productionTargetFile from '../../packages/db/production-target.json' with { type: 'json' };
import { productionTargetSchema } from '../../packages/db/scripts/production-target.ts';

// Single source of the fixed AWS, host and release identifiers. Shell scripts get the same
// values through config.env (see write-config-env.ts), so nothing is typed twice.

const REPO_ROOT = join(import.meta.dir, '../..');
const TRIGGER_MANIFESTS = ['apps/api/package.json', 'apps/app/package.json'] as const;

const configSchema = z
  .object({
    accountId: z.string().regex(/^\d{12}$/),
    region: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/),
    clusterName: z.string().min(1),
    albName: z.string().min(1),
    albDnsName: z.string().endsWith('.elb.amazonaws.com'),
    albSecurityGroupId: z.string().regex(/^sg-[0-9a-f]{17}$/),
    vpcId: z.string().regex(/^vpc-[0-9a-f]{17}$/),
    subnetIds: z.array(z.string().regex(/^subnet-[0-9a-f]{17}$/)).min(1),
    hosts: z.object({ api: z.string(), app: z.string(), portal: z.string() }).strict(),
    cookieDomain: z.string().regex(/^\.[a-z0-9.-]+$/, 'cookieDomain needs a leading dot'),
    // The project ref only as its SHA-256 (public fork); later tasks compare hashes.
    productionDbRefSha256: productionTargetSchema.shape.projectRefSha256,
    productionPoolerHost: productionTargetSchema.shape.poolerHost,
    triggerCliVersion: z.string().regex(/^\d+\.\d+\.\d+$/, 'must be an exact pinned version'),
    releaseBucket: z.string().min(3),
    lockTable: z.string().min(3),
    terraformStateBucket: z.string().min(3),
  })
  .strict()
  .refine(
    ({ hosts, cookieDomain }) => Object.values(hosts).every((host) => host.endsWith(cookieDomain)),
    { message: 'cookieDomain must cover the api, app and portal hosts' },
  );

export type DeployConfig = Readonly<
  Omit<z.infer<typeof configSchema>, 'subnetIds' | 'hosts'> & {
    subnetIds: readonly string[];
    hosts: Readonly<z.infer<typeof configSchema>['hosts']>;
  }
>;

const manifestSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});

function isTriggerPackage(name: string): boolean {
  return name === 'trigger.dev' || name.startsWith('@trigger.dev/');
}

function readTriggerVersions({
  repoRoot,
  manifest,
}: {
  repoRoot: string;
  manifest: string;
}): string[] {
  const parsed = manifestSchema.parse(JSON.parse(readFileSync(join(repoRoot, manifest), 'utf8')));
  const entries = { ...parsed.dependencies, ...parsed.devDependencies };
  const versions = Object.entries(entries)
    .filter(([name]) => isTriggerPackage(name))
    .map(([, version]) => version);
  if (versions.length === 0) {
    throw new Error(`${manifest} declares no trigger.dev or @trigger.dev/* dependency`);
  }
  return [...new Set(versions)];
}

function readTriggerCliVersion({ repoRoot }: { repoRoot: string }): string {
  const perFile = TRIGGER_MANIFESTS.map((manifest) => ({
    manifest,
    versions: readTriggerVersions({ repoRoot, manifest }),
  }));
  for (const { manifest, versions } of perFile) {
    if (versions.length > 1) {
      throw new Error(
        `${manifest} pins several Trigger.dev versions: ${versions.join(', ')}; they must all match`,
      );
    }
  }
  const [first, second] = perFile as [(typeof perFile)[number], (typeof perFile)[number]];
  const [firstVersion, secondVersion] = [first.versions[0], second.versions[0]];
  if (firstVersion !== secondVersion) {
    throw new Error(
      `Trigger.dev version mismatch: ${first.manifest} has ${firstVersion}, ${second.manifest} has ${secondVersion}`,
    );
  }
  return firstVersion as string;
}

export function loadConfig({
  repoRoot,
  productionTarget,
}: {
  repoRoot: string;
  productionTarget: unknown;
}): DeployConfig {
  const target = productionTargetSchema.parse(productionTarget);
  const parsed = configSchema.parse({
    accountId: '455986776194',
    region: 'us-east-2',
    clusterName: 'revola-cluster',
    albName: 'revola-production-alb',
    albDnsName: 'revola-production-alb-1399285125.us-east-2.elb.amazonaws.com',
    albSecurityGroupId: 'sg-0eb10c6d5c5fd239b',
    vpcId: 'vpc-06b67bec700b38a10',
    subnetIds: ['subnet-08095a4ada58a9eef', 'subnet-0284c89a912e76d71', 'subnet-0d4308baa95e7f157'],
    hosts: {
      api: 'api.comp.revola.ai',
      app: 'app.comp.revola.ai',
      portal: 'portal.comp.revola.ai',
    },
    cookieDomain: '.comp.revola.ai',
    productionDbRefSha256: target.projectRefSha256,
    productionPoolerHost: target.poolerHost,
    triggerCliVersion: readTriggerCliVersion({ repoRoot }),
    releaseBucket: 'comp-release-records-455986776194',
    lockTable: 'comp-release-lock',
    terraformStateBucket: 'comp-terraform-state-455986776194',
  });
  return Object.freeze({
    ...parsed,
    subnetIds: Object.freeze([...parsed.subnetIds]),
    hosts: Object.freeze({ ...parsed.hosts }),
  });
}

export const config: DeployConfig = loadConfig({
  repoRoot: REPO_ROOT,
  productionTarget: productionTargetFile,
});
