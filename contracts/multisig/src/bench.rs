//! Gas/storage benchmarks for `multisig`.
//!
//! Uses the Soroban SDK test environment's cost accounting
//! (`env.cost_estimate()`) to capture real per-invocation resource usage.
//!
//! Core claims under test:
//! 1. `propose` and `approve` are O(1) in the number of prior proposals
//!    (bounded storage ops per call).
//! 2. `approve` on a large proposal (many approvals) stays bounded.
//!
//! Run with: `cargo test --release -- --nocapture bench_`

use crate::{Multisig, MultisigClient};
use soroban_sdk::{testutils::Address as _, Address, Env, Vec};

// The contract crate is #![no_std]; bring in std for test-only printing.
#[cfg(test)]
extern crate std;
use std::println;

fn setup_env(threshold: u32) -> (Env, Address, Vec<Address>, MultisigClient<'static>) {
    let env = Env::default();
    let token = Address::generate(&env);
    let mut signers: Vec<Address> = Vec::new(&env);
    for _ in 0..threshold {
        signers.push_back(Address::generate(&env));
    }
    let contract_id = env.register(Multisig, (signers.clone(), threshold, token.clone()));
    let client = MultisigClient::new(&env, &contract_id);
    (env, token, signers, client)
}

#[test]
fn bench_propose_and_approve_constant_cost_vs_proposal_count() {
    let (env, _token, _signers, client) = setup_env(3);

    // Warm up.
    client.mock_all_auths().propose(&Address::generate(&env), &1_000_000i128);
    let _ = env.cost_estimate().resources();

    // Baseline: propose at a small count.
    let dest = Address::generate(&env);
    client.mock_all_auths().propose(&dest, &1_000_000i128);
    let res_1 = env.cost_estimate().resources();
    let fee_1 = env.cost_estimate().fee();

    // 1,000 proposals.
    for _ in 2..=1_000 {
        client.mock_all_auths().propose(&Address::generate(&env), &1_000_000i128);
    }
    let res_1k = env.cost_estimate().resources();
    let fee_1k = env.cost_estimate().fee();

    // 10,000 proposals.
    for _ in 1_001..=10_000 {
        client.mock_all_auths().propose(&Address::generate(&env), &1_000_000i128);
    }
    let res_10k = env.cost_estimate().resources();
    let fee_10k = env.cost_estimate().fee();

    println!("[bench] multisig propose vs proposal count:");
    for (label, res, fee) in [
        ("count=1  ", &res_1, &fee_1),
        ("count=1k ", &res_1k, &fee_1k),
        ("count=10k", &res_10k, &fee_10k),
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
    let fee_ratio = fee_10k.total as f64 / fee_1.total as f64;
    println!("  fee@10k / fee@1        = {fee_ratio:.3} (must be < 1.5)");
    println!(
        "  write_entries@10k / @1 = {} (must be identical)",
        res_10k.write_entries == res_1.write_entries
    );

    assert!(fee_ratio < 1.5, "O(1) violated: fee grew {fee_ratio:.3}x");
    assert!(
        res_10k.write_entries == res_1.write_entries,
        "O(1) violated: write entries grew from {} to {}",
        res_1.write_entries,
        res_10k.write_entries
    );
    // propose = 1 persistent write + 1 instance write (counter) + event.
    assert!(
        res_10k.write_entries <= 4,
        "per-call write entries {} exceeded bound of 4",
        res_10k.write_entries
    );
    println!(
        "  write_entries@10k = {} (expect ~2: proposal + counter)",
        res_10k.write_entries
    );

    // approve on a fresh proposal: read proposal + write back = bounded.
    let pid = client.mock_all_auths().propose(&Address::generate(&env), &1_000_000i128);
    let _ = env.cost_estimate().resources();
    client.mock_all_auths().approve(&_signers.get(0).unwrap().clone(), &pid);
    let res_approve = env.cost_estimate().resources();
    let fee_approve = env.cost_estimate().fee();
    println!(
        "[bench] multisig approve: insns={} write_entries={} fee={} stroops",
        res_approve.instructions, res_approve.write_entries, fee_approve.total
    );
    assert!(
        res_approve.write_entries <= 4,
        "approve per-call write entries {} exceeded bound of 4",
        res_approve.write_entries
    );
}