import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ContractClient {
  constructor(private configService: ConfigService) {}

  async chargeEscrow(user: string, quoteId: string, actualCost: number): Promise<void> {
    // Implementation for calling credit-escrow.charge(user, quoteId, actualCost)
    // This would typically use a Stellar SDK to interact with the Soroban contract
    console.log(`[ContractClient] Charging escrow: user=${user}, quoteId=${quoteId}, cost=${actualCost}`);
  }

  async refundEscrow(user: string, quoteId: string, surplus: number): Promise<void> {
    // Implementation for calling credit-escrow.refund(user, quoteId, surplus)
    console.log(`[ContractClient] Refunding escrow: user=${user}, quoteId=${quoteId}, surplus=${surplus}`);
  }
}