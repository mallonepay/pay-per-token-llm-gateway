//! Property-based tests (deterministic, seeded — no external fuzz runner).
//!
//! Randomized configurations and approval orders asserting the multisig
//! contract's security invariants:
//!
//!   - quorum semantics: a proposal NEVER executes before `threshold`
//!     DISTINCT signers have approved; it executes exactly on the
//!     threshold-th distinct approval; duplicate approvals are no-ops; after
//!     execution every further approval is rejected and the payout happened
//!     exactly once;
//!   - pagination window math: random (offset, limit) probes return exactly
//!     the clamped window length;
//!   - rotation validation: random new signer sets are accepted iff the
//!     threshold is ≥ 1, ≤ len, and the set has no duplicates — and a
//!     rejected rotation leaves the configuration untouched.
//!
//! A fixed seed keeps failures reproducible.

use crate::{has_unique_signers, Multisig, MultisigClient};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};
use soroban_sdk::{Address, Env, Vec};

// The contract crate is #![no_std]; tests link std (the harness needs it).
#[cfg(test)]
extern crate std;

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

const CONFIGS: usize = 40;
const MAX_PAGE_SIZE: u32 = 50;

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
fn prop_approval_quorum_semantics_under_random_orders() {
    let mut prng = Prng(0x0dd5_4024_0000_0001);

    for _ in 0..CONFIGS {
        let env = Env::default();
        let token_admin = Address::generate(&env);
        let token = env.register_stellar_asset_contract(token_admin);

        // Random signer set size 2..=6 and threshold 1..=N.
        let n = 2 + prng.below(4) as u32;
        let threshold = 1 + prng.below(n as u64 - 1) as u32;
        let mut signers: std::vec::Vec<Address> = std::vec::Vec::new();
        let mut signer_vec = Vec::new(&env);
        for _ in 0..n {
            let s = Address::generate(&env);
            signers.push(s.clone());
            signer_vec.push_back(s);
        }

        let contract_id = env.register(Multisig, (signer_vec.clone(), threshold, token.clone()));
        let client = MultisigClient::new(&env, &contract_id);
        assert_eq!(client.get_config().threshold, threshold);

        let destination = Address::generate(&env);
        let amount = (1 + prng.below(999_999) as i128) as i128;

        // Fund the wallet so an execution can actually transfer.
        StellarAssetClient::new(&env, &token)
            .mock_all_auths()
            .mint(&contract_id, &1_000_000_000i128);
        let token_client = TokenClient::new(&env, &token);

        let proposal_id = client.propose(&destination, &amount);
        let mut distinct: std::vec::Vec<Address> = std::vec::Vec::new();

        // Random approval order of length 2N with duplicates.
        for _ in 0..(n as usize * 2) {
            let signer = signers[prng.below(n as u64 - 1) as usize].clone();

            // Once executed, every further approval is rejected.
            if client.get_proposal(&proposal_id).executed {
                let rejected = client.try_approve(&signer, &proposal_id);
                assert!(
                    rejected.is_err(),
                    "approval after execution must be rejected"
                );
                continue;
            }

            let was_new = !distinct.contains(&signer);
            client.mock_all_auths().approve(&signer, &proposal_id);
            if was_new {
                distinct.push(signer);
            }

            let proposal = client.get_proposal(&proposal_id);
            assert_eq!(
                proposal.approvals.len(),
                distinct.len() as u32,
                "approvals must equal the distinct approver count (no dupes)"
            );
            assert_eq!(
                proposal.executed,
                (distinct.len() as u32) >= threshold,
                "execution must flip exactly at the threshold-th distinct approval"
            );

            if proposal.executed {
                // Payout happened exactly once, to the right destination.
                assert_eq!(token_client.balance(&destination), amount);
                assert_eq!(
                    token_client.balance(&contract_id),
                    1_000_000_000 - amount,
                    "wallet must hold its funding minus exactly one payout"
                );
            }
        }
    }
}

