import { Controller, Get, Param, Res, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { getConfig } from '@x402/config';
import { logger } from '@x402/logger';
import { getEscrowBalance } from './escrow-client';

@ApiTags('escrow')
@Controller('escrow')
export class EscrowController {
  /**
   * Read a user's prepaid escrow balance from the credit-escrow contract.
   *
   * This is a read-only, permissionless call so the dashboard can show
   * balances without a gateway session.
   */
  @Get(':address/balance')
  async getBalance(@Param('address') address: string, @Res() res: Response) {
    const config = getConfig();

    if (!config.contracts.creditEscrow) {
      return res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        status: 503,
        error: 'Escrow contract not configured',
      });
    }

    try {
      const balance = await getEscrowBalance({
        contractId: config.contracts.creditEscrow,
        rpcUrl: config.stellar.sorobanRpcUrl,
        networkPassphrase: config.stellar.networkPassphrase,
        user: address,
      });

      if (balance === null) {
        return res.status(HttpStatus.BAD_GATEWAY).json({
          status: 502,
          error: 'Could not read escrow balance from contract',
        });
      }

      return res.json({
        address,
        balance,
        asset: config.payment.defaultAsset,
        contractId: config.contracts.creditEscrow,
      });
    } catch (error) {
      logger.error('Escrow balance read failed', { address, error: String(error) });
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        status: 500,
        error: 'Failed to read escrow balance',
      });
    }
  }
}
