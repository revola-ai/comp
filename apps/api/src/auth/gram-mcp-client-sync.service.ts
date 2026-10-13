import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { auth } from './auth.server';
import { syncGramOAuthApplication } from './gram-mcp-client-sync';

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
 * keeps serving, and the next boot retries.
 */
@Injectable()
export class GramMcpClientSync implements OnApplicationBootstrap {
  private readonly logger = new Logger(GramMcpClientSync.name);

  async onApplicationBootstrap(): Promise<void> {
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
