import { z } from 'zod';

type Env = Partial<NodeJS.ProcessEnv>;

/** The one OAuth client allowed to use the MCP endpoints: Speakeasy Gram. */
export interface GramMcpClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

const present = z.string().trim().min(1);
const gramEnvSchema = z.object({
  GRAM_OAUTH_CLIENT_ID: present,
  GRAM_OAUTH_CLIENT_SECRET: present,
  GRAM_OAUTH_REDIRECT_URI: present,
});

/**
 * The Gram client from GRAM_OAUTH_CLIENT_ID, GRAM_OAUTH_CLIENT_SECRET and
 * GRAM_OAUTH_REDIRECT_URI, or null unless all three are set.
 */
export function readGramMcpClient({ env }: { env: Env }): GramMcpClient | null {
  const parsed = gramEnvSchema.safeParse(env);
  if (!parsed.success) return null;
  return {
    clientId: parsed.data.GRAM_OAUTH_CLIENT_ID,
    clientSecret: parsed.data.GRAM_OAUTH_CLIENT_SECRET,
    redirectUri: parsed.data.GRAM_OAUTH_REDIRECT_URI,
  };
}
