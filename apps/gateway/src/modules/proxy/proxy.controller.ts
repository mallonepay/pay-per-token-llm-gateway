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
import { chatCompletionRequestSchema, txHashSchema } from '@x402/validation';
import { calculatePrice, comparePayment, DEFAULT_TOKEN_ESTIMATE } from '@x402/x402-core';
import { getConfig } from '@x402/config';
import { logger } from '@x402/logger';
import { generateId } from '@x402/shared';
import { settleEscrow } from '../x402/escrow-client';
import type { ChatCompletionRequest, PaymentRecord, Quote, RouteConfig } from '@x402/types';

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
   * 3. If no payment header: generate quote (with token estimate for per-token), store pending payment, return 402
   * 4. If payment: verify on-chain, then:
   *    - stream=true → pipe SSE stream from upstream to client
   *    - stream=false → forward, collect full response, calculate actual cost for per-token, return JSON
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

      // 3. Check for payment headers.
      //    - X-Payment-Hash: a 64-char hex Horizon transaction hash (per-request payment)
      //    - X-Escrow-User: a Stellar address that has prepaid credit in the
      //      credit-escrow contract. When the balance covers the quote amount,
      //      Horizon payment verification is skipped.
      const txHash = req.headers['x-payment-hash'] as string | undefined;
      const escrowUser = req.headers['x-escrow-user'] as string | undefined;

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

      if (!txHash && !escrowUser) {
        return this.handle402Response(res, route, traceId, model, body);
      }

      // 4. Verify payment (Horizon txHash or escrow balance)
      let payment: PaymentRecord | null = null;
      if (txHash) {
        const verified = await this.verifyAndConfirmPayment(txHash, route, res, traceId);
        if (!verified) {
          return; // 402 error response already sent
        }
        payment = await this.paymentsService.findByTxHash(txHash);
      } else if (escrowUser) {
        payment = await this.verifyAndConfirmEscrowPayment(escrowUser, route, res, traceId, body);
        if (!payment) {
          return; // 402 error response already sent
        }
      }

      // 5. Resolve upstream API key
      const upstreamApiKey =
        process.env[`UPSTREAM_API_KEY_${route.providerId.toUpperCase().replace(/-/g, '_')}`];

      // 6. Bound per-token completions to what the deposit covers (see
      //    capForwardBody): never forward an uncapped request whose deposit
      //    was estimated from the default token budget.
      const forwardBody = this.capForwardBody(body, route, payment);

      if (body.stream) {
        return this.handleStreamingForward(
          res,
          forwardBody,
          route,
          payment?.txHash || '',
          upstreamApiKey,
          payment,
          traceId,
          startTime,
        );
      }

      return this.handleNonStreamingForward(
        res,
        forwardBody,
        route,
        payment?.txHash || '',
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
   * Cap the forwarded completion length for per-token routes.
   *
   * Per-token deposits are estimated from `max_tokens` (or a default budget
   * when the client omits it). If the client omitted `max_tokens`, an
   * uncapped upstream response could generate far more completion tokens than
   * the deposit covers — so forward with `max_tokens` set to exactly the
   * budget the deposit was estimated from. Clients that supplied their own
   * `max_tokens` are already bounded server-side and pass through untouched.
   *
   * Note: this bounds completion tokens; prompt tokens are still unbounded
   * and still billed, which the underpayment debt gate (verifyAndConfirm
   * Payment) exists to enforce.
   */
  private capForwardBody(
    body: ChatCompletionRequest,
    route: RouteConfig,
    payment: PaymentRecord | null,
  ): ChatCompletionRequest {
    if (route.pricingModel !== 'per_token' || body.max_tokens !== undefined) return body;

    // The quote used for this payment carries the exact estimate the deposit
    // was based on (falls back to the shared default for payment rows whose
    // receipt was written before the field existed).
    const quote = payment?.receiptJson ? (payment.receiptJson as Quote) : null;
    const budget = quote?.estimatedMaxTokens ?? DEFAULT_TOKEN_ESTIMATE;
    logger.info('Capping forwarded max_tokens to deposit estimate', {
      model: body.model,
      max_tokens: budget,
      pricingModel: route.pricingModel,
    });
    return { ...body, max_tokens: budget };
  }

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

    // SECURITY — single-use invariant. A confirmed payment row means this
    // txHash has already been consumed; it must never grant access a second
    // time. Previously a confirmed row on the SAME route short-circuited to
    // `true`, letting callers pay once and replay the hash indefinitely for
    // unlimited LLM access (and bypassing Redis/on-chain replay protection,
    // which were only consulted for not-yet-confirmed payments). Cross-route
    // replays are rejected first for a clearer message; same-route replays
    // are rejected here — the DB row is evidence of consumption, never proof
    // of freshness.
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
    // CRITICAL: if the original quote has expired, reject even if the payment
    // was technically on-chain — the quote window is a security boundary.
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

    // If no stored quote exists, generate one for verification.
    // (This handles the case where a payment arrives without a prior 402 quote.)
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

    // ── Underpayment debt gate (per-token enforcement) ────────────
    //
    // A payer with open underpayment debt on this provider must top up before
    // receiving further LLM access. The arriving on-chain payment must cover
    // the current quote deposit PLUS all outstanding debt; the surplus over
    // the deposit is the debt repayment and clears the ledger. When the
    // payment is insufficient we answer 402 with a quote for the combined
    // amount so the SDK auto-pays the top-up in a single transaction.
    //
    // Quotes always carry the pure deposit (never the debt), so the same
    // deposit basis is used here and in the metered settlement below. The
    // refused payment is deliberately not claimed — it stays on-chain to the
    // provider (the protocol has no refund path) and its hash is already
    // consumed by Redis/on-chain replay protection, so it cannot be replayed.
    const openDebt = await this.paymentsService.getOpenDebtTotal(
      verification.payerAddress,
      route.providerId,
    );
    if (openDebt > 0n) {
      const deposit = BigInt(quoteForVerification.amount);
      const requiredTotal = deposit + openDebt;
      if (BigInt(verification.amount) < requiredTotal) {
        logger.warn('Underpayment debt outstanding — access denied until topped up', {
          traceId,
          txHash,
          payerAddress: verification.payerAddress,
          providerId: route.providerId,
          debt: openDebt.toString(),
          paid: verification.amount,
          requiredTotal: requiredTotal.toString(),
        });

        await this.adminService.writeAuditLog({
          action: 'payment_debt_denied',
          entity: 'payment',
          entityId: txHash,
          providerId: route.providerId,
          actor: verification.payerAddress,
          details: {
            debt: openDebt.toString(),
            paid: verification.amount,
            requiredTotal: requiredTotal.toString(),
            route: route.path,
            traceId,
          },
        });

        // Fresh deposit quote, amount bumped to deposit + debt so the client
        // SDK pays the top-up in one transaction.
        const baseQuote = await this.x402Service.generateQuoteForRoute(route);
        const topUpQuote: Quote = { ...baseQuote, amount: requiredTotal.toString() };
        const debtRequiredResponse = await this.x402Service.build402Response(topUpQuote);
        res.status(402).json(debtRequiredResponse);
        return false;
      }

      // Payment covers deposit + debt → the surplus is the repayment.
      await this.paymentsService.settleUnderpaymentDebts(
        verification.payerAddress,
        route.providerId,
      );
      logger.info('Underpayment debt settled by top-up payment', {
        traceId,
        txHash,
        payerAddress: verification.payerAddress,
        providerId: route.providerId,
        debt: openDebt.toString(),
      });
    }

    // Atomically claim the payment. `confirmPayment` returns null when a
    // concurrent request already consumed this hash (single-use invariant)
    // — in that case the caller must NOT receive LLM access.
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
   * Verify a prepaid escrow balance and confirm it as payment.
   *
   * Generates an internal quote so the payment record and settlement path
   * can be reused. Returns the confirmed PaymentRecord on success, or null
   * when the balance is insufficient (a 402 has already been sent).
   */
  private async verifyAndConfirmEscrowPayment(
    escrowUser: string,
    route: RouteConfig,
    res: Response,
    traceId: string,
    body: ChatCompletionRequest,
  ): Promise<PaymentRecord | null> {
    logger.info('Verifying escrow payment', { traceId, escrowUser: escrowUser.slice(0, 8) });

    const estimatedTokens =
      route.pricingModel === 'per_token' ? body.max_tokens || undefined : undefined;
    const quote = await this.x402Service.generateQuoteForRoute(route, estimatedTokens);
    const verification = await this.x402Service.verifyEscrowPayment(escrowUser, quote);

    if (!verification.verified) {
      logger.warn('Escrow verification failed', {
        traceId,
        escrowUser: escrowUser.slice(0, 8),
        reason: verification.failureReason,
      });

      // Build a 402 response so the caller can fall back to per-request payment.
      const payment402 = await this.x402Service.build402Response(quote);
      await this.paymentsService.createPendingPayment(quote, route);
      await this.analyticsService.recordUnpaidRequest(route.path, route.providerId);

      res.status(402).json({
        ...payment402,
        message: `Escrow payment failed: ${verification.failureReason}. ${payment402.message}`,
      });
      return null;
    }

    // Create and confirm a synthetic payment record for this escrow draw.
    await this.paymentsService.createPendingPayment(quote, route);
    const claimResult = await this.paymentsService.confirmPayment(quote.id, verification);

    if (!claimResult) {
      logger.warn('Escrow replay attempt (claim lost to concurrent request)', {
        traceId,
        escrowUser: escrowUser.slice(0, 8),
        quoteId: quote.id,
      });
      res.status(402).json({
        status: 402,
        error: 'Payment Required',
        message: 'This escrow quote has already been used. Please request a new quote.',
      });
      return null;
    }

    await this.adminService.writeAuditLog({
      action: 'escrow_payment_verified',
      entity: 'payment',
      entityId: quote.id,
      providerId: route.providerId,
      actor: escrowUser,
      details: {
        amount: verification.amount,
        asset: verification.asset,
        route: route.path,
        traceId,
      },
    });

    return this.paymentsService.findByQuoteId(quote.id);
  }

  /**
   * Forward a streaming request: pipe SSE chunks from upstream to client.
   * For per-token routes, calculates actual cost from final SSE usage chunk.
   *
   * After the stream completes, sends cost/receipt data as a trailing SSE
   * event so the SDK can extract payment info from streaming responses.
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
  ) {
    logger.info('Forwarding streaming request to upstream', {
      traceId,
      model: body.model,
      upstreamUrl: route.upstreamUrl,
      pricingModel: route.pricingModel,
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

        // Calculate actual cost for per-token pricing
        const costResult = await this.applyMeteredPricing(
          route,
          payment,
          totalTokens,
          res,
          traceId,
        );

        // Send cost/receipt as a trailing SSE event so the SDK can extract
        // payment info from streaming responses (headers are already flushed).
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
      action: 'request_forwarded_stream',
      entity: 'request',
      entityId: traceId,
      providerId: route.providerId,
      actor: payment?.payerAddress || 'unknown',
      details: { model: body.model, route: route.path, txHash, traceId },
    });
  }

  /**
   * Forward a non-streaming request: collect full response and return as JSON.
   * For per-token routes, calculates actual cost from response usage.total_tokens.
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
  ) {
    logger.info('Forwarding request to upstream', {
      traceId,
      model: body.model,
      upstreamUrl: route.upstreamUrl,
      pricingModel: route.pricingModel,
    });

    const { response, responseTime } = await this.proxyService.forwardRequest(
      body,
      route.upstreamUrl,
      apiKey,
      traceId,
    );

    // Calculate actual cost for per-token pricing
    const tokensUsed = response.usage?.total_tokens;
    const costResult = await this.applyMeteredPricing(route, payment, tokensUsed, res, traceId);

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
        }),
      );
    }
    res.setHeader('X-Request-Trace-Id', traceId);

    await this.adminService.writeAuditLog({
      action: 'request_forwarded',
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
      },
    });

    return res.json(response);
  }

  // ── Per-Token Metered Pricing ──────────────

  /**
   * Apply per-token metered pricing after receiving the LLM response.
   *
   * For flat-rate routes: simply returns the paid amount as the actual cost.
   * For per-token routes:
   *   1. Calculates actual cost from tokens used × perTokenPrice
   *   2. Compares against the paid amount
   *   3. Sets X-Actual-Cost, X-Tokens-Used headers
   *   4. Records the actual cost on the payment
   *   5. Returns the cost details for analytics
   */
  private async applyMeteredPricing(
    route: RouteConfig,
    payment: PaymentRecord | null,
    tokensUsed: number | undefined,
    res: Response,
    traceId: string,
  ): Promise<{
    actualCost: string;
    surplus: string;
    isOverpaid: boolean;
    isUnderpaid: boolean;
  }> {
    if (route.pricingModel !== 'per_token' || !tokensUsed) {
      // Flat-rate or no token data: actual cost = paid amount
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

      // Record the deficit as open debt so future access from this payer on
      // this provider is gated until topped up (see the debt gate in
      // verifyAndConfirmPayment). The response is already delivered — this
      // ledger is what makes the underpayment recoverable on the next visit.
      if (payment?.payerAddress) {
        await this.paymentsService.recordUnderpaymentDebt({
          quoteId: payment.quoteId,
          providerId: route.providerId,
          routeId: route.id,
          payerAddress: payment.payerAddress,
          amount: comparison.surplus.replace('-', ''), // deficit = −surplus
        });
      }
    }

    // Escrow settlement: charge actual cost + refund surplus from the
    // caller's credit-escrow balance. Best-effort (fire-and-forget) — the
    // LLM response has already been delivered; on-chain settlement must
    // never block it.
    if (payment?.payerAddress) {
      const config = getConfig();
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
