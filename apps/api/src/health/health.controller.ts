import {
  Controller,
  Get,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { checkApiReadiness } from './readiness';

@ApiTags('Health')
@Public()
@Controller({ path: 'health', version: '1' })
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  @Get()
  @ApiOperation({
    summary: 'Health check',
    description:
      'Liveness: answers while the process serves requests; never touches the database.',
  })
  @ApiResponse({
    status: 200,
    description: 'API is healthy',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              example: 'ok',
            },
            timestamp: {
              type: 'string',
              format: 'date-time',
            },
            uptime: {
              type: 'number',
              description: 'Process uptime in seconds',
            },
            version: {
              type: 'string',
              example: '1.0.0',
            },
          },
        },
      },
    },
  })
  getHealth() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: '1.0.0',
    };
  }

  @Get('ready')
  @ApiOperation({
    summary: 'Readiness check',
    description:
      'Runs SELECT 1 against the database with a 2-second timeout. Answers 503 with a reason (tls_<CODE>, a Prisma code, timeout or unknown) and no connection details.',
  })
  @ApiResponse({
    status: 200,
    description: 'The database answered',
    schema: { example: { status: 'ok' } },
  })
  @ApiResponse({
    status: 503,
    description: 'The database did not answer',
    schema: {
      example: {
        status: 'unavailable',
        reason: 'tls_SELF_SIGNED_CERT_IN_CHAIN',
      },
    },
  })
  async getReadiness(): Promise<{ status: 'ok' }> {
    const result = await checkApiReadiness();
    if (result.status === 'ok') return result;
    this.logger.warn(`Database not ready: ${result.reason}`);
    throw new ServiceUnavailableException(result);
  }
}
