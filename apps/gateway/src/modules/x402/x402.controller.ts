import {
  Controller,
  Post,
  Get,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
import { X402Service } from './x402.service';
import { RoutesService } from '../routes/routes.service';
import { PaymentsService } from '../payments/payments.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { verifyPaymentSchema, stellarAddressSchema } from '@x402/validation';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard';
import { stroopsToUsdc } from './escrow-client';
import type { Quote } from '@x402/types';

@ApiTags('x402')
@Controller('x402')
// Public verification endpoint — rate-limit it so a caller can't spam
// Redis writes + Horizon lookups (quote-spam / resource exhaustion).
@UseGuards(RateLimitGuard)
export class X402Controller {
  constructor(
    private readonly x402Service: X402Service,
    private readonly routesService: RoutesService,
    private readonly paymentsService: PaymentsService,
    private readonly analyticsService: AnalyticsService,
  ) {}

  /**
   * Verify a payment for a specific quote.
   */
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  async verifyPayment(@Body() body: { txHash: string; quoteId: string }) {
    const parsed = verifyPaymentSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.errors);
    }

    const { txHash, quoteId } = parsed.data;

    // Look up the quote from cache/payment store
    const storedPayment = await this.paymentsService.findByQuoteId(quoteId);
    if (!storedPayment) {
      throw new BadRequestException('Quote not found or expired');
    }

    // Single-use invariant: only pending quotes may be verified. Re-verifying
    // an already-confirmed quote would let a caller overwrite its txHash and
    // orphan the previously consumed hash, weakening replay protection.
    if (storedPayment.status !== 'pending') {
      throw new BadRequestException('Quote already processed');
    }

    const quote = storedPayment.receiptJson as Quote;
    const verification = await this.x402Service.verifyPayment(txHash, quote);

    if (verification.verified) {
      const receipt = await this.paymentsService.confirmPayment(quoteId, verification);
      if (!receipt) {
        // A concurrent request claimed this hash first — single-use holds.
        return {
          verified: false,
          txHash,
          payerAddress: '',
          amount: '0',
          asset: quote.asset,
          ledger: 0,
          timestamp: 0,
          failureReason: 'Payment already used (replay protection)',
        };
      }
    }

    return verification;
  }

  /**
   * Get payment status for a quote.
   */
  @Get('status/:quoteId')
  @ApiOperation({ summary: 'Get payment status for a quote' })
  @ApiParam({ name: 'quoteId', type: 'string' })
  async getPaymentStatus(@Param('quoteId') quoteId: string) {
    const payment = await this.paymentsService.findByQuoteId(quoteId);
    if (!payment) {
      throw new BadRequestException('Quote not found');
    }

    return {
      quoteId,
      status: payment.status,
      txHash: payment.txHash,
      verifiedAt: payment.verifiedAt,
    };
  }

  /**
   * Get credit-escrow balance for a user.
   */
  @Get('escrow/balance/:address')
  @ApiOperation({ summary: 'Get credit-escrow balance for a user' })
  @ApiParam({ name: 'address', type: 'string' })
  async getEscrowBalance(@Param('address') address: string) {
    const parsed = stellarAddressSchema.safeParse(address);
    if (!parsed.success) {
      throw new BadRequestException('Invalid Stellar address');
    }

    const balance = await this.x402Service.getUserEscrowBalance(address);
    return {
      address,
      balance,
      balanceUsdc: stroopsToUsdc(balance),
    };
  }

  /**
   * Get credit-escrow usage history for a user.
   */
  @Get('escrow/usage/:address')
  @ApiOperation({ summary: 'Get credit-escrow usage history for a user' })
  @ApiParam({ name: 'address', type: 'string' })
  @ApiQuery({ name: 'offset', required: false, type: 'number' })
  @ApiQuery({ name: 'limit', required: false, type: 'number' })
  async getEscrowUsage(
    @Param('address') address: string,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
  ) {
    const parsed = stellarAddressSchema.safeParse(address);
    if (!parsed.success) {
      throw new BadRequestException('Invalid Stellar address');
    }

    const offsetNum = offset ? Math.max(0, parseInt(offset, 10) || 0) : 0;
    const limitNum = limit ? Math.min(100, Math.max(1, parseInt(limit, 10) || 20)) : 20;

    const usage = await this.x402Service.getUserEscrowUsage(address, offsetNum, limitNum);
    return {
      address,
      usage,
      total: usage.length,
      offset: offsetNum,
      limit: limitNum,
    };
  }
}
