import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { AuthContext, OrganizationId } from '../auth/auth-context.decorator';
import {
  resolveKeyProvenance,
  resolveOrganizationOwnedProvenance,
} from '../auth/api-key-provenance';
import { assertScopesGrantable } from '../auth/api-key-scope-grant';
import { ApiKeyService } from '../auth/api-key.service';
import { HybridAuthGuard } from '../auth/hybrid-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/require-permission.decorator';
import type { AuthContext as AuthContextType } from '../auth/types';
import { CreateApiKeyDto, RevokeApiKeyDto } from './dto/create-api-key.dto';
import { OrganizationService } from './organization.service';
import {
  CREATE_API_KEY_RESPONSES,
  REVOKE_API_KEY_RESPONSES,
} from './schemas/api-key.responses';

/**
 * /v1/organization/api-keys. Split out of OrganizationController; the
 * operationIds stay `OrganizationController_*` so the public OpenAPI spec,
 * its docs metadata and the generated SDK / MCP tool names do not change.
 */
@ApiTags('Organization')
@Controller({ path: 'organization', version: '1' })
@UseGuards(HybridAuthGuard, PermissionGuard)
@ApiSecurity('apikey')
export class OrganizationApiKeysController {
  constructor(
    private readonly organizationService: OrganizationService,
    private readonly apiKeyService: ApiKeyService,
  ) {}

  @Get('api-keys')
  @RequirePermission('apiKey', 'read')
  @ApiOperation({
    summary: 'List active API keys',
    operationId: 'OrganizationController_listApiKeys_v1',
  })
  async listApiKeys(@OrganizationId() organizationId: string) {
    return this.organizationService.listApiKeys(organizationId);
  }

  @Get('api-keys/available-scopes')
  @RequirePermission('apiKey', 'read')
  @ApiOperation({
    summary: 'Get available API key scopes',
    operationId: 'OrganizationController_getAvailableScopes_v1',
  })
  getAvailableScopes() {
    return { data: this.apiKeyService.getAvailableScopes() };
  }

  @Post('api-keys')
  @RequirePermission('apiKey', 'create')
  @ApiOperation({
    summary: 'Create a new API key',
    operationId: 'OrganizationController_createApiKey_v1',
  })
  @ApiBody({ type: CreateApiKeyDto })
  @ApiResponse({ status: 201, ...CREATE_API_KEY_RESPONSES[201] })
  @ApiResponse({ status: 400, ...CREATE_API_KEY_RESPONSES[400] })
  @ApiResponse({ status: 401, ...CREATE_API_KEY_RESPONSES[401] })
  @ApiResponse({ status: 403, ...CREATE_API_KEY_RESPONSES[403] })
  async createApiKey(
    @OrganizationId() organizationId: string,
    @AuthContext() authContext: AuthContextType,
    @Body() body: CreateApiKeyDto,
  ) {
    if (!body.name) {
      throw new BadRequestException('Name is required');
    }
    // Personal by default: the creating member, or the authenticating key's
    // creator for a key minted through an API key. Organization-owned only
    // for a signed-in owner (or through an organization-owned key).
    const provenance = body.organizationOwned
      ? resolveOrganizationOwnedProvenance(authContext)
      : resolveKeyProvenance(authContext);
    await assertScopesGrantable({
      caller: authContext,
      requestedScopes: body.scopes ?? [],
      availableScopes: this.apiKeyService.getAvailableScopes(),
    });
    return this.apiKeyService.create({
      organizationId,
      name: body.name,
      expiresAt: body.expiresAt,
      scopes: body.scopes,
      provenance,
    });
  }

  @Post('api-keys/revoke')
  @RequirePermission('apiKey', 'delete')
  @ApiOperation({
    summary: 'Revoke an API key',
    operationId: 'OrganizationController_revokeApiKey_v1',
  })
  @ApiBody({ type: RevokeApiKeyDto })
  @ApiResponse({ status: 201, ...REVOKE_API_KEY_RESPONSES[201] })
  @ApiResponse({ status: 400, ...REVOKE_API_KEY_RESPONSES[400] })
  @ApiResponse({ status: 401, ...REVOKE_API_KEY_RESPONSES[401] })
  @ApiResponse({ status: 403, ...REVOKE_API_KEY_RESPONSES[403] })
  @ApiResponse({ status: 404, ...REVOKE_API_KEY_RESPONSES[404] })
  async revokeApiKey(
    @OrganizationId() organizationId: string,
    @Body() body: RevokeApiKeyDto,
  ) {
    if (!body.id) {
      throw new BadRequestException('API key ID is required');
    }
    return this.apiKeyService.revoke(body.id, organizationId);
  }
}
