import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, type DeployConfig } from './config.ts';

// Shell scripts `source` the generated file. Values are limited to characters a shell never
// needs to quote, so nothing here can be mangled or injected.
const SAFE_VALUE = /^[A-Za-z0-9._,:/-]+$/;

export const CONFIG_ENV_PATH = join(import.meta.dir, 'config.env');

function entries({ config }: { config: DeployConfig }): [string, string][] {
  return [
    ['COMP_ACCOUNT_ID', config.accountId],
    ['COMP_REGION', config.region],
    ['COMP_CLUSTER_NAME', config.clusterName],
    ['COMP_ALB_NAME', config.albName],
    ['COMP_ALB_DNS_NAME', config.albDnsName],
    ['COMP_ALB_SG_ID', config.albSecurityGroupId],
    ['COMP_VPC_ID', config.vpcId],
    ['COMP_SUBNET_IDS', config.subnetIds.join(',')],
    ['COMP_HOST_API', config.hosts.api],
    ['COMP_HOST_APP', config.hosts.app],
    ['COMP_HOST_PORTAL', config.hosts.portal],
    ['COMP_COOKIE_DOMAIN', config.cookieDomain],
    ['COMP_PROD_DB_REF', config.productionDbRef],
    ['COMP_PROD_POOLER_HOST', config.productionPoolerHost],
    ['COMP_TRIGGER_CLI_VERSION', config.triggerCliVersion],
    ['COMP_RELEASE_BUCKET', config.releaseBucket],
    ['COMP_LOCK_TABLE', config.lockTable],
    ['COMP_TERRAFORM_STATE_BUCKET', config.terraformStateBucket],
  ];
}

export function renderConfigEnv({ config }: { config: DeployConfig }): string {
  return entries({ config })
    .map(([key, value]) => {
      if (!SAFE_VALUE.test(value)) throw new Error(`${key} has a value that is not shell-safe`);
      return `${key}=${value}\n`;
    })
    .join('');
}

export function writeConfigEnv({ path, config }: { path: string; config: DeployConfig }): void {
  writeFileSync(path, renderConfigEnv({ config }));
}

if (import.meta.main) {
  writeConfigEnv({ path: CONFIG_ENV_PATH, config });
  console.log(`wrote ${CONFIG_ENV_PATH}`);
}