#[test]
fn prop_proposal_pagination_window_length_for_random_probes() {
    let mut prng = Prng(0x0dd5_4024_0000_0002);
    let env = Env::default();
    let signer = Address::generate(&env);
    let token = Address::generate(&env);
    let destination = Address::generate(&env);

    let signers = Vec::from_array(&env, [signer]);
    let contract_id = env.register(Multisig, (signers.clone(), 1u32, token.clone()));
    let client = MultisigClient::new(&env, &contract_id);

    let count = 1 + prng.below(120) as u32;
    for i in 0..count {
        client.propose(&destination, &((i as i128 + 1) * 10));
    }
    assert_eq!(client.get_proposal_count(), count);

    for _ in 0..200 {
        let offset = prng.below(300) as u32;
        let limit = prng.below(500) as u32;
        let page = client.get_proposals(&offset, &limit);
        assert_eq!(
            page.len(),
            expected_page_len(offset, limit, count),
            "page length for offset={offset} limit={limit} count={count}"
        );
    }

    let overflow = client.get_proposals(&u32::MAX, &u32::MAX);
    assert_eq!(overflow.len(), 0);
    let tail = client.get_proposals(&(count - 1), &u32::MAX);
    assert_eq!(tail.len(), 1);

}

#[test]
fn prop_rotation_validation_accepts_only_sound_configs() {
    let mut prng = Prng(0x0dd5_4024_0000_0003);

    for _ in 0..CONFIGS {
        let env = Env::default();
        let token = Address::generate(&env);

        // Current config: n signers, threshold t.
        let n = 1 + prng.below(5) as u32;
        let threshold = 1 + prng.below(n as u64 - 1) as u32;
        let mut signers = Vec::new(&env);
        let mut signer_list: std::vec::Vec<Address> = std::vec::Vec::new();
        for _ in 0..n {
            let s = Address::generate(&env);
            signers.push_back(s.clone());
            signer_list.push(s);
        }

        let contract_id = env.register(Multisig, (signers.clone(), threshold, token.clone()));
        let client = MultisigClient::new(&env, &contract_id);

        // Random proposed new set: length m (1..=6), threshold nt (0..=8),
        // with duplicates injected ~30% of the time.
        let m = 1 + prng.below(5) as u32;
        let nt = prng.below(8) as u32;
        let mut new_signers = Vec::new(&env);
        let mut backing: std::vec::Vec<Address> = std::vec::Vec::new();
        for _ in 0..m {
            let s = Address::generate(&env);
            backing.push(s.clone());
            new_signers.push_back(s);
        }
        let duplicate = prng.below(9) == 0;
        if duplicate && m > 1 {
            // Overwrite the last entry with a copy of the first.
            let first = new_signers.get(0).unwrap();
            new_signers.set(m - 1, first);
        }

        // Quorum of current signers approves the rotation.
        let mut approvers = Vec::new(&env);
        for i in 0..threshold {
            approvers.push_back(signer_list[i as usize].clone());
        }

        let config_before = client.get_config();
        // mock_all_auths so quorum auth is satisfied — the only possible
        // failures are the new-config validation guards under test.
        let result = client
            .mock_all_auths()
            .try_set_signers(&approvers, &new_signers, &nt);
        let config_after = client.get_config();

        let expected_ok = nt >= 1
            && nt <= m
            && has_unique_signers(&new_signers)
            && (nt as usize) <= m as usize;
        if expected_ok {
            assert!(result.is_ok(), "rotation with nt={nt} m={m} must succeed");
            assert_eq!(config_after.threshold, nt);
            assert_eq!(config_after.signers.len(), m);
        } else {
            assert!(
                result.is_err(),
                "rotation with nt={nt} m={m} duplicate={duplicate} must be rejected"
            );
            assert_eq!(
                config_after.threshold,
                config_before.threshold,
                "rejected rotation must leave the config untouched"
            );
            assert_eq!(config_after.signers.len(), config_before.signers.len());
        }
    }
}