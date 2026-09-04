# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in the x402 LLM Gateway, please report it responsibly.

**Do not open a public GitHub issue.**

Instead, [open a private security advisory](https://github.com/Pay-Per-Token-LLM-Gateway/pay-per-token-llm-gateway/security/advisories/new) or email the maintainers with:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will respond within 48 hours and work with you on a fix.

## Security Model

### Trust Assumptions

1. **Stellar blockchain is the single source of truth** — all payments are verified on-chain
2. **Client payment proofs are never trusted** — Horizon/Soroban RPC queries are mandatory
3. **Upstream LLM API keys are server-side only** — never exposed to callers

### Replay Protection

Transaction hashes are tracked in Redis (or PostgreSQL) with a TTL. The same transaction cannot be used for multiple requests. In production, use Redis persistence (AOF/RDB) to survive restarts.

### Rate Limiting

Unpaid 402 requests are rate-limited by caller IP address (wallet-address-based rate limiting is not yet implemented). This prevents quote-spam and resource exhaustion attacks.

### Key Management

- Upstream LLM API keys are environment variables: `UPSTREAM_API_KEY_<PROVIDER_ID>`
- JWT secrets must be at least 256 bits
- Payment verification uses only public keys — no Stellar secret is needed to _verify_ payments
- `CONTRACT_ADMIN_SECRET` (the key that records payments on-chain and settles escrow) **is** stored server-side in the gateway environment. Custody matters: keep it in a secret manager, fund it with XLM, and rotate it like any other signing key.

### Audit

All payment verifications, request forwarding, and admin actions are logged to the `AuditLog` table for forensic analysis.

## Known Residual Risks

Accepted, documented limitations as of September 2026. These are on the
mainnet go/no-go path or consciously deferred — see
[`MAINNET_READINESS.md`](./MAINNET_READINESS.md) for the full gate.

1. **Soroban contracts are not independently audited.** payment-verifier,
   credit-escrow, and multisig are self-tested only (23 / 43 / 32 unit tests,
   no property/fuzz suite, no external review). An independent audit is
   required before handling real USDC on mainnet.
2. **Rate limiting is per IP only.** Wallet-address-based limiting is not
   implemented. Callers behind a shared NAT can rotate through addresses to
   evade it; single-use payment enforcement (atomic DB claim + Redis + on-chain
   replay guards) is the stronger backstop.
3. **Per-entry persistent storage TTLs.** Soroban records (payment audit
   trail, escrow balances/usage, multisig proposals) each carry their own TTL,
   refreshed on write. An entry untouched for ~1M ledgers after its last write
   may require a paid restore-from-archive read to be read again.
4. **Verification is fail-closed.** If Horizon errors or times out during
   payment verification the request fails with a 5xx — valid payments are
   never falsely accepted, but a Horizon outage blocks all paid traffic until
   it recovers. Use dedicated RPC providers and monitor verification failures.
5. **Mainnet safety depends on operator config.** `STELLAR_NETWORK`, Horizon /
   Soroban RPC URLs, the network passphrase, and the USDC issuer are
   operator-set. A "mainnet" gateway pointed at testnet endpoints would verify
   worthless testnet payments and serve real LLM compute for them.
6. **Underpayment settlement is gateway-side, not on-chain.** Per-token
   debt gating runs in the gateway DB (testnet-appropriate); on-chain escrow
   settlement is opt-in and experimental.

## Security Checklist for Production

- [ ] Use a dedicated Horizon/Soroban RPC provider with API keys
- [ ] Enable Redis persistence (AOF)
- [ ] Run behind Cloudflare/NGINX with rate limiting
- [ ] Set up monitoring alerts for failed verifications
- [ ] Rotate JWT secrets regularly
- [ ] Use separate Stellar accounts for receiving payments vs. payouts
- [ ] Implement withdrawal limits for provider payouts
- [ ] Regular security audits of the codebase
