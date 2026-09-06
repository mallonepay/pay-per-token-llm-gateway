import { Module } from '@nestjs/common';
import { X402Service } from './x402.service';
import { X402Controller } from './x402.controller';
import { EscrowController } from './escrow.controller';
import { RoutesModule } from '../routes/routes.module';
import { PaymentsModule } from '../payments/payments.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard';

@Module({
  imports: [RoutesModule, PaymentsModule, AnalyticsModule],
  controllers: [X402Controller, EscrowController],
  providers: [X402Service, RateLimitGuard],
  exports: [X402Service],
})
export class X402Module {}
