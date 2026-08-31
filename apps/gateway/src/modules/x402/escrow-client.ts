/**
 * Soroban contract client for the credit-escrow contract.
 *
 * Enables per-token metered billing: before forwarding the request, the gateway
 * reads the user's credit-escrow balance. If sufficient, it skips Horizon payment
 * verification and uses escrow. After each LLM response the gateway charges the
 * actual cost from the caller's escrow balance and auto-refunds any surplus.
 *
 * Requires `CONTRACT_ADMIN_SECRET` and `ESCROW_SETTLEMENT_ENABLED=true`.
 */

import { xdr, Keypair } from '@stellar/stellar-sdk';
import { logger } from '@x402/logger';
import { accountAddressToScVal, amountToScVal } from './soroban-utils';

// ── Public API ───────────────────────────────

export interface EscrowBalanceOptions {
  contractId: string;
  rpcUrl: string;
  networkPassphrase?: string;
  user: string;
}

export interface EscrowUsageOptions {
  contractId: string;
  rpcUrl: string;
  networkPassphrase?: string;
  user: string;
  offset?: number;
  limit?: number;
}

export interface EscrowUsageEvent {
  user: string;
  amount: string;
  amountUsdc?: string;
  quoteId: string;
  timestamp: number;
}

export interface EscrowChargeOptions {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  /** Secret key of the contract admin (signs the invocation). */
  adminSecret: string;
  /** Stellar address of the user whose escrow balance to charge. */
  user: string;
  /** Amount to charge in stroops. */
  amount: string;
  /** Quote ID for idempotency (same quote never charged twice). */
  quoteId: string;
}

export interface EscrowRefundOptions {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  adminSecret: string;
  user: string;
  /** Amount to refund in stroops (the surplus). */
  amount: string;
  /** Quote ID for idempotency (same quote never refunded twice). */
  quoteId: string;
}

export interface EscrowResult {
  success: boolean;
  error?: string;
}

// ── ScVal Helper ─────────────────────────────

