import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrganizationApiKeysController } from './organization-api-keys.controller';
import { OrganizationController } from './organization.controller';
import { OrganizationService } from './organization.service';

@Module({
  imports: [AuthModule],
  controllers: [OrganizationController, OrganizationApiKeysController],
  providers: [OrganizationService],
  exports: [OrganizationService],
})
export class OrganizationModule {}
