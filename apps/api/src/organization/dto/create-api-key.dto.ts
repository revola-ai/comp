import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export const API_KEY_EXPIRIES = ['never', '30days', '90days', '1year'] as const;

export class CreateApiKeyDto {
  @ApiProperty({
    description: 'Human-readable name shown in the API key list and audit log',
    example: 'CI Pipeline',
    maxLength: 255,
  })
  @IsString()
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional({
    description: 'When the key expires. Defaults to never.',
    enum: API_KEY_EXPIRIES,
    example: '90days',
  })
  @IsOptional()
  @IsIn(API_KEY_EXPIRIES)
  expiresAt?: (typeof API_KEY_EXPIRIES)[number];

  @ApiPropertyOptional({
    description:
      'resource:action scopes from GET /v1/organization/api-keys/available-scopes. At least one is required, and only scopes the caller holds can be granted.',
    type: 'array',
    items: { type: 'string' },
    example: ['risk:read', 'vendor:read'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  scopes?: string[];

  @ApiPropertyOptional({
    description:
      'Create an organization-owned key that keeps working when its creator leaves. Owners only. Default false: a personal key, revoked when its creator is removed, deactivated or banned, and limited at every use to the scopes the current roles of its creator grant.',
    default: false,
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  organizationOwned?: boolean;
}

export class RevokeApiKeyDto {
  @ApiProperty({
    description: 'ID of the API key to revoke',
    example: 'apk_abc123',
  })
  @IsString()
  id!: string;
}
