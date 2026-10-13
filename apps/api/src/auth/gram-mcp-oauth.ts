import { APIError, createAuthMiddleware } from 'better-auth/api';
import { mcp } from 'better-auth/plugins';
import { type GramMcpClient, readGramMcpClient } from './gram-mcp-client';

type Env = Partial<NodeJS.ProcessEnv>;

/**
 * Keeps the MCP authorization server to the Gram client alone. better-auth's
 * mcp() serves /mcp/register to anonymous callers whatever
 * allowDynamicClientRegistration says, and /mcp/authorize skips consent unless
 * prompt=consent, so a self-registered client with its own redirect_uri could
 * collect a signed-in member's token in one click. Registration is refused
 * for every caller, and an authorization request naming any other client_id
 * is refused before a code is issued. Gram's own client is the
 * oauthApplication row the API writes from GRAM_OAUTH_* at boot
 * (gram-mcp-client-sync.ts): /mcp/authorize and /mcp/token read clients only
 * from that table, never from oidcConfig.trustedClients. The hooks match the
 * endpoint path, not the request URL, so no spelling of the URL gets around
 * them.
 */
function gramClientGate({ clientId }: { clientId: string }) {
  return {
    id: 'gram-mcp-client-gate',
    hooks: {
      before: [
        {
          matcher: (context: { path?: string }) =>
            context.path === '/mcp/register',
          handler: createAuthMiddleware(() =>
            Promise.reject(new APIError('NOT_FOUND')),
          ),
        },
        {
          matcher: (context: { path?: string }) =>
            context.path === '/mcp/authorize',
          handler: createAuthMiddleware((context) => {
            if (context.query?.client_id === clientId) {
              return Promise.resolve();
            }
            return Promise.reject(
              new APIError('BAD_REQUEST', {
                error: 'invalid_client',
                error_description: 'Unknown client_id',
              }),
            );
          }),
        },
      ],
    },
  };
}

function buildGramPlugins({
  client,
  loginPage,
  resource,
}: {
  client: GramMcpClient;
  loginPage: string;
  resource: string | undefined;
}) {
  // better-auth spreads the mcp() options' `metadata` over its discovery
  // document (/.well-known/oauth-authorization-server, better-auth 1.6.23
  // plugins/mcp/index.mjs), though MCPOptions does not declare it: an
  // undefined registration_endpoint leaves the refused /mcp/register out of
  // the JSON.
  const options = {
    loginPage,
    ...(resource ? { resource } : {}),
    oidcConfig: { loginPage, allowDynamicClientRegistration: false },
    metadata: { registration_endpoint: undefined },
  };
  return [
    // OAuth 2.0 / OIDC provider for hosted MCP (Gram): /api/auth/mcp/*
    // (authorize, token, get-session), the two /api/auth/.well-known/*
    // discovery documents and auth.api.getMcpSession() for HybridAuthGuard.
    // Gram signs users in without a consent screen (consent is asked only for
    // prompt=consent): Gram is Comp AI's own hosted MCP.
    mcp(options),
    gramClientGate({ clientId: client.clientId }),
  ];
}

/**
 * The better-auth plugins for hosted MCP: none unless the Gram client is
 * configured, so the MCP OAuth endpoints do not exist at all without it.
 * MCP_RESOURCE_URL sets the protected-resource identifier.
 */
export function gramMcpPlugins({
  env,
  loginPage,
}: {
  env: Env;
  loginPage: string;
}): ReturnType<typeof buildGramPlugins> {
  const client = readGramMcpClient({ env });
  if (!client) return [];
  return buildGramPlugins({
    client,
    loginPage,
    resource: env.MCP_RESOURCE_URL?.trim() || undefined,
  });
}
