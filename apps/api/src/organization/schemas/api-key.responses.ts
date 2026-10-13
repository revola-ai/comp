import type { ApiResponseOptions } from '@nestjs/swagger';

export const CREATE_API_KEY_RESPONSES: Record<
  201 | 400 | 401 | 403,
  ApiResponseOptions
> = {
  201: {
    description:
      'API key created. The plaintext key is returned once and cannot be retrieved again.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', example: 'apk_abc123' },
        name: { type: 'string', example: 'CI Pipeline' },
        key: { type: 'string', example: 'comp_0123abcd...' },
        createdAt: { type: 'string', format: 'date-time' },
        expiresAt: { type: 'string', format: 'date-time', nullable: true },
      },
    },
  },
  400: {
    description:
      'Invalid body: missing name, no scopes, unknown scopes, or an unknown expiry',
  },
  401: { description: 'Missing or invalid credentials' },
  403: {
    description:
      'Missing apiKey:create; a requested scope the caller does not hold; organizationOwned requested by a caller that is not a signed-in owner; or the creator is not an active member (including a creatorless legacy API key)',
  },
};

export const REVOKE_API_KEY_RESPONSES: Record<
  201 | 400 | 401 | 403 | 404,
  ApiResponseOptions
> = {
  201: {
    description: 'API key revoked',
    schema: {
      type: 'object',
      properties: { success: { type: 'boolean', example: true } },
    },
  },
  400: { description: 'Missing API key id' },
  401: { description: 'Missing or invalid credentials' },
  403: { description: 'Missing apiKey:delete' },
  404: { description: 'No such API key in this organization' },
};
