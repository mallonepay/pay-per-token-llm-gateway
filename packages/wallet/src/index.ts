// ──────────────────────────────────────────────
// @x402/wallet — Stellar wallet utilities
// ──────────────────────────────────────────────

import {
  Keypair,
  TransactionBuilder,
  Operation,
  Asset,
  Networks,
  Horizon,
  BASE_FEE,
  Memo,
  MemoText,
} from '@stellar/stellar-sdk';
import type { StellarNetwork, StellarAddress, TxHash, PaymentAsset } from '@x402/types';
import { logger } from '@x402/logger';

// ── Key Management ───────────────────────────

/** Generate a new Stellar keypair */
export function generateKeypair(): { publicKey: StellarAddress; secretKey: string } {
  const kp = Keypair.random();
  return {
    publicKey: kp.publicKey(),
    secretKey: kp.secret(),
  };
}

/** Parse a Stellar address from a public key */
export function keypairFromSecret(secret: string): Keypair {
  return Keypair.fromSecret(secret);
}

// ── Network Configuration ────────────────────

export function getNetworkPassphrase(network: StellarNetwork): string {
  switch (network) {
    case 'mainnet':
      return Networks.PUBLIC;
    case 'testnet':
      return Networks.TESTNET;
    case 'futurenet':
      return Networks.FUTURENET;
  }
}

export function getHorizonUrl(network: StellarNetwork): string {
  switch (network) {
    case 'mainnet':
      return 'https://horizon.stellar.org';
    case 'testnet':
      return 'https://horizon-testnet.stellar.org';
    case 'futurenet':
      return 'https://horizon-futurenet.stellar.org';
  }
}

export function getSorobanRpcUrl(network: StellarNetwork): string {
  switch (network) {
    case 'mainnet':
      return 'https://soroban-mainnet.stellar.org';
    case 'testnet':
      return 'https://soroban-testnet.stellar.org';
    case 'futurenet':
      return 'https://rpc-futurenet.stellar.org';
  }
}

// ── Payment Transaction Builder ──────────────

export interface BuildPaymentOptions {
  sourceSecret: string;
  destination: StellarAddress;
  amount: string;
  asset: PaymentAsset;
  assetIssuer?: string;
  memo?: string;
  network: StellarNetwork;
  horizonUrl: string;
}

export interface BuildUnsignedPaymentOptions {
  sourcePublicKey: StellarAddress;
  destination: StellarAddress;
  amount: string;
  asset: PaymentAsset;
  assetIssuer?: string;
  memo?: string;
  network: StellarNetwork;
  horizonUrl: string;
}

/**
 * Build and sign a Stellar payment transaction.
 * Returns the signed transaction XDR and the transaction hash.
 */
export async function buildPaymentTransaction(
  options: BuildPaymentOptions,
): Promise<{ txXdr: string; txHash: TxHash }> {
  const { sourceSecret, destination, amount, asset, assetIssuer, memo, network, horizonUrl } =
    options;

  const sourceKeypair = Keypair.fromSecret(sourceSecret);
  const unsigned = await buildUnsignedPaymentTransaction({
    sourcePublicKey: sourceKeypair.publicKey(),
    destination,
    amount,
    asset,
    assetIssuer,
    memo,
    network,
    horizonUrl,
  });

  // Re-hydrate the transaction so we can sign it
  const tx = TransactionBuilder.fromXDR(unsigned.txXdr, getNetworkPassphrase(network));
  tx.sign(sourceKeypair);

  return {
    txXdr: tx.toXDR(),
    txHash: tx.hash().toString('hex'),
  };
}

/**
 * Build an unsigned Stellar payment transaction for external signing.
 *
 * Returns the unsigned transaction XDR so the caller can pass it to an
 * external signer (browser wallet extension, hardware wallet, agent SDK).
 * After signing, submit the signed XDR via {@link createHorizonServer} and
 * `server.submitTransaction(signedXdr)`.
 */
export async function buildUnsignedPaymentTransaction(
  options: BuildUnsignedPaymentOptions,
): Promise<{ txXdr: string; txHash: TxHash }> {
  const { sourcePublicKey, destination, amount, asset, assetIssuer, memo, network, horizonUrl } =
    options;

  const server = new Horizon.Server(horizonUrl);
  const sourceAccount = await server.loadAccount(sourcePublicKey);
  const passphrase = getNetworkPassphrase(network);

  let stellarAsset: Asset;
  if (asset === 'XLM') {
    stellarAsset = Asset.native();
  } else if (asset === 'USDC' && assetIssuer) {
    stellarAsset = new Asset(asset, assetIssuer);
  } else {
    throw new Error(`Unsupported asset or missing issuer: ${asset}`);
  }

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: passphrase,
  })
    .addOperation(
      Operation.payment({
        destination,
        asset: stellarAsset,
        amount,
      }),
    )
    .setTimeout(300);

  if (memo) {
    tx.addMemo(new Memo(MemoText, memo));
  }

  const built = tx.build();

  return {
    txXdr: built.toXDR(),
    txHash: built.hash().toString('hex'),
  };
}

// ── Horizon Helpers ──────────────────────────

/**
 * Create a Horizon server instance for the given network.
 */
export function createHorizonServer(
  network: StellarNetwork = 'testnet',
  customUrl?: string,
): Horizon.Server {
  const url = customUrl || getHorizonUrl(network);
  return new Horizon.Server(url);
}

/**
 * Check if a Stellar account exists on the network.
 */
export async function accountExists(
  address: StellarAddress,
  server: Horizon.Server,
): Promise<boolean> {
  try {
    await server.loadAccount(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get account balances for a Stellar address.
 */
export async function getAccountBalances(
  address: StellarAddress,
  server: Horizon.Server,
): Promise<Array<{ asset: string; balance: string; issuer?: string }>> {
  try {
    const account = await server.loadAccount(address);
    return account.balances.map((b: Horizon.HorizonApi.BalanceLine) => ({
      asset: b.asset_type === 'native' ? 'XLM' : (b as Horizon.HorizonApi.BalanceLineAsset).asset_code,
      balance: b.balance,
      issuer:
        b.asset_type === 'native'
          ? undefined
          : (b as Horizon.HorizonApi.BalanceLineAsset).asset_issuer,
    }));
  } catch {
    return [];
  }
}

/**
 * Lookup a transaction by hash.
 */
export async function getTransaction(
  txHash: TxHash,
  server: Horizon.Server,
): Promise<Horizon.ServerApi.TransactionRecord | null> {
  try {
    return await server.transactions().transaction(txHash).call();
  } catch {
    return null;
  }
}

// ── Wallet Auth Signing (for dashboard login) ─

export interface SignChallengeOptions {
  secretKey: string;
  challenge: string;
  network: StellarNetwork;
}

/**
 * Sign a challenge string for wallet-based authentication.
 * Returns the signature in base64.
 */
export function signChallenge(options: SignChallengeOptions): string {
  const keypair = Keypair.fromSecret(options.secretKey);
  const message = Buffer.from(options.challenge, 'utf-8');
  const signature = keypair.sign(message);
  return signature.toString('base64');
}

/**
 * Verify a challenge signature.
 */
export function verifyChallenge(
  publicKey: StellarAddress,
  challenge: string,
  signature: string,
): boolean {
  try {
    const keypair = Keypair.fromPublicKey(publicKey);
    const message = Buffer.from(challenge, 'utf-8');
    const sigBuffer = Buffer.from(signature, 'base64');
    return keypair.verify(message, sigBuffer);
  } catch (error) {
    logger.error('Challenge verification failed', { publicKey, error: String(error) });
    return false;
  }
}
