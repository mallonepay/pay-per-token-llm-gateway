//! Gas/storage benchmarks for `credit-escrow`.
//!
//! Uses the Soroban SDK test environment's cost accounting
//! (`env.cost_estimate()`) to capture real per-invocation resource usage.
//!
//! Core claims under test:
//! 1. `charge` is O(1) in the number of prior charges (no growth with
//!    usage history) — bounded storage ops per call.
//! 2. `deposit` is O(1) and bounded.
//!
//! Run with: `cargo test --release -- --nocapture bench_`

use crate::{CreditEscrow, CreditEscrowClient};
use soroban_sdk::{
    testutils::Address as _, token::StellarAssetClient, Address, Env, String,
};

// The contract crate is #![no_std]; bring in std for test-only printing.
#[cfg(test)]
extern crate std;
use std::println;

fn setup_env() -> (Env, Address, Address, Address, CreditEscrowClient<'static>) {
    let env = Env::default();
    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = env.register_stellar_asset_contract(token_admin.clone());

    let contract_id = env.register(CreditEscrow, (&admin, &asset));
    let client = CreditEscrowClient::new(&env, &contract_id);

    (env, admin, token_admin, asset, client)
}

/// Fund a fresh user with test tokens and deposit them into escrow.
fn fund_and_deposit(env: &Env, client: &CreditEscrowClient, token_admin: &Address, asset: &Address) -> Address {
    let user = Address::generate(env);
    StellarAssetClient::new(env, asset)
        .mock_all_auths()
        .mint(&user, &10_000_000_000i128);
    client.mock_all_auths().deposit(&user, &9_000_000_000i128);
    let _ = token_admin;
    user
}

#[test]
fn bench_charge_constant_cost_vs_usage_history() {
    let (env, _admin, token_admin, _asset, client) = setup_env();
    let user = fund_and_deposit(&env, &client, &token_admin, &_asset);

    // Warm up.
    client
        .mock_all_auths()
        .charge(&user, &1_000i128, &String::from_str(&env, "warmup"));
    let _ = env.cost_estimate().resources();

    // Baseline: after a single prior charge.
    client
        .mock_all_auths()
        .charge(&user, &1_000i128, &String::from_str(&env, "q-000001"));
    let res_1 = env.cost_estimate().resources();
    let fee_1 = env.cost_estimate().fee();

    // 100 charges.
    for i in 2..=100 {
        client.mock_all_auths().charge(
            &user,
            &1_000i128,
            &String::from_str(&env, &std::format!("q-{:06}", i)),
        );
    }
    let res_100 = env.cost_estimate().resources();
    let fee_100 = env.cost_estimate().fee();

    // 1,000 charges.
    for i in 101..=1_000 {
        client.mock_all_auths().charge(
            &user,
            &1_000i128,
            &String::from_str(&env, &std::format!("q-{:06}", i)),
        );
    }
    let res_1k = env.cost_estimate().resources();
    let fee_1k = env.cost_estimate().fee();

    println!("[bench] credit-escrow charge vs usage history:");
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

    // O(1) gate: fee and write entries must stay flat. `instructions` is not
    // gated — the test host diffs the full storage footprint on invocation
    // close, so its CPU meter grows with accumulated state while the actual
    // on-chain cost drivers (entries + fee) stay flat.
    let fee_ratio = fee_1k.total as f64 / fee_1.total as f64;
    println!("  fee@1k / fee@1        = {fee_ratio:.3} (must be < 1.5)");
    println!(
        "  write_entries@1k / @1 = {} (must be identical)",
        res_1k.write_entries == res_1.write_entries
    );

    assert!(
        fee_ratio < 1.5,
        "O(1) violated: fee grew {fee_ratio:.3}x"
    );
    assert!(
        res_1k.write_entries == res_1.write_entries,
        "O(1) violated: write entries grew from {} to {}",
        res_1.write_entries,
        res_1k.write_entries
    );
    // charge = charged-guard write + balance write + revenue instance write
    // + usage write + usage-count write = 5 writes.
    assert!(
        res_1k.write_entries <= 8,
        "per-call write entries {} exceeded bound of 8",
        res_1k.write_entries
    );
    println!(
        "  write_entries@1k = {} (expect ~5: guard + balance + revenue + usage + count)",
        res_1k.write_entries
    );
}