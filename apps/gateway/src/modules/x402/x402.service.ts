import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ContractClient } from './contract-client';

@Injectable()
export class X402Service {
  private readonly logger = new Logger(X402Service.name);

  constructor(
    private configService: ConfigService,
    private contractClient: ContractClient,
  ) {}

  async applyMeteredPricing(user: string, quoteId: string, estimatedCost: number, actualCost: number) {
    const isUnderpaid = actualCost > estimatedCost;
    const escrowSettlementEnabled = this.configService.get<boolean>('ESCROW_SETTLEMENT_ENABLED', false);

    if (isUnderpaid || actualCost < estimatedCost) {
      if (!escrowSettlementEnabled) {
        this.logger.warn(`[X402] Metered pricing detected usage mismatch (underpaid: ${isUnderpaid}, surplus: ${estimatedCost - actualCost}). Settlement is disabled (ESCROW_SETTLEMENT_ENABLED=false).`);
        return;
      }

      try {
        if (isUnderpaid) {
          await this.contractClient.chargeEscrow(user, quoteId, actualCost);
        } else {
          const surplus = estimatedCost - actualCost;
          if (surplus > 0) {
            await this.contractClient.refundEscrow(user, quoteId, surplus);
          }
        }
      } catch (error) {
        this.logger.error(`[X402] Failed to settle escrow: ${error.message}`);
      }
    }

    return { isUnderpaid, actualCost };
  }
}