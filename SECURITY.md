# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in the x402 LLM Gateway, please report it responsibly.

**Do not open a public GitHub issue.**

Instead, [open a private security advisory](https://github.com/mallonepay/pay-per-token-llm-gateway/security/advisories/new) or email the maintainers with:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will respond within 48 hours and work with you on a fix.

## Security Documentation

- **[`THREAT-MODEL.md`](./THREAT-MODEL.md)** — full threat model: assets,
  trust boundaries, and per-threat mitigations across the gateway,
  contracts, SDK, and dashboard (updated 2026-09-08).
- **[`AUDIT.md`](./AUDIT.md)** — audit findings ledger with verification
  evidence.
- **[`audits/2026-10-soroban-custody-security-audit.md`](./audits/2026-10-soroban-custody-security-audit.md)** — external security audit of `credit-escrow` and `payment-verifier` custody contracts (Issue #83).
- **[`MAINNET_READINESS.md`](./MAINNET_READINESS.md)** — the go/no-go gate
  for a Stellar mainnet launch.
- **[`OPERATIONS.md`](./OPERATIONS.md)** — RTO/RPO, backup/restore, disaster
  recovery, runbooks.

## Security Model

### Trust Assumptions

1. **Stellar blockchain is the single source of truth** — all payments are verified on-chain
2. **Client payment proofs are never trusted** — Horizon/Soroban RPC queries are mandatory
3. **Upstream LLM API keys are server-side only** — never exposed to callers

### Replay Protection (single-use payments)

Transaction hashes are consumed through **three independent layers**:

1. **Redis** — atomic `SET NX` claim (`x402:replay:*`, TTL `PAYMENT_CACHE_TTL`);
2. **On-chain** — the Soroban `payment-verifier` `USED_TX` guard (permanent,
   survives Redis loss, shared across gateway instances);
3. **PostgreSQL** — atomic `updateMany({ txHash: null })` + unique index.

Any one layer rejecting is sufficient to refuse access. In production, run
Redis with AOF persistence so restart windows are minimized.

### Payment verification invariants

- Amount matches the pricing model (flat: exact; per-token: ≥ deposit).
- Asset **and** issuer match the quote (`USDC_ISSUER`); mainnet refuses a
  non-Circle issuer at boot.
- The payment timestamp must fall **inside** `[quote.issuedAt, quote.expiresAt]`
  — payments made before the quote was issued (historical-hash reuse) or
  after it expired are rejected.
- Mainnet accepts direct `payment` operations only (no path payments).
- All Horizon/Soroban RPC fetches are timeout-bounded (default 10 s) — a hung
  chain endpoint can never hold a request open indefinitely.

### Rate Limiting

Unpaid 402 requests are rate-limited by caller IP (sliding window, Redis Lua).
Requests carrying a **confirmed** payment hash get a higher tier keyed by the
**server-verified payer wallet** (the `payerAddress` Horizon recorded on the
confirmed payment row) — the mere presence of a header never raises the limit,
and a caller cannot mint fresh buckets by rotating source IPs. Header-supplied
identities (`x-caller-address`, `x-escrow-user`) are never used for the key.

Proxy trust is **off by default**: `TRUST_PROXY` must be set explicitly (e.g.
`1` or `loopback`) when the gateway really runs behind a trusted reverse proxy.
A directly-exposed gateway therefore ignores `X-Forwarded-For` entirely, and a
production start with it unset logs a prominent warning.

### Payout concurrency (no double payouts)

Provider payouts are proposed against a `PayoutProposal` ledger. Pending
revenue is `sum(confirmed payments) − sum(reserving proposals)`, and the row
that _reserves_ it is written after an on-chain round-trip — so two writers
that interleave inside that window both read the same reserved total and both
reserve the whole balance. With a threshold-1 multisig wallet both proposals
auto-execute and the provider is paid twice for one revenue stream.

Both writers therefore serialise on a **per-provider Redis lock**
(`x402:lock:payout-propose:<providerId>`, `SET NX` + TTL, released with a
compare-and-delete Lua script so only the owner can release it):

- the daily payout `@Cron`, which NestJS fires in **every** replica — the
  Kubernetes manifest runs 2 gateway replicas and scaling up is the documented
  way to add capacity;
- `POST /api/v1/admin/payouts/propose`, where a double-submit or a client
  retry after a timeout repeats the read-modify-write.

Because the key is per provider, the two callers exclude each other and
unrelated providers remain independent. The guard **fails closed**: if the
lock cannot be acquired (Redis unreachable) the proposal is refused —
`409` when another proposal for that provider is already in flight, `503` when
the coordination store is unavailable. A refused proposal loses nothing (the
revenue stays `confirmed` and is proposed later); a duplicate one moves money
no revenue backs.

### Key Management

- Upstream LLM API keys are environment variables: `UPSTREAM_API_KEY_<PROVIDER_ID>`
- JWT secrets must be at least 256 bits; the gateway refuses to boot with a
  missing or known-placeholder `JWT_SECRET`.
- `AUTH_DEV_MODE=true` (any-wallet dev signature bypass) is refused at boot
  when `NODE_ENV=production`.
- Payment verification uses only public keys — no Stellar secret is needed to _verify_ payments
- `CONTRACT_ADMIN_SECRET` (records payments on-chain and settles escrow) is
  stored server-side. Custody matters: keep it in a secret manager, fund it
  with XLM, and rotate it like any other signing key.

### Audit

All payment verifications, request forwarding, debt events, and admin
actions are logged to the `AuditLog` table for forensic analysis; the on-chain
`payment-verifier` contract keeps an immutable audit trail of every recorded
payment.

## Automated security scanning (CI)

| Scan                                      | Tool                      | Gate                                                                |
| ----------------------------------------- | ------------------------- | ------------------------------------------------------------------- |
| npm/pnpm advisories                       | `pnpm audit`              | **fail on critical**; high+ reported                                |
| Secret scanning (full git history)        | gitleaks                  | **fail on any leak**                                                |
| Container/filesystem vulnerabilities      | trivy (fs, HIGH/CRITICAL) | report → GitHub Security tab (SARIF)                                |
| Lockfile vulnerability scan (npm + cargo) | osv-scanner               | report                                                              |
| SBOM (CycloneDX, per release)             | anchore sbom-action       | release asset                                                       |
| Install-script allowlist                  | pnpm `allowBuilds`        | only prisma/esbuild/nx/@nestjs-core/@parcel-watcher may run scripts |

Dependency posture (2026-09-09): **0 critical** and **0 runtime-reachable**
advisories. The gateway runs **NestJS 11.2.3 on Express 5.2.1** (with multer
**2.3.0** via override — the 2026 DoS CVEs affect <2.3.0) and the dashboard
runs **Next 15.5.25 + React 19** — the three previously-tracked major-version
residuals are resolved, the nx 22 migration cleared the remaining
dev-tooling track (`brace-expansion` fixed via scoped override), and
`svgo` was bumped to 3.3.5 (ReDoS patched) via a scoped override. `pnpm
audit` now reports **2 high advisories, both `image-size`** — dev/build-tooling
only, via the unused `@nx/vite`→less chain, no patched release exists, no
runtime-reachable path — see `MAINNET_READINESS.md` §7.

## Known Residual Risks

Accepted, documented limitations as of September 2026. These are on the
mainnet go/no-go path or consciously deferred — see
[`MAINNET_READINESS.md`](./MAINNET_READINESS.md) for the full gate.

1. **Soroban contracts are not independently audited.** payment-verifier,
   credit-escrow, and multisig are self-tested only (29 / 46 / 36 unit tests —
   111 total, verified 2026-09-14 with rustc 1.98.1 — and no external review).
   An independent audit is required before handling real USDC on mainnet.
2. **Per-IP rate limiting for unpaid requests.** The paid tier is now keyed by
   the verified payer wallet, but the unpaid 402 tier is still keyed by client IP
   — callers behind a shared NAT or rotating addresses can spread unpaid quote
   spam across many IPs. Single-use payment enforcement (atomic DB claim + Redis +
   on-chain replay guards) remains the stronger backstop.
3. **Dev/build-tooling advisories remain** (2 high, both `image-size` — no
   patched release exists; via the unused `@nx/vite`→less chain). Build-time
   only, never shipped to runtime, with no runtime-reachable path. Tracked in
   `MAINNET_READINESS.md` §7.
4. **Per-entry persistent storage TTLs.** Soroban records each carry their
   own TTL, refreshed on write. An entry untouched for ~1M ledgers after its
   last write may require a paid restore-from-archive read to be read again.
5. **Verification is fail-closed.** If Horizon errors or times out during
   payment verification the request fails with a 5xx — valid payments are
   never falsely accepted, but a Horizon outage blocks all paid traffic until
   it recovers. Use dedicated RPC providers and monitor verification failures.
6. **Mainnet safety depends on operator config.** `STELLAR_NETWORK`, Horizon /
   Soroban RPC URLs, the network passphrase, and the USDC issuer are
   operator-set. A "mainnet" gateway pointed at testnet endpoints would verify
   worthless testnet payments and serve real LLM compute for them (boot-time
   consistency guard enforced in `packages/config`).
7. **Underpayment settlement is gateway-side, not on-chain.** Per-token
   debt gating runs in the gateway DB (testnet-appropriate); on-chain escrow
   settlement is opt-in and experimental.
8. **Quote front-running is griefing-only.** A third party can pay a victim's
   quote first (the attacker loses real funds; the victim re-quotes). Memo
   enforcement is deliberately off.
9. ~~**`init()` could be front-run between deploy and initialization**~~ —
   **fixed 2026-09-14.** Initialization is now a Soroban `__constructor`, so it
   runs inside the `deploy` transaction and there is no window in which anyone
   else could initialize a freshly created contract with their own `admin` or
   single-signer set. The separate `init` entry point was **removed from all
   three contracts** rather than kept as a legacy path, so an instance can no
   longer be initialized after deployment at all.

   This is worth recording because the obvious fix does not work: adding
   `admin.require_auth()` to `init` would not have helped — the address is a
   caller-supplied parameter, so an attacker names _and signs_ their own, and
   `require_auth` only ever proves the caller controls the address they
   supplied, never that they are the deployer. Moving initialization into the
   constructor is what actually closes the hole; as a side benefit it also
   removes the "deployed but never initialized" failure mode, since a contract
   whose constructor rejects its arguments now fails the deploy outright.

   `scripts/deploy-contracts.sh` passes each contract's constructor arguments
   to `stellar contract deploy` (`-- <args>`), so deploy + initialize remain a
   single transaction operationally. Contract tests were updated accordingly
   (111 pass); there is no on-chain state to migrate, so the next deployment
   simply uses the new path.

10. **The SSRF guard validates a DNS answer, then `fetch` resolves again.**
    Both the upstream-proxy and webhook paths resolve the hostname, check that
    every answer is a public IP (`isPublicIp`), and then hand the _hostname_ to
    `fetch` — which performs its own, separate resolution. A provider who
    controls the hostname can answer public during the check and private during
    the connect (classic DNS-rebinding TOCTOU); the 60 s check cache narrows the
    window but does not close it. Closing it properly means pinning the socket
    to the validated address (an undici `Agent` with a validating `lookup`, or
    `https.request` with `lookup` + `servername`), which is a follow-up rather
    than something this repository does today. The IPv6 classification gap that
    made internal addresses reachable _without_ any rebinding — `::`, multicast,
    Teredo, NAT64 and 6to4-with-embedded-private-IPv4 were all reported public —
    **was** fixed on 2026-09-15 (see `docs/VERIFICATION.md` §8 #18).

## Security Checklist for Production

- [ ] Use a dedicated Horizon/Soroban RPC provider with API keys
- [ ] Enable Redis persistence (AOF)
- [ ] Run behind Cloudflare/NGINX with TLS and the correct `TRUST_PROXY` setting
- [ ] Set up monitoring alerts for failed verifications (OBSERVABILITY.md A1–A7)
- [ ] Rotate JWT secrets regularly
- [ ] Use separate Stellar accounts for receiving payments vs. payouts
- [ ] Implement withdrawal limits for provider payouts
- [ ] Fund `CONTRACT_ADMIN_SECRET`'s account with XLM and alert on low balance
- [x] Regular security audits of the codebase + external contract audit before mainnet (completed in [`audits/2026-10-soroban-custody-security-audit.md`](./audits/2026-10-soroban-custody-security-audit.md))
