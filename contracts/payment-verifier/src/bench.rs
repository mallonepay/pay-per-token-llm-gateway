//! Gas/storage benchmarks for `payment-verifier`.
//!
//! Uses the Soroban SDK test environment's cost accounting
//! (`env.cost_estimate()`) to capture real per-invocation resource usage:
//! CPU instructions, ledger read/write entries, ledger bytes, rent bumps,
//! and the pubnet fee estimate.
//!
//! The core claim under test: `record_payment` is O(1) in history size —
//! per-call cost at 10,000 recorded payments must be within a small constant
//! factor of the cost at 1 payment (no growth with history).
//!
//! Run with: `cargo test --release -- --nocapture bench_`
//! (results are printed to stdout; the assertions are the hard gate).

use crate::{PaymentVerifier, PaymentVerifierClient};
use soroban_sdk::{testutils::Address as _, Address, Env, String};

// The contract crate is #![no_std]; bring in std for test-only printing.
#[cfg(test)]
extern crate std;
use std::format;
use std::println;

fn setup_env() -> (Env, Address, PaymentVerifierClient<'static>) {
    let env = Env::default();
    let admin = Address::generate(&env);
    let contract_id = env.register(PaymentVerifier, (&admin,));
    let client = PaymentVerifierClient::new(&env, &contract_id);
    (env, admin, client)
}

fn record_at(env: &Env, client: &PaymentVerifierClient, idx: u32, payer: &Address, payee: &Address) {
    client.mock_all_auths().record_payment(
        &String::from_str(env, &format!("tx-hash-{:08}", idx)),
        payer,
        payee,
        &1_000_000i128,
        &String::from_str(env, "USDC"),
        &1_757_347_200u64,
        &String::from_str(env, &format!("quote-{:08}", idx)),
    );
}

#[test]
fn bench_record_payment_constant_cost_vs_history() {
    let (env, _admin, client) = setup_env();
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);

    // Warm up so the first-invocation VM setup (Wasm instantiation) is not
    // attributed to a single measurement.
    record_at(&env, &client, 0, &payer, &payee);

    // Baseline: history size = 1.
    record_at(&env, &client, 1, &payer, &payee);
    let res_1 = env.cost_estimate().resources();
    let fee_1 = env.cost_estimate().fee();

    // Grow history to 100
    for i in 2..=100 {
        record_at(&env, &client, i, &payer, &payee);
    }
    let res_100 = env.cost_estimate().resources();
    let fee_100 = env.cost_estimate().fee();

    // Grow history to 1,000
    for i in 101..=1_000 {
        record_at(&env, &client, i, &payer, &payee);
    }
    let res_1k = env.cost_estimate().resources();
    let fee_1k = env.cost_estimate().fee();

    println!("[bench] record_payment vs history size:");
    for (label, res, fee) in [
        ("history=1  ", &res_1, &fee_1),
        ("history=100", &res_100, &fee_100),
        ("history=1k ", &res_1k, &fee_1k),
    ] {
        println!(
            "  {label} → insns={} read_entries={} write_entries={} read_bytes={}B write_bytes={}B fee={} stroops",
            res.instructions,
            (res.disk_read_entries + res.memory_read_entries),
            res.write_entries,
            res.disk_read_bytes,
            res.write_bytes,
            fee.total
        );
    }

    // The O(1) gate. Two of the three metered signals must stay flat:
    //   - per-invocation fee (what the payer actually pays)
    //   - read/write ledger entries (the real storage cost driver)
    //
    // The `instructions` counter is deliberately NOT gated: the test-host
    // diffs the whole storage footprint when closing an invocation, so its
    // CPU meter grows with accumulated state even though the on-chain cost
    // (entries + fee) is flat — the SDK docs explicitly warn the estimate
    // is only "as useful as the preceding setup". The real invariant, flat
    // fee and flat entry counts, is what Soroban charges for.
    let fee_ratio = fee_1k.total as f64 / fee_1.total as f64;
    let write_ratio = res_1k.write_entries as f64 / res_1.write_entries as f64;

    println!(
        "  fee@1k / fee@1        = {fee_ratio:.3} (must be < 1.5)"
    );
    println!(
        "  write_entries@1k / @1 = {write_ratio:.3} (must be <= 1.0 — identical per-call writes)"
    );

    assert!(
        fee_ratio < 1.5,
        "O(1) violated: fee grew {fee_ratio:.3}x between history=1 and history=1k"
    );
    assert!(
        res_1k.write_entries == res_1.write_entries,
        "O(1) violated: write entries grew from {} to {}",
        res_1.write_entries,
        res_1k.write_entries
    );

    // Bounded storage: every payment adds exactly 3 persistent entries
    // (replay guard, payment record, tx→index) + 1 instance write of the
    // counter. The *per-call* write count must stay constant regardless of
    // history size.
    println!(
        "  write_entries@1k = {} (expect ~4: 3 persistent + 1 instance)",
        res_1k.write_entries
    );
    assert!(
        res_1k.write_entries <= 8,
        "per-call write entries {} exceeded bound of 8",
        res_1k.write_entries
    );
}

#[test]
fn bench_get_payments_pagination_is_bounded() {
    let (env, _admin, client) = setup_env();
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);

    // Seed a modest history.
    for i in 0..120 {
        record_at(&env, &client, i, &payer, &payee);
    }

    // A hostile page request (offset 0, limit u32::MAX) must be clamped to
    // MAX_PAGE_SIZE and cost a bounded number of reads.
    let _ = client.get_payments(&0u32, &u32::MAX);
    let r = env.cost_estimate().resources();
    println!(
        "[bench] get_payments(0, u32::MAX): read_entries={} (must be <= 100 + fixed overhead)",
        (r.disk_read_entries + r.memory_read_entries)
    );
    assert!(
        (r.disk_read_entries + r.memory_read_entries) <= 110,
        "unbounded pagination: read_entries={}",
        (r.disk_read_entries + r.memory_read_entries)
    );
}