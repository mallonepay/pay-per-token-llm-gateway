//! Property-based tests (deterministic, seeded — no external fuzz runner).
//!
//! These assert algebraic invariants over randomized inputs, mirroring the
//! deterministic property suites in the TypeScript packages (seeded PRNG,
//! fixed iteration counts):
//!
//!   - pagination window math: for random (offset, limit) pairs the returned
//!     page length is exactly `clamp(offset.saturating_add(limit.min(100)),
//!     count) - offset`, and walking a random page size from 0 recovers
//!     EVERY record exactly once (no overlap, no gap);
//!   - replay-set semantics: after K records, exactly the K recorded hashes
//!     report `is_payment_used == true`, `total_payments() == K`, and each
//!     hash round-trips to the exact recorded amount/asset/quote;
//!   - amount integrity: every recorded i128 amount is returned verbatim
//!     (no lossy conversion anywhere in the read path).
//!
//! A fixed seed keeps failures reproducible: any failing property re-runs
//! with the same inputs.

use crate::{PaymentVerifier, PaymentVerifierClient};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env, String};

// The contract crate is #![no_std]; tests link std (the harness needs it).
#[cfg(test)]
extern crate std;
use std::format;

// ── Seeded PRNG (xorshift64) ─────────────────

struct Prng(u64);

impl Prng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    /// Uniform value in `0..=bound`.
    fn below(&mut self, bound: u64) -> u64 {
        if bound == 0 {
            return 0;
        }
        self.next() % (bound + 1)
    }
}

const ITERATIONS: usize = 200;
const MAX_PAGE_SIZE: u32 = 50;

fn setup_env() -> (Env, Address, PaymentVerifierClient<'static>) {
    let env = Env::default();
    let admin = Address::generate(&env);
    let contract_id = env.register(PaymentVerifier, (&admin,));
    let client = PaymentVerifierClient::new(&env, &contract_id);
    (env, admin, client)
}

fn record(
    client: &PaymentVerifierClient,
    payer: &Address,
    payee: &Address,
    hash: &str,
    amount: i128,
    quote: &str,
) {
    client.mock_all_auths().record_payment(
        &String::from_str(&client.env, hash),
        payer,
        payee,
        &amount,
        &String::from_str(&client.env, "USDC"),
        &1_757_347_200u64,
        &String::from_str(&client.env, quote),
    );
}

/// Expected page length for the contract's window math:
/// `end = offset.saturating_add(limit.min(MAX_PAGE_SIZE)).min(count)`,
/// returning `end - offset` when the window overlaps `[0, count)` else 0.
fn expected_page_len(offset: u32, limit: u32, count: u32) -> u32 {
    if offset >= count {
        return 0;
    }
    let end = offset
        .saturating_add(limit.min(MAX_PAGE_SIZE))
        .min(count);
    end - offset
}

#[test]
fn prop_pagination_window_length_for_random_offsets_and_limits() {
    let mut prng = Prng(0x5eed_4024_0000_0001);
    let (env, _admin, client) = setup_env();
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);

    // Grow the history once, then probe random windows.
    for i in 0..120u32 {
        record(&client, &payer, &payee, &format!("paging-tx-{:03}", i), (i as i128 + 1) * 1_000, &format!("paging-q-{:03}", i));
    }
    let count = client.total_payments();
    assert_eq!(count, 120);

    for _ in 0..ITERATIONS {
        let offset = prng.below(300) as u32; // includes offsets past the end
        let limit = prng.below(500) as u32; // includes limits past MAX_PAGE_SIZE
        let page = client.get_payments(&offset, &limit);
        assert_eq!(
            page.len(),
            expected_page_len(offset, limit, count),
            "page length for offset={offset} limit={limit} count={count}"
        );
    }

    // Saturation: offset + limit overflowing u32 must not panic and must
    // clamp to the end of history (window math uses saturating_add).
    let page = client.get_payments(&(u32::MAX - 1), &u32::MAX);
    assert_eq!(page.len(), 0);
    let page = client.get_payments(&119, &u32::MAX);
    assert_eq!(page.len(), 1);
}

