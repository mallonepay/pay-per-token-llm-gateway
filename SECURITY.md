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
- Stellar secret keys are **never** stored server-side. The gateway only uses public keys to verify payments.

### Audit

All payment verifications, request forwarding, and admin actions are logged to the `AuditLog` table for forensic analysis.

## Security Checklist for Production

- [ ] Use a dedicated Horizon/Soroban RPC provider with API keys
- [ ] Enable Redis persistence (AOF)
- [ ] Run behind Cloudflare/NGINX with rate limiting
- [ ] Set up monitoring alerts for failed verifications
- [ ] Rotate JWT secrets regularly
- [ ] Use separate Stellar accounts for receiving payments vs. payouts
- [ ] Implement withdrawal limits for provider payouts
- [ ] Regular security audits of the codebase
