export type BuildUrlName = 'PORTAL_URL' | 'API_URL' | 'AUTO_UPDATE_URL';
export type BuildEnv = Record<string, string | undefined>;
export function requiredBuildUrl(params: { name: BuildUrlName; env: BuildEnv }): string;
export function requiredBuildUrls(env: BuildEnv): Record<BuildUrlName, string>;
export const BUILD_URL_NAMES: readonly BuildUrlName[];
export function deviceAgentUrls(params: {
  command: 'build' | 'serve';
  env: BuildEnv;
}): Record<BuildUrlName, string>;
