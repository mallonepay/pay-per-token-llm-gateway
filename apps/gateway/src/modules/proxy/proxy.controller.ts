import {
  Controller,
  All,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { ProxyService } from './proxy.service';
import { X402Service } from '../x402/x402.service';
import { RoutesService } from '../routes/routes.service';
import { PaymentsService } from '../payments/payments.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { AdminService } from '../admin/admin.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard';
import { chatCompletionRequestSchema, txHashSchema, stellarAddressSchema } from '@x402/validation';
import { calculatePrice, comparePayment } from '@x402/x402-core';
import { getConfig } from '@x402/config';
import { logger } from '@x402/logger';
import { generateId } from '@x402/shared';
import { chargeEscrow, settleEscrow } from '../x402/escrow-client';
import type { ChatCompletionRequest, PaymentRecord, Quote, RouteConfig } from '@x402/types';

interface EscrowForwardOptions {
  isEscrow?: boolean;
  userAddress?: string;
  quoteId?: string;
}

@ApiTags('proxy')
@Controller()
@UseGuards(RateLimitGuard)
export class ProxyController {
  constructor(
    private readonly proxyService: ProxyService,
    private readonly x402Service: X402Service,
    private readonly routesService: RoutesService,
    private readonly paymentsService: PaymentsService,
    private readonly analyticsService: AnalyticsService,
    private readonly adminService: AdminService,
    private readonly webhooksService: WebhooksService,
  ) {}

  /**
   * Main proxy endpoint — catches all LLM API requests.
   *
   * Flow:
   * 1. Validate the request body
   * 2. Look up the route for the requested model + path
   * 3. Check for user address: if user has sufficient credit-escrow balance,
   *    skip Horizon verification and use escrow deduction
   * 4. If no escrow: check X-Payment-Hash header. If missing, return 402 with quote
   * 5. If X-Payment-Hash: verify on-chain, then forward to upstream LLM
   */
  @All('chat/completions')
  @HttpCode(HttpStatus.OK)
  async handleChatCompletion(@Req() req: Request, @Res() res: Response) {
    const traceId = generateId();
    const startTime = Date.now();

    try {
      // 1. Validate request
      const parseResult = chatCompletionRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        throw new BadRequestException({
          status: 400,
          error: 'Bad Request',
          message: 'Invalid chat completion request',
          details: parseResult.error.flatten(),
        });
      }
      const body = parseResult.data;
      const model = body.model;

      // 2. Look up the route for the requested model. Path normalization
      // (stripping the gateway prefix and matching `/v1` conventions) is
      // handled inside RoutesService so the matching logic stays in one place.
      const route = await this.routesService.findByPathAndModel(req.path, model);
      if (!route) {
        return res.status(404).json({
          status: 404,
          error: 'Not Found',
          message: `No route configured for model: ${model}`,
        });
      }

      // 3. Check for user address header (credit-escrow check)
      const userAddress = (req.headers['x-user-address'] ||
        req.headers['x-wallet-address'] ||
        req.headers['x-payer-address']) as string | undefined;

      const txHash = req.headers['x-payment-hash'] as string | undefined;
      if (txHash !== undefined) {
        const txParse = txHashSchema.safeParse(txHash);
        if (!txParse.success) {
          return res.status(400).json({
            status: 400,
            error: 'Bad Request',
            message: 'Invalid X-Payment-Hash header: expected a 64-character hexadecimal string',
          });
        }
      }

      // Check escrow balance if userAddress is provided
      if (userAddress) {
        const addrParse = stellarAddressSchema.safeParse(userAddress);
        if (addrParse.success) {
          const estimatedTokens =
            route.pricingModel === 'per_token' ? body.max_tokens || undefined : undefined;
          const quote = await this.x402Service.generateQuoteForRoute(route, estimatedTokens);
          const requiredAmount = BigInt(quote.amount);

          const escrowBalance = await this.x402Service.getUserEscrowBalance(userAddress);
          if (BigInt(escrowBalance) >= requiredAmount && requiredAmount > 0n) {
            logger.info('Using escrow balance for request', {
              traceId,
              user: userAddress.slice(0, 8),
              escrowBalance,
              requiredAmount: quote.amount,
            });

            // Create confirmed escrow payment record in DB
            const payment = await this.paymentsService.createEscrowPayment(
              quote,
              route,
              userAddress,
            );

            // Resolve upstream API key
            const upstreamApiKey =
              process.env[`UPSTREAM_API_KEY_${route.providerId.toUpperCase().replace(/-/g, '_')}`];

            if (body.stream) {
              return this.handleStreamingForward(
                res,
                body,
                route,
                payment.txHash || `escrow:${quote.id}`,
                upstreamApiKey,
                payment,
                traceId,
                startTime,
                { isEscrow: true, userAddress, quoteId: quote.id },
              );
            }

            return this.handleNonStreamingForward(
              res,
              body,
              route,
              payment.txHash || `escrow:${quote.id}`,
              upstreamApiKey,
              payment,
              traceId,
              startTime,
              { isEscrow: true, userAddress, quoteId: quote.id },
            );
          } else {
            logger.info('Escrow balance insufficient, falling back to per-request payment', {
              traceId,
              user: userAddress.slice(0, 8),
              escrowBalance,
              requiredAmount: quote.amount,
            });
          }
        }
      }

      // 4. Per-request payment fallback: require X-Payment-Hash
      if (!txHash) {
        return this.handle402Response(res, route, traceId, model, body);
      }

      // Verify payment on-chain (includes cross-route replay protection)
      const verified = await this.verifyAndConfirmPayment(txHash, route, res, traceId);
      if (!verified) {
        return; // 402 error response already sent
      }

      // 5. Resolve upstream API key
      const upstreamApiKey =
        process.env[`UPSTREAM_API_KEY_${route.providerId.toUpperCase().replace(/-/g, '_')}`];
      const payment = await this.paymentsService.findByTxHash(txHash);

      if (body.stream) {
        return this.handleStreamingForward(
          res,
          body,
          route,
          txHash,
          upstreamApiKey,
          payment,
          traceId,
          startTime,
        );
      }

      return this.handleNonStreamingForward(
        res,
        body,
        route,
        txHash,
        upstreamApiKey,
        payment,
        traceId,
        startTime,
      );
    } catch (error) {
      logger.error('Proxy error', { traceId, error: String(error) });

      if (error instanceof BadRequestException) {
        return res.status(400).json({
          status: 400,
          error: 'Bad Request',
          message: error.message,
        });
      }

      return res.status(502).json({
        status: 502,
        error: 'Bad Gateway',
        message: 'Upstream LLM request failed',
      });
    }
  }

  // ── Helper methods ───────────────────────────

  /**
   * Send a 402 Payment Required response.
   * For per-token routes, estimates cost based on request max_tokens.
   */
  private async handle402Response(
    res: Response,
    route: RouteConfig,
    traceId: string,
    model: string,
    body: ChatCompletionRequest,
  ) {
    logger.info('402: Payment required', { traceId, model });

    // For per-token pricing, estimate from the request's max_tokens
    const estimatedTokens =
      route.pricingModel === 'per_token' ? body.max_tokens || undefined : undefined;

    const quote = await this.x402Service.generateQuoteForRoute(route, estimatedTokens);
    const payment402 = await this.x402Service.build402Response(quote);

    await this.paymentsService.createPendingPayment(quote, route);
    await this.analyticsService.recordUnpaidRequest(route.path, route.providerId);

    await this.adminService.writeAuditLog({
      action: 'quote_generated',
      entity: 'quote',
      entityId: quote.id,
      providerId: route.providerId,
      actor: 'system',
      details: {
        model,
        route: route.path,
        amount: quote.amount,
        pricingModel: route.pricingModel,
        estimatedTokens,
        traceId,
      },
    });

    return res.status(402).json(payment402);
  }

  /**
   * Verify payment on-chain and confirm it. Returns true if verified.
   */
  private async verifyAndConfirmPayment(
    txHash: string,
    route: RouteConfig,
    res: Response,
    traceId: string,
  ): Promise<boolean> {
    logger.info('Verifying payment', { traceId, txHash });

    const existingPayment = await this.paymentsService.findByTxHash(txHash);

    // SECURITY — single-use invariant.
    if (existingPayment?.status === 'confirmed') {
      if (existingPayment.routeId !== route.id) {
        logger.warn('Cross-route replay attempt', {
          traceId,
          txHash,
          existingRoute: existingPayment.routeId,
          requestedRoute: route.id,
        });
        res.status(402).json({
          status: 402,
          error: 'Payment Required',
          message: 'This payment was made for a different route. A new payment is required.',
        });
        return false;
      }

      logger.warn('Payment replay attempt (hash already used)', {
        traceId,
        txHash,
        routeId: existingPayment.routeId,
      });
      res.status(402).json({
        status: 402,
        error: 'Payment Required',
        message: 'This payment has already been used. A new payment is required.',
      });
      return false;
    }

    // Use the original quote from the pending payment, or generate a new one.
    const storedQuote = existingPayment?.receiptJson
      ? (existingPayment.receiptJson as Quote)
      : null;

    if (storedQuote && this.x402Service.isQuoteExpired(storedQuote)) {
      logger.warn('Payment made with expired quote', {
        traceId,
        txHash,
        quoteId: storedQuote.id,
        expiresAt: storedQuote.expiresAt,
        now: Date.now() / 1000,
      });
      res.status(402).json({
        status: 402,
        error: 'Payment Required',
        message: 'The payment quote has expired. Please request a new quote and pay again.',
      });
      return false;
    }

    const quoteForVerification =
      storedQuote ?? (await this.x402Service.generateQuoteForRoute(route));

    const verification = await this.x402Service.verifyPayment(txHash, quoteForVerification);

    if (!verification.verified) {
      logger.warn('Payment verification failed', {
        traceId,
        txHash,
        reason: verification.failureReason,
      });
      await this.adminService.writeAuditLog({
        action: 'payment_verification_failed',
        entity: 'payment',
        entityId: txHash,
        providerId: route.providerId,
        actor: verification.payerAddress,
        details: {
          reason: verification.failureReason,
          route: route.path,
          traceId,
        },
      });

      // Notify provider of verification failure
      this.webhooksService
        .notifyVerificationFailed(route.providerId, {
          txHash,
          reason: verification.failureReason || 'Unknown reason',
        })
        .catch((err) =>
          logger.error('Webhook notifyVerificationFailed error', { traceId, error: String(err) }),
        );

      res.status(402).json({
        status: 402,
        error: 'Payment Required',
        message: `Payment verification failed: ${verification.failureReason}`,
      });
      return false;
    }

    const claimResult = existingPayment
      ? await this.paymentsService.confirmPayment(existingPayment.quoteId, verification)
      : await (async () => {
          await this.paymentsService.createPendingPayment(quoteForVerification, route);
          return this.paymentsService.confirmPayment(quoteForVerification.id, verification);
        })();

    if (!claimResult) {
      logger.warn('Payment replay attempt (claim lost to concurrent request)', {
        traceId,
        txHash,
      });
      res.status(402).json({
        status: 402,
        error: 'Payment Required',
        message: 'This payment has already been used. A new payment is required.',
      });
      return false;
    }

    await this.adminService.writeAuditLog({
      action: 'payment_verified',
      entity: 'payment',
      entityId: txHash,
      providerId: route.providerId,
      actor: verification.payerAddress,
      details: {
        amount: verification.amount,
        asset: verification.asset,
        route: route.path,
        traceId,
      },
    });

    // Notify provider of payment received
    this.webhooksService
      .notifyPaymentReceived(route.providerId, {
        txHash,
        amount: verification.amount || '0',
        asset: verification.asset || 'USDC',
        payerAddress: verification.payerAddress || 'unknown',
      })
      .catch((err) =>
        logger.error('Webhook notifyPaymentReceived error', { traceId, error: String(err) }),
      );

    return true;
  }

  /**
   * Forward a streaming request: pipe SSE chunks from upstream to client.
   * For per-token routes, calculates actual cost from final SSE usage chunk.
   */
  private async handleStreamingForward(
    res: Response,
    body: ChatCompletionRequest,
    route: RouteConfig,
    txHash: string,
    apiKey: string | undefined,
    payment: PaymentRecord | null,
    traceId: string,
    startTime: number,
    escrowOptions?: EscrowForwardOptions,
  ) {
    logger.info('Forwarding streaming request to upstream', {
      traceId,
      model: body.model,
      upstreamUrl: route.upstreamUrl,
      pricingModel: route.pricingModel,
      isEscrow: escrowOptions?.isEscrow,
    });

    res.setHeader('X-Request-Trace-Id', traceId);

    // Pipe upstream SSE stream to client; extract tokens for per-token pricing
    await this.proxyService.forwardStreamRequest(
      body,
      route.upstreamUrl,
      res,
      apiKey,
      traceId,
      async (totalTokens) => {
        const streamDuration = Date.now() - startTime;

        // Calculate actual cost
        const costResult = await this.applyMeteredPricing(
          route,
          payment,
          totalTokens,
          res,
          traceId,
          escrowOptions,
        );

        // Send cost/receipt as a trailing SSE event
        if (payment) {
          const receipt = {
            id: payment.id,
            quoteId: payment.quoteId,
            txHash: payment.txHash,
            payerAddress: payment.payerAddress,
            amount: payment.amount?.toString(),
            asset: payment.asset,
            status: payment.status,
            actualCost: costResult.actualCost,
            tokensUsed: totalTokens ?? null,
            paymentMethod: escrowOptions?.isEscrow ? 'escrow' : 'per_request',
          };
          try {
            res.write(`data: ${JSON.stringify({ x402_receipt: receipt })}\n\n`);
            res.write('data: [DONE]\n\n');
          } catch {
            /* client disconnected — stream already ended */
          }
        }

        await this.analyticsService.recordPaidRequest(
          route.path,
          route.providerId,
          payment?.payerAddress || 'unknown',
          costResult.actualCost,
          payment?.asset || 'USDC',
          streamDuration,
        );
      },
    );

    await this.adminService.writeAuditLog({
      action: escrowOptions?.isEscrow
        ? 'escrow_request_forwarded_stream'
        : 'request_forwarded_stream',
      entity: 'request',
      entityId: traceId,
      providerId: route.providerId,
      actor: payment?.payerAddress || 'unknown',
      details: {
        model: body.model,
        route: route.path,
        txHash,
        traceId,
        isEscrow: escrowOptions?.isEscrow,
      },
    });
  }

  /**
   * Forward a non-streaming request: collect full response and return as JSON.
   */
  private async handleNonStreamingForward(
    res: Response,
    body: ChatCompletionRequest,
    route: RouteConfig,
    txHash: string,
    apiKey: string | undefined,
    payment: PaymentRecord | null,
    traceId: string,
    _startTime: number,
    escrowOptions?: EscrowForwardOptions,
  ) {
    logger.info('Forwarding request to upstream', {
      traceId,
      model: body.model,
      upstreamUrl: route.upstreamUrl,
      pricingModel: route.pricingModel,
      isEscrow: escrowOptions?.isEscrow,
    });

    const { response, responseTime } = await this.proxyService.forwardRequest(
      body,
      route.upstreamUrl,
      apiKey,
      traceId,
    );

    // Calculate actual cost for per-token pricing
    const tokensUsed = response.usage?.total_tokens;
    const costResult = await this.applyMeteredPricing(
      route,
      payment,
      tokensUsed,
      res,
      traceId,
      escrowOptions,
    );

    await this.analyticsService.recordPaidRequest(
      route.path,
      route.providerId,
      payment?.payerAddress || 'unknown',
      costResult.actualCost,
      payment?.asset || 'USDC',
      responseTime,
    );

    // Add x402 receipt header
    if (payment) {
      res.setHeader(
        'X-Payment-Receipt',
        JSON.stringify({
          id: payment.id,
          quoteId: payment.quoteId,
          txHash: payment.txHash,
          payerAddress: payment.payerAddress,
          amount: payment.amount?.toString(),
          asset: payment.asset,
          status: payment.status,
          actualCost: costResult.actualCost,
          tokensUsed: tokensUsed ?? null,
          paymentMethod: escrowOptions?.isEscrow ? 'escrow' : 'per_request',
        }),
      );
    }
    res.setHeader('X-Request-Trace-Id', traceId);

    await this.adminService.writeAuditLog({
      action: escrowOptions?.isEscrow ? 'escrow_request_forwarded' : 'request_forwarded',
      entity: 'request',
      entityId: traceId,
      providerId: route.providerId,
      actor: payment?.payerAddress || 'unknown',
      details: {
        model: body.model,
        route: route.path,
        txHash,
        responseTime,
        tokens: tokensUsed,
        actualCost: costResult.actualCost,
        surplus: costResult.surplus,
        traceId,
        isEscrow: escrowOptions?.isEscrow,
      },
    });

    return res.json(response);
  }

  // ── Per-Token Metered Pricing & Escrow Deductions ──────────────

  /**
   * Apply pricing after receiving the LLM response.
   *
   * For escrow flows:
   *   1. Calculates actual cost
   *   2. Calls contract.charge() to deduct actual cost on-chain
   *   3. Sets X-Actual-Cost, X-Escrow-Charged headers
   *
   * For standard per-token flows:
   *   1. Calculates actual cost from tokens used × perTokenPrice
   *   2. Compares against the paid deposit
   *   3. Sets X-Actual-Cost, X-Tokens-Used, X-Surplus headers
   *   4. Settles escrow (refunds surplus) if settlement enabled
   */
  private async applyMeteredPricing(
    route: RouteConfig,
    payment: PaymentRecord | null,
    tokensUsed: number | undefined,
    res: Response,
    traceId: string,
    escrowOptions?: EscrowForwardOptions,
  ): Promise<{
    actualCost: string;
    surplus: string;
    isOverpaid: boolean;
    isUnderpaid: boolean;
  }> {
    const config = getConfig();

    // Escrow Deduction Flow
    if (escrowOptions?.isEscrow && escrowOptions.userAddress) {
      let actualCost = route.flatPrice || payment?.amount?.toString() || '0';
      if (route.pricingModel === 'per_token' && tokensUsed) {
        const priceResult = calculatePrice({ route, tokenCount: tokensUsed });
        actualCost = priceResult.amount;
      }

      if (!res.headersSent) {
        res.setHeader('X-Actual-Cost', actualCost);
        res.setHeader('X-Escrow-Charged', 'true');
        if (tokensUsed) {
          res.setHeader('X-Tokens-Used', String(tokensUsed));
        }
      }

      if (payment) {
        await this.paymentsService.recordActualCost(payment.quoteId, actualCost, tokensUsed || 0);
      }

      logger.info('Escrow deduction calculated', {
        traceId,
        user: escrowOptions.userAddress.slice(0, 8),
        tokensUsed,
        actualCost,
      });

      // Post-request charge: deduct actual cost from escrow on-chain
      if (config.contracts.creditEscrow) {
        const adminSecret =
          config.payment.contractAdminSecret ||
          process.env.CONTRACT_ADMIN_SECRET ||
          'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
        chargeEscrow({
          contractId: config.contracts.creditEscrow,
          rpcUrl: config.stellar.sorobanRpcUrl,
          networkPassphrase: config.stellar.networkPassphrase,
          adminSecret,
          user: escrowOptions.userAddress,
          amount: actualCost,
          quoteId: escrowOptions.quoteId || payment?.quoteId || generateId(),
        }).catch((err) => logger.error('Escrow charge error', { traceId, error: String(err) }));
      }

      return {
        actualCost,
        surplus: '0',
        isOverpaid: false,
        isUnderpaid: false,
      };
    }

    // Standard Per-Request Flow
    if (route.pricingModel !== 'per_token' || !tokensUsed) {
      const paid = payment?.amount?.toString() || '0';
      if (!res.headersSent) {
        res.setHeader('X-Actual-Cost', paid);
      }
      return {
        actualCost: paid,
        surplus: '0',
        isOverpaid: false,
        isUnderpaid: false,
      };
    }

    // Calculate actual per-token cost
    const priceResult = calculatePrice({ route, tokenCount: tokensUsed });
    const actualCost = priceResult.amount;

    // Compare against paid amount
    const paidAmount = payment?.amount?.toString() || actualCost;
    const comparison = comparePayment(paidAmount, actualCost);

    // Set response headers (skip if streaming — headers already flushed)
    if (!res.headersSent) {
      res.setHeader('X-Actual-Cost', actualCost);
      res.setHeader('X-Tokens-Used', String(tokensUsed));
      res.setHeader('X-Paid-Amount', paidAmount);
      if (comparison.surplus !== '0') {
        res.setHeader('X-Surplus', comparison.surplus);
      }
    }

    // Record actual cost on the payment
    if (payment) {
      await this.paymentsService.recordActualCost(payment.quoteId, actualCost, tokensUsed);
    }

    logger.info('Per-token cost calculated', {
      traceId,
      tokensUsed,
      actualCost,
      paidAmount,
      surplus: comparison.surplus,
      isOverpaid: comparison.isOverpaid,
      isUnderpaid: comparison.isUnderpaid,
    });

    if (comparison.isUnderpaid) {
      logger.warn('Per-token underpayment detected', {
        traceId,
        tokensUsed,
        actualCost,
        paidAmount,
        shortfall: comparison.surplus,
      });
    }

    // Escrow settlement: charge actual cost + refund surplus from the
    // caller's credit-escrow balance. Best-effort (fire-and-forget).
    if (payment?.payerAddress) {
      settleEscrow({
        enabled: config.payment.escrowSettlementEnabled,
        contractId: config.contracts.creditEscrow,
        rpcUrl: config.stellar.sorobanRpcUrl,
        networkPassphrase: config.stellar.networkPassphrase,
        adminSecret: config.payment.contractAdminSecret,
        user: payment.payerAddress,
        actualCost,
        surplus: comparison.surplus,
        isOverpaid: comparison.isOverpaid,
        quoteId: payment.quoteId,
      }).catch((err) => logger.error('Escrow settlement error', { traceId, error: String(err) }));
    }

    return {
      actualCost,
      surplus: comparison.surplus,
      isOverpaid: comparison.isOverpaid,
      isUnderpaid: comparison.isUnderpaid,
    };
  }
}
