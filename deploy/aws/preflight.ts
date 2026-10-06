import { z } from 'zod';
import { config } from './config.ts';

// Read-only checks that run before any release or Terraform step. Nothing here mutates anything:
// the only AWS calls are sts get-caller-identity, configure get and ec2 describe-route-tables.

export const NEEDS = ['aws', 'cloudflare', 'trigger', 'docker'] as const;
export type Need = (typeof NEEDS)[number];

export class PreflightError extends Error {
  readonly failures: readonly string[];

  constructor({ failures }: { failures: readonly string[] }) {
    super(failures.join('\n'));
    this.name = 'PreflightError';
    this.failures = failures;
  }
}

type RunResult = { code: number; stdout: string };

async function run({ cmd }: { cmd: string[] }): Promise<RunResult> {
  try {
    const proc = Bun.spawn({
      cmd,
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { code, stdout: stdout.trim() };
  } catch {
    return { code: 127, stdout: '' };
  }
}

function hasTool({ tool }: { tool: string }): boolean {
  return Bun.which(tool, { PATH: process.env.PATH ?? '' }) !== null;
}

function requiredTools({ needs }: { needs: readonly Need[] }): string[] {
  const tools = ['git', 'bun', 'curl'];
  if (needs.includes('aws')) tools.push('aws');
  if (needs.includes('docker')) tools.push('docker');
  return tools;
}

async function checkAccount(): Promise<string | undefined> {
  const result = await run({
    cmd: ['aws', 'sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'],
  });
  if (result.code !== 0) {
    return (
      'aws sts get-caller-identity failed; run aws sso login or set AWS_PROFILE=<profile for account ' +
      `${config.accountId}>`
    );
  }
  if (result.stdout === config.accountId) return undefined;
  return `wrong AWS account ${result.stdout}, expected ${config.accountId}; set AWS_PROFILE=<profile for account ${config.accountId}>`;
}

async function checkRegion(): Promise<string | undefined> {
  const fromEnv = process.env.AWS_REGION?.trim();
  const region =
    fromEnv || (await run({ cmd: ['aws', 'configure', 'get', 'region'] })).stdout || '<unset>';
  if (region === config.region) return undefined;
  return `wrong AWS region ${region}, expected ${config.region}; set AWS_REGION=${config.region}`;
}

const routeTablesSchema = z.object({
  RouteTables: z.array(
    z.object({
      Routes: z.array(
        z.object({
          DestinationCidrBlock: z.string().optional(),
          NatGatewayId: z.string().optional(),
          State: z.string().optional(),
        }),
      ),
    }),
  ),
});

async function describeRouteTables({ filters }: { filters: string[] }) {
  const result = await run({
    cmd: [
      'aws',
      'ec2',
      'describe-route-tables',
      '--region',
      config.region,
      '--filters',
      ...filters,
      '--output',
      'json',
    ],
  });
  if (result.code !== 0) return undefined;
  try {
    return routeTablesSchema.parse(JSON.parse(result.stdout)).RouteTables;
  } catch {
    return undefined;
  }
}

async function checkSubnetNat({ subnetId }: { subnetId: string }): Promise<string | undefined> {
  // A subnet with no explicit association uses its VPC's main route table.
  let tables = await describeRouteTables({
    filters: [`Name=association.subnet-id,Values=${subnetId}`],
  });
  if (tables?.length === 0) {
    tables = await describeRouteTables({
      filters: ['Name=association.main,Values=true', `Name=vpc-id,Values=${config.vpcId}`],
    });
  }
  if (tables === undefined)
    return `could not read the route table for subnet ${subnetId} (aws ec2 describe-route-tables failed)`;
  const hasNat = tables.some((table) =>
    table.Routes.some(
      (route) =>
        route.DestinationCidrBlock === '0.0.0.0/0' &&
        route.NatGatewayId &&
        route.State === 'active',
    ),
  );
  if (hasNat) return undefined;
  return `subnet ${subnetId} has no active NAT route (0.0.0.0/0 via a NAT gateway); tasks with assignPublicIp DISABLED could not pull images`;
}

async function checkTriggerLogin(): Promise<string | undefined> {
  const version = config.triggerCliVersion;
  const result = await run({ cmd: ['bun', 'x', `trigger.dev@${version}`, 'whoami'] });
  if (result.code === 0) return undefined;
  return `Trigger.dev is not logged in; run: bunx trigger.dev@${version} login`;
}

async function checkDocker(): Promise<string | undefined> {
  const result = await run({ cmd: ['docker', 'buildx', 'version'] });
  return result.code === 0
    ? undefined
    : 'docker buildx is unavailable; install Docker with the buildx plugin';
}

export async function runPreflight({ needs }: { needs: readonly Need[] }): Promise<void> {
  const failures: string[] = [];
  const add = (failure: string | undefined) => {
    if (failure) failures.push(failure);
  };

  const missing = requiredTools({ needs }).filter((tool) => !hasTool({ tool }));
  for (const tool of missing) failures.push(`missing tool: ${tool}; install it and put it on PATH`);

  if (needs.includes('cloudflare') && !process.env.CLOUDFLARE_API_TOKEN) {
    failures.push('CLOUDFLARE_API_TOKEN is not set; export a token scoped to the revola.ai zone');
  }

  if (needs.includes('aws') && !missing.includes('aws')) {
    const [account, region] = await Promise.all([checkAccount(), checkRegion()]);
    add(account);
    add(region);
    // Never describe network resources in an account or region that is not the expected one.
    if (!account && !region) {
      const subnetFailures = await Promise.all(
        config.subnetIds.map((subnetId) => checkSubnetNat({ subnetId })),
      );
      subnetFailures.forEach(add);
    }
  }

  if (needs.includes('trigger') && !missing.includes('bun')) add(await checkTriggerLogin());
  if (needs.includes('docker') && !missing.includes('docker')) add(await checkDocker());

  if (failures.length > 0) throw new PreflightError({ failures });
}

function parseNeeds({ argv }: { argv: string[] }): Need[] {
  const index = argv.indexOf('--needs');
  const raw = index === -1 ? '' : (argv[index + 1] ?? '');
  const names = raw.split(',').filter((name) => name.length > 0);
  const unknown = names.filter((name) => !(NEEDS as readonly string[]).includes(name));
  if (unknown.length > 0) {
    throw new Error(`unknown --needs value ${unknown.join(', ')}; allowed: ${NEEDS.join(', ')}`);
  }
  return names as Need[];
}

if (import.meta.main) {
  try {
    await runPreflight({ needs: parseNeeds({ argv: process.argv.slice(2) }) });
    console.log('preflight ok');
  } catch (error) {
    if (error instanceof PreflightError) {
      for (const failure of error.failures) console.error(`preflight: ${failure}`);
    } else {
      console.error(`preflight: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(1);
  }
}
