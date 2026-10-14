import type { DBAdapter } from 'better-auth';
import { type GramMcpClient, readGramMcpClient } from './gram-mcp-client';

type Env = Partial<NodeJS.ProcessEnv>;
type ApplicationStore = Pick<DBAdapter, 'findOne' | 'create' | 'update'>;
export type GramSyncOutcome =
  'created' | 'updated' | 'unchanged' | 'not-configured';

/** better-auth's model for OAuth clients (the OauthApplication table). */
const MODEL = 'oauthApplication';
export const GRAM_CLIENT_NAME = 'Comp AI MCP (Gram)';

/** The columns of the Gram row that GRAM_OAUTH_* determines. */
interface GramApplicationFields {
  name: string;
  clientId: string;
  clientSecret: string;
  redirectUrls: string;
  type: string;
  disabled: boolean;
}

/**
 * The row as better-auth's mcp plugin reads it: /mcp/authorize and /mcp/token
 * split `redirectUrls` on commas, and a "web" (confidential) client's secret
 * is compared as stored with the one presented, so it is kept as is.
 */
function gramApplication(client: GramMcpClient): GramApplicationFields {
  return {
    name: GRAM_CLIENT_NAME,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    redirectUrls: client.redirectUri,
    type: 'web',
    disabled: false,
  };
}

function differs({
  stored,
  wanted,
}: {
  stored: Partial<GramApplicationFields>;
  wanted: GramApplicationFields;
}): boolean {
  return (Object.keys(wanted) as (keyof GramApplicationFields)[]).some(
    (field) => stored[field] !== wanted[field],
  );
}

/**
 * Writes the Gram client's oauthApplication row from GRAM_OAUTH_*, through
 * better-auth's own adapter. better-auth's mcp plugin ignores oidcConfig's
 * trustedClients and looks clients up only in that table, and /mcp/register
 * is refused (gram-mcp-oauth.ts), so this row is the only way Gram's
 * authorization and token requests succeed. Run at API boot: it creates the
 * row, or brings the name, secret, redirect URL, type and enabled flag of an
 * existing one back to the environment's values. Never logs the secret.
 */
export async function syncGramOAuthApplication({
  env,
  adapter,
  log,
}: {
  env: Env;
  adapter: ApplicationStore;
  log: (message: string) => void;
}): Promise<GramSyncOutcome> {
  const client = readGramMcpClient({ env });
  if (!client) return 'not-configured';
  const wanted = gramApplication(client);
  const where = [{ field: 'clientId', value: client.clientId }];
  const stored = await adapter.findOne<Partial<GramApplicationFields>>({
    model: MODEL,
    where,
  });
  const now = new Date();
  if (!stored) {
    await adapter.create({
      model: MODEL,
      data: { ...wanted, metadata: null, createdAt: now, updatedAt: now },
    });
    log(`Registered the Gram MCP OAuth client ${client.clientId}`);
    return 'created';
  }
  if (!differs({ stored, wanted })) return 'unchanged';
  await adapter.update({
    model: MODEL,
    where,
    update: { ...wanted, updatedAt: now },
  });
  log(`Updated the Gram MCP OAuth client ${client.clientId} from GRAM_OAUTH_*`);
  return 'updated';
}
