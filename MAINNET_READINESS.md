# MAINNET_READINESS.md

> **Status: TESTNET ONLY — not mainnet-ready.** This document is the honest
> go/no-go gate for a Stellar mainnet launch of the x402 LLM Gateway. It is
> deliberately narrower than the generic _Production Checklist_ in the
> README (TLS, Redis AOF, RPC API keys, …) — that checklist is about running
> _any_ service well; this one is about the Stellar/chain-specific risks that
> determine whether real USDC can flow through the system safely.
>
> Last updated: **2026-09-04** · Applies to commit `c769a99`.

---

## 1. Audit status

| Item                             | Status                                                                                                                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Third-party smart-contract audit | **Not completed.** No external audit firm has reviewed the Soroban contracts or the gateway.                                                                                                                                   |
| Self-audit                       | `AUDIT.md` (generated 2026-08-11) is an automated self-audit. Findings it raised that were actionable have since been fixed and are reflected in this repo (see §6).                                                           |
| Test coverage (contracts)        | payment-verifier **23** · credit-escrow **43** · multisig **32** unit tests, all passing under `cargo test` (Rust 1.98 / soroban-sdk 22). Hand-written edge cases only — no property/fuzz/invariant suite, no external review. |
| Test coverage (gateway)          | Unit suites green with coverage; gateway e2e 33/33.                                                                                                                                                                            |
| Disclosure policy                | `SECURITY.md` exists but discloses **no known risks or out-of-scope items** — it reads as aspirational. It should be updated to name real residual risks (this doc is a starting point).                                       |

**Go/no-go implication:** a mainnet launch with real USDC before an
independent audit of the three contracts is a _trust decision_, not a
technical one. If the grant/audit review this repo is being prepared for
requires it, an external audit of the Soroban contracts is the single largest
unfinished item. Until then, treat the contracts as **self-tested,
unaudited** in every external communication.

---

## 2. USDC issuer & trustline risk on mainnet

### 2.1 The gateway enforces the configured issuer — so configuration is the risk

Payment verification (`packages/x402-core`) only accepts a payment operation
whose asset matches the quote **and** whose issuer matches
`quote.assetIssuer`, which is derived from `USDC_ISSUER` at quote time. A
mainnet gateway pointed at the wrong issuer would happily accept that
issuer's "USDC" — which could be a worthless or malicious token.

- Testnet default issuer: `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`
- **Mainnet must use Circle's issuer:** `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` (already set in `.env.mainnet.example`)

**Go/no-go actions:**

- [ ] Before launch, verify the quote asset issuer end-to-end on mainnet:
      submit a payment from a _wrong-issuer_ fake USDC and confirm the
      gateway returns 402 (never forwards).
- [ ] Pin `USDC_ISSUER` per environment and make the value an explicit,
      reviewed deploy artifact (CI secret), not something set ad hoc.
- [ ] Consider rejecting `path_payment_*` operations entirely (see §3) so
      the only accepted asset path is a direct `payment` of Circle USDC.

### 2.2 Trustlines on gateway-held accounts

- The gateway's receiving/payout Stellar accounts must hold a **USDC
  trustline** to Circle's issuer on mainnet before they can receive USDC in a
  classic `payment` op. Add trustline setup to the launch runbook (testnet
  accounts typically already carry one; mainnet accounts do not by default).
