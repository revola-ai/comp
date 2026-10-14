import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { auth } from './auth.server';
import { readGramMcpClient } from './gram-mcp-client';
import { syncGramOAuthApplication } from './gram-mcp-client-sync';
import { isProductionDeployment } from './production-deployment';

const SKIPPED =
  'Skipped the Gram MCP OAuth client sync: only the production deployment (NODE_ENV=production, SELF_HOSTED=true, AUTH_COOKIE_DOMAIN set) writes its row';

/** The error's name and code only: never its message, which could echo data. */
function describeFailure(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'unknown error';
  const name = Reflect.get(error, 'name');
  const code = Reflect.get(error, 'code');
  return [name, code].filter((part) => typeof part === 'string').join(' ');
}

/**
 * Writes the Gram MCP OAuth client's row at boot (syncGramOAuthApplication).
 * A failure (the database unreachable at boot, say) is logged, by error name
 * and code only, and does not stop the API: the row a previous boot wrote
 * keeps serving, and the next boot retries. Only the production deployment
 * writes it (production-deployment.ts): laptops share the production database
 * (D7), and a laptop's GRAM_OAUTH_* would otherwise overwrite production's row.
 */
@Injectable()
export class GramMcpClientSync implements OnApplicationBootstrap {
  private readonly logger = new Logger(GramMcpClientSync.name);

  async onApplicationBootstrap(): Promise<void> {
    // Without the Gram client the MCP endpoints do not exist: nothing to write.
    if (!readGramMcpClient({ env: process.env })) return;
    if (!isProductionDeployment({ env: process.env })) {
      this.logger.log(SKIPPED);
      return;
    }
    try {
      const { adapter } = await auth.$context;
      await syncGramOAuthApplication({
        env: process.env,
        adapter,
        log: (message) => this.logger.log(message),
      });
    } catch (error) {
      this.logger.error(
        `Could not register the Gram MCP OAuth client: ${describeFailure(error)}`,
      );
    }
  }
}