export function scValToBigIntValue(val: unknown): bigint {
  if (val === null || val === undefined) return 0n;
  if (typeof val === 'bigint') return val;
  if (typeof val === 'number') return BigInt(Math.floor(val));
  if (typeof val === 'string') {
    try {
      return BigInt(val);
    } catch {
      return 0n;
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vAny = val as any;
  if (typeof vAny.switch === 'function') {
    const arm = vAny.arm();
    const v = vAny.value();
    if (arm === 'i128') {
      const lo = BigInt(v.lo().toString());
      const hi = BigInt(v.hi().toString());
      return (hi << 64n) + lo;
    }
    if (arm === 'u64' || arm === 'i64' || arm === 'u32' || arm === 'i32') {
      return BigInt(v.toString());
    }
  }
  if (vAny.lo !== undefined) {
    const lo = BigInt(vAny.lo.toString());
    const hi = vAny.hi !== undefined ? BigInt(vAny.hi.toString()) : 0n;
    return (hi << 64n) + lo;
  }
  return 0n;
}

export function stroopsToUsdc(stroops: string): string {
  try {
    const n = BigInt(stroops);
    const whole = n / 10000000n;
    const frac = (n % 10000000n).toString().padStart(7, '0');
    return `${whole}.${frac}`;
  } catch {
    return '0.0000000';
  }
}

// ── Core Operations ───────────────────────────

/**
 * Query a user's credit-escrow balance from the Soroban contract.
 * Returns balance in stroops as a string. Returns '0' on failure.
 */
export async function getEscrowBalance(options: EscrowBalanceOptions): Promise<string> {
  const { contractId, rpcUrl, networkPassphrase, user } = options;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { contract } = await import('@stellar/stellar-sdk');
    const { Client } = contract;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = await Client.from({
      contractId,
      rpcUrl,
      networkPassphrase: networkPassphrase || 'Test SDF Network ; September 2015',
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await client.balance({
      user: accountAddressToScVal(user),
    });

    const val = res?.result !== undefined ? res.result : res;
    const balanceBig = scValToBigIntValue(val);
    return balanceBig.toString();
  } catch (err) {
    logger.warn(
      `[escrow] getEscrowBalance failed for user ${user.slice(0, 8)}... — ` +
        `falling back to '0'. Error: ${(err as Error).message}`,
    );
    return '0';
  }
}

/**
 * Query a user's usage history from the credit-escrow contract.
 */
export async function getEscrowUsage(options: EscrowUsageOptions): Promise<EscrowUsageEvent[]> {
  const { contractId, rpcUrl, networkPassphrase, user, offset = 0, limit = 20 } = options;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { contract, xdr, Address } = await import('@stellar/stellar-sdk');
    const { Client } = contract;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = await Client.from({
      contractId,
      rpcUrl,
      networkPassphrase: networkPassphrase || 'Test SDF Network ; September 2015',
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await client.get_usage({
      user: accountAddressToScVal(user),
      offset: xdr.ScVal.scvU32(offset),
      limit: xdr.ScVal.scvU32(limit),
    });

    const val = res?.result !== undefined ? res.result : res;
    if (!val) return [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let items: any[] = [];
    if (Array.isArray(val)) {
      items = val;
    } else if (typeof val.switch === 'function' && val.arm() === 'vec') {
      items = val.value() || [];
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return items.map((item: any) => {
      let itemUser = user;
      let itemAmount = '0';
      let itemQuoteId = '';
      let itemTimestamp = 0;

      if (item && typeof item === 'object') {
        if (item.user) {
          try {
            if (typeof item.user === 'string') {
              itemUser = item.user;
            } else if (typeof item.user.switch === 'function') {
              itemUser = Address.fromScVal(item.user).toString();
            }
          } catch {
            itemUser = user;
          }
        }
        if (item.amount !== undefined) {
          itemAmount = scValToBigIntValue(item.amount).toString();
        }
        if (item.quote_id !== undefined || item.quoteId !== undefined) {
          const q = item.quote_id ?? item.quoteId;
          itemQuoteId = typeof q === 'string' ? q : q?.toString() || '';
        }
        if (item.timestamp !== undefined) {
          itemTimestamp = Number(scValToBigIntValue(item.timestamp));
        }
      }

      return {
        user: itemUser,
        amount: itemAmount,
        amountUsdc: stroopsToUsdc(itemAmount),
        quoteId: itemQuoteId,
        timestamp: itemTimestamp,
      };
    });
  } catch (err) {
    logger.warn(
      `[escrow] getEscrowUsage failed for user ${user.slice(0, 8)}... — Error: ${(err as Error).message}`,
    );
    return [];
  }
}

/**
 * Charge a user's escrow balance for actual LLM usage.
 *
 * Idempotent per (user, quoteId): the contract's `charge()` function uses a
 * `(CHARGED, user, quote_id)` guard so a retried settlement call can never
 * double-deduct.
 */
export async function chargeEscrow(options: EscrowChargeOptions): Promise<EscrowResult> {
  const { contractId, rpcUrl, networkPassphrase, adminSecret, user, amount, quoteId } = options;

  try {
    const adminKeypair = Keypair.fromSecret(adminSecret);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { contract } = await import('@stellar/stellar-sdk');
    const { Client } = contract;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = await Client.from({ contractId, rpcUrl, networkPassphrase });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx: any = await client.charge({
      user: accountAddressToScVal(user),
      amount: amountToScVal(amount),
      quote_id: xdr.ScVal.scvString(quoteId),
    });

    if (typeof tx.signAuthEntries === 'function') {
      tx.signAuthEntries(adminKeypair);
    }
    tx.sign(adminKeypair);
    await tx.send();

    logger.info('[escrow] Charge settled on-chain', {
      user: user.slice(0, 8),
      amount,
      quoteId: quoteId.slice(0, 8),
    });
    return { success: true };
  } catch (err) {
    // Best-effort: escrow settlement must never block the LLM response.
    const message = (err as Error).message;
    logger.warn(
      `[escrow] chargeEscrow failed for user ${user.slice(0, 8)}... — ` +
        `skipping on-chain settlement. Error: ${message}`,
    );
    return { success: false, error: message };
  }
}

/**
 * Refund a surplus back to a user's escrow balance.
 *
 * Idempotent per (user, quoteId): the contract's `refund()` function uses a
 * `(REFUNDED, user, quote_id)` guard so a retried refund can never double-pay.
 */
export async function refundEscrow(options: EscrowRefundOptions): Promise<EscrowResult> {
  const { contractId, rpcUrl, networkPassphrase, adminSecret, user, amount, quoteId } = options;

  try {
    const adminKeypair = Keypair.fromSecret(adminSecret);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { contract } = await import('@stellar/stellar-sdk');
    const { Client } = contract;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = await Client.from({ contractId, rpcUrl, networkPassphrase });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx: any = await client.refund({
      user: accountAddressToScVal(user),
      amount: amountToScVal(amount),
      quote_id: xdr.ScVal.scvString(quoteId),
    });

    if (typeof tx.signAuthEntries === 'function') {
      tx.signAuthEntries(adminKeypair);
    }
    tx.sign(adminKeypair);
    await tx.send();

    logger.info('[escrow] Refund settled on-chain', {
      user: user.slice(0, 8),
      amount,
      quoteId: quoteId.slice(0, 8),
    });
    return { success: true };
  } catch (err) {
    const message = (err as Error).message;
    logger.warn(
      `[escrow] refundEscrow failed for user ${user.slice(0, 8)}... — ` +
        `skipping on-chain refund. Error: ${message}`,
    );
    return { success: false, error: message };
  }
}

/**
 * Full settlement: charge actual cost from escrow, then refund any surplus.
 *
 * This is the high-level entry point wired into `applyMeteredPricing()`. It
 * gates on `escrowSettlementEnabled` and `contractAdminSecret` — if either is
 * missing the call is a silent no-op so the feature can be configured but not
 * active in every deployment.
 */
export async function settleEscrow(options: {
  enabled: boolean;
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  adminSecret?: string;
  user: string;
  actualCost: string;
  surplus: string;
  isOverpaid: boolean;
  quoteId: string;
}): Promise<void> {
  if (!options.enabled || !options.adminSecret) return;

  const {
    contractId,
    rpcUrl,
    networkPassphrase,
    adminSecret,
    user,
    actualCost,
    surplus,
    isOverpaid,
    quoteId,
  } = options;

  // Charge the actual cost from the user's escrow balance.
  // Idempotent — retrying the same quote never double-charges.
  const chargeResult = await chargeEscrow({
    contractId,
    rpcUrl,
    networkPassphrase,
    adminSecret,
    user,
    amount: actualCost,
    quoteId,
  });

  if (!chargeResult.success) {
    logger.warn('[escrow] Charge failed, skipping refund', {
      user: user.slice(0, 8),
      actualCost,
      error: chargeResult.error,
    });
    return;
  }

  // Refund surplus when the caller overpaid (per-token deposit > actual cost).
  if (isOverpaid && BigInt(surplus) > 0n) {
    await refundEscrow({
      contractId,
      rpcUrl,
      networkPassphrase,
      adminSecret,
      user,
      amount: surplus,
      quoteId,
    });
  }
}
