import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import {
  FrameworkVersionsController,
  FrameworkDraftDiffController,
} from './framework-versions.controller';
import { FrameworkVersionsService } from './framework-versions.service';

@Module({
  imports: [AuthModule],
  controllers: [FrameworkVersionsController, FrameworkDraftDiffController],
  providers: [FrameworkVersionsService],
  exports: [FrameworkVersionsService],
})
export class FrameworkVersionsModule {}