- The **credit-escrow contract** receives and holds USDC on behalf of users.
  The contract instance must be funded and the escrow's token must be the
  SAC of mainnet Circle USDC. Escrow settlement is currently **opt-in and
  experimental** (`ESCROW_SETTLEMENT_ENABLED`, §6) — do not enable it for
  mainnet v1 until the account-based model is a deliberate product decision
  (see §6, open issue #25).

### 2.3 Multi-issuer / asset drift

Mainnet USDC is a classic asset issued by Circle. If Circle ever migrates
issuers, the gateway has a single hardcoded `USDC_ISSUER` — there is no
multi-issuer allowlist. Treat issuer migration as a config change requiring a
coordinated cutover, not something the system adapts to automatically.

---

## 3. Fees & slippage under real network conditions

### 3.1 Who pays what

| Cost                                | Paid by                                     | Notes                                                                                                                                                                                        |
| ----------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client payment (USDC transfer)      | Client                                      | Standard Stellar network fee (base fee in XLM). Under congestion the client may need a higher fee; the gateway should not require exact fee values — only the delivered USDC amount matters. |
| `record_payment` (payment-verifier) | Gateway admin key (`CONTRACT_ADMIN_SECRET`) | A Soroban invoke per verified payment. Fee = base fee + resource (CPU/memory/ledger) fees.                                                                                                   |
| Escrow `deposit`/`charge`/`refund`  | Client / gateway                            | Only when escrow settlement is enabled (§6). Client pays deposit submission; gateway pays `charge`/`refund` invokes.                                                                         |
| Multisig payouts                    | Gateway admin / signers                     | Fee per `propose`/`approve` invoke.                                                                                                                                                          |

**Implication:** the gateway admin key must hold enough XLM to cover
Soroban resource fees for the expected request volume. Underestimating this
is a _silent availability_ failure mode: once the admin key runs out of XLM,
`record_payment` calls fail (fire-and-forget today), and the on-chain audit
trail silently stops while the gateway keeps serving requests. Budget XLM
reserves and alert on admin-key balance.

### 3.2 Slippage

- A direct USDC `payment` op has **no slippage**: the delivered amount is
  exact.
- The verifier **also accepts `path_payment_strict_send` and
  `path_payment_strict_receive` ops** and matches on the _delivered_
  destination amount. This is how a client without a direct USDC trustline
  could still pay (e.g., route XLM → USDC). Slippage on the source side is
  the client's problem; the gateway only credits what actually arrives.
  - Flat-rate quotes require an **exact** delivered-amount match — a path
    payment that lands a fraction of a stroop short is rejected.
  - Per-token quotes require the delivered amount to **cover the deposit**
    (≥), so mild under-delivery below the deposit is rejected and the
    underpayment policy (§6) then governs.
- **Recommendation:** for mainnet v1, restrict accepted ops to direct
  `payment` only. Path payments widen the attack surface for exotic-asset
  tricks and add no value when the goal is permissionless USDC access.

### 3.3 Fee spikes and minimums

- Quotes and verification are in stroops; `MIN_PAYMENT_AMOUNT` (default
  0.001 USDC) guards degenerate zero-price routes.
- Soroban resource fees can spike with ledger congestion. Contract-call
  failures must be **observable** (alerting on `record_payment`/settlement
  failure rates) even though they are currently best-effort.

---

## 4. Network & replay risk (mainnet configuration)

- Stellar signatures are scoped to the network passphrase, so a testnet
  transaction **cannot** be replayed on mainnet — cross-network replay is not
  possible at the protocol level.
- The realistic risk is **configuration drift**: a "mainnet" gateway whose
  `HORIZON_URL` / `SOROBAN_RPC_URL` / `NETWORK_PASSPHRASE` actually point at
  testnet would verify worthless testnet payments and serve real LLM compute
  for them.
- **Go/no-go action:** startup validation should fail fast if
  `STELLAR_NETWORK=mainnet` while `HORIZON_URL`/`SOROBAN_RPC_URL` are not
  mainnet endpoints or `NETWORK_PASSPHRASE` is not the mainnet passphrase
  (`Public Global Stellar Network ; September 2015`). Today this pairing is
  convention only (`scripts/deploy-contracts.sh` and config defaults pin
  endpoints per network) — consider adding an explicit runtime assertion
  before mainnet.

---

## 5. Application-layer trust items that gate mainnet

These come from the self-audit and the Phase 2 hardening work; each is either
done or an explicit decision point:

| Item                                                                                           | Status                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_DEV_MODE=true` + `NODE_ENV=production` boot refusal                                      | ✅ Done (`packages/config` guard + tests). The old any-wallet `dev-sig-` bypass can no longer reach production.                                                             |
| Per-token underpayment enforcement (deposit + outstanding-debt top-up gate, completion cap)    | ✅ Done. New `UnderpaymentDebt` Prisma model — **requires `pnpm db:push`** (repo has no migration files) before the debt-gate queries run against a real DB.                |
| Soroban contracts migrated to **persistent storage** (per-entry ledger entries, per-entry TTL) | ✅ Done, commit `c769a99`. **This changed the storage layout — mainnet MUST deploy the new WASM.** There is no mainnet state, so this is a clean redeploy, not a migration. |
| Per-entry TTL policy                                                                           | ⚠️ Deliberate tradeoff: an untouched record needs a paid restore-from-archive read after `LEDGERS_TO_LIVE` ledgers. Fine for an audit trail; document for operators.        |
| Credit-escrow settlement                                                                       | ⚠️ Opt-in, **experimental**, fire-and-forget (no enforcement without the account model). Keep disabled for mainnet v1 or make it a product decision (open issue #25).       |
| Email notifications (SMTP)                                                                     | ⚠️ Implemented but **never registered** in the dispatcher — config is inert. Decide: wire or delete before mainnet.                                                         |
| Rate limiting                                                                                  | IP-only today (self-audit M7). The README/SECURITY claim of "by IP or wallet" overstates it. Acceptable for v1 with documented limits, or add wallet-based limiting.        |
| External audit                                                                                 | ❌ Not done (see §1).                                                                                                                                                       |

---

## 6. Go / No-Go checklist

**No-go unless every box in this section is checked.** This is the launch
gate, distinct from the README's generic production checklist.

### A. Chain & contracts

- [ ] External audit of the three Soroban contracts completed (or an
      explicit, recorded decision to launch unaudited).
- [ ] Contracts deployed to mainnet **from the current WASM** (post
      persistent-storage migration) via
      `STELLAR_NETWORK=mainnet STELLAR_SECRET_KEY=S... bash scripts/deploy-contracts.sh`;
      addresses recorded in `contracts/deployed-addresses.json` under
      `mainnet` and mirrored into env config.
- [ ] Escrow contract either not deployed / not wired, or its account-based
      model accepted as a product decision.
- [ ] Admin key custody: `CONTRACT_ADMIN_SECRET` in a secret manager, never
      in git/env files; XLM reserve funded; balance alerting configured.

### B. Network configuration

- [ ] `STELLAR_NETWORK=mainnet`, mainnet `HORIZON_URL`/`SOROBAN_RPC_URL`,
      mainnet passphrase, Circle `USDC_ISSUER` — all verified consistent
      (consider the runtime assertion from §4).
- [ ] Receiving/payout accounts hold Circle USDC trustlines.
- [ ] Wrong-issuer and wrong-network payments verified to be rejected in a
      staging rehearsal before launch.

### C. Gateway & data

- [ ] `pnpm db:push` applied so the `UnderpaymentDebt` table exists; schema
      diff reviewed.
- [ ] `AUTH_DEV_MODE` unset/false in the mainnet environment (boot guard
      enforced).
- [ ] Email-notification decision made (wired, or SMTP config removed).
- [ ] Redis persistence (AOF) enabled — replay protection durability.
- [ ] Monitoring: payment-verification failure rate, contract-call failure
      rate, admin-key XLM balance, upstream LLM error rate, debt-gate denials.

### D. Product & risk posture

- [ ] Honest audit-status line published in the README (no "audited" badge).
- [ ] Known residual risks documented in `SECURITY.md` (IP-only rate
      limiting, unaudited contracts, per-entry TTL/restore semantics,
      escrow experimental).
- [ ] Provider payout flow decided: multisig contract or manual/off-chain.

---

## 7. References

- `README.md` — Production Checklist (generic infra) and Trust Model
- `AUDIT.md` — automated self-audit findings (2026-08-11)
- `SECURITY.md` — disclosure policy (needs residual-risk update)
- `.env.mainnet.example` — mainnet environment template (Circle USDC issuer
  already set)
- `scripts/deploy-contracts.sh` — network-aware deploy + address persistence
- `DEPLOYMENT.md` — full deployment walkthrough