#[test]
fn prop_walking_pages_recovers_every_record_exactly_once() {
    let mut prng = Prng(0x5eed_4024_0000_0002);
    let (env, _admin, client) = setup_env();
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);

    let n = 1 + prng.below(120) as u32;
    let mut expected_amounts: std::vec::Vec<i128> = std::vec::Vec::new();
    for i in 0..n {
        let amount = ((i as i128 + 1) * 1_000_000) + (i as i128 * 7);
        expected_amounts.push(amount);
        record(&client, &payer, &payee, &format!("walk-tx-{:03}", i), amount, &format!("walk-q-{:03}", i));
    }

    // Walk from 0 with a random page size until the walk exits the history.
    let page_size = 1 + prng.below(MAX_PAGE_SIZE as u64) as u32;
    let mut collected: std::vec::Vec<i128> = std::vec::Vec::new();
    let mut offset = 0u32;
    loop {
        let page = client.get_payments(&offset, &page_size);
        assert!(page.len() <= MAX_PAGE_SIZE);
        if page.len() == 0 {
            break;
        }
        for j in 0..page.len() {
            let p = page.get(j).unwrap();
            collected.push(p.amount);
        }
        offset += page.len() as u32;
    }

    assert_eq!(
        offset, n,
        "the walk must terminate exactly at the end of history (no gap)"
    );
    assert_eq!(
        collected.len(),
        n as usize,
        "every record visited exactly once (no overlap)"
    );
    for (got, want) in collected.iter().zip(expected_amounts.iter()) {
        assert_eq!(got, want, "records must be returned in insertion order");
    }
}

#[test]
fn prop_replay_set_exactly_matches_recorded_hashes() {
    let mut prng = Prng(0x5eed_4024_0000_0003);
    let (env, _admin, client) = setup_env();
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);

    let k = 1 + prng.below(50) as u32;
    let mut hashes: std::vec::Vec<std::string::String> = std::vec::Vec::new();
    for i in 0..k {
        let hash = format!("replay-tx-{:03}", i);
        record(&client, &payer, &payee, &hash, (i as i128 + 1) * 100, &format!("replay-q-{:03}", i));
        hashes.push(hash);
    }

    // Exactly the recorded hashes are marked used.
    for hash in hashes.iter() {
        assert!(
            client.is_payment_used(&String::from_str(&env, hash)),
            "recorded hash {hash} must be marked used"
        );
    }
    // Fresh hashes are not.
    for i in 0..k {
        let fresh = format!("replay-fresh-{:03}", i);
        assert!(
            !client.is_payment_used(&String::from_str(&env, &fresh)),
            "never-recorded hash {fresh} must not be marked used"
        );
    }

    assert_eq!(client.total_payments(), k);

    // Every recorded hash round-trips to its exact record.
    for (i, hash) in hashes.iter().enumerate() {
        let payment = client
            .get_payment(&String::from_str(&env, hash))
            .expect("recorded hash must resolve");
        assert_eq!(payment.amount, (i as i128 + 1) * 100);
        assert_eq!(payment.asset, String::from_str(&env, "USDC"));
        assert_eq!(payment.quote_id, String::from_str(&env, &format!("replay-q-{:03}", i)));
        assert!(payment.verified);
        assert!(!payment.refunded);
    }

    // A recorded hash cannot be recorded a second time (replay guard holds
    // across the whole randomized set).
    let replay = client.try_record_payment(
        &String::from_str(&env, &hashes[0]),
        &payer,
        &payee,
        &1_000i128,
        &String::from_str(&env, "USDC"),
        &1_757_347_200u64,
        &String::from_str(&env, "replay-q-reuse"),
    );
    assert!(replay.is_err(), "re-recording a used hash must be rejected");
    assert_eq!(client.total_payments(), k);
}

#[test]
fn prop_amounts_round_trip_exactly() {
    let mut prng = Prng(0x5eed_4024_0000_0004);
    let (env, _admin, client) = setup_env();
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);

    for i in 0..ITERATIONS as u32 {
        // Random i128 amounts across the full positive range, including
        // values near i128::MAX that stress serialization width. Base ≤ 1e7
        // and magnitude ≤ 30 keep base × 10^mag ≤ 1e37 < i128::MAX so the
        // multiplication itself can never overflow.
        let magnitude = prng.below(30) as u32; // 10^0 .. 10^30
        let base = (1 + prng.below(9_999_999) as i128) as i128;
        let amount = base * 10i128.pow(magnitude);
        let hash = format!("amt-tx-{:04}", i);
        record(&client, &payer, &payee, &hash, amount, &format!("amt-q-{:04}", i));
        let payment = client
            .get_payment(&String::from_str(&env, &hash))
            .expect("recorded hash must resolve");
        assert_eq!(payment.amount, amount, "amount must round-trip exactly");
    }
}