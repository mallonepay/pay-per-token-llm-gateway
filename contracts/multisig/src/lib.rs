//! x402 Multi-Signature Wallet — Soroban Smart Contract
//!
//! Optional contract for provider payout wallet security.
//! Requires M-of-N signatures to authorize payouts.
//!
//! Use case: Provider wants to require multiple signers
//! before transferring accumulated gateway revenue to their wallet.
//!
//! All entries live in instance storage (a single ContractInstance entry),
//! so one `extend_ttl` call per state-mutating invocation keeps the instance
//! AND the contract code alive — without it the network default TTL (~4096
//! ledgers) would archive proposals and config within hours. Read-only
//! functions deliberately do NOT extend the TTL (reads are free and
//! permissionless, so letting anyone bump the TTL by spamming reads would be
//! an abuse vector).

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, Address, Env, String, Symbol, Vec,
};

#[contracttype]
#[derive(Clone)]
pub struct MultisigConfig {
    pub signers: Vec<Address>,
    pub threshold: u32,
    pub token: Address,
}

#[contracttype]
#[derive(Clone)]
pub struct Proposal {
    pub id: u32,
    pub destination: Address,
    pub amount: i128,
    pub executed: bool,
    pub approvals: Vec<Address>,
    pub createdAt: u64,
}

const CONFIG_KEY: Symbol = symbol_short!("CONFIG");
const PROPOSALS_KEY: Symbol = symbol_short!("PROPS");
const PROPOSAL_COUNT_KEY: Symbol = symbol_short!("PROPCT");

// ── Storage TTL ─────────────────────────────
//
// Soroban instance storage and the contract code are archived once their
// ledger TTL expires unless explicitly extended (the network default is only
// ~4096 ledgers — hours on mainnet). Only MUTATING functions (init, propose,
// approve, set_signers) bump the instance + code TTL back to LEDGERS_TO_LIVE;
// the call is a free no-op while the remaining TTL is above LEDGER_THRESHOLD.
// Read-only functions never extend the TTL — an unbounded read flood must not
// be able to keep a contract alive forever at the caller's expense.
const LEDGER_THRESHOLD: u32 = 500_000;
const LEDGERS_TO_LIVE: u32 = 1_000_000;

/// Maximum number of entries a single paginated read may return.
const MAX_PAGE_SIZE: u32 = 100;

/// Bump the TTL of the contract instance and code so the contract and all of
/// its stored data are never archived while the contract is in use.
/// Call from mutating functions only — never from read-only paths.
fn extend_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(LEDGER_THRESHOLD, LEDGERS_TO_LIVE);
}

// ── Events ───────────────────────────────────

fn emit_proposed(env: &Env, proposal_id: u32, destination: &Address, amount: i128) {
    let topics = (symbol_short!("proposed"), proposal_id);
    env.events().publish(topics, (destination.clone(), amount));
}

fn emit_approved(env: &Env, proposal_id: u32, signer: &Address) {
    let topics = (symbol_short!("approved"), proposal_id);
    env.events().publish(topics, signer.clone());
}

fn emit_executed(env: &Env, proposal_id: u32, destination: &Address, amount: i128) {
    let topics = (symbol_short!("executed"), proposal_id);
    env.events().publish(topics, (destination.clone(), amount));
}

fn emit_signers_changed(env: &Env, new_signers: &Vec<Address>, new_threshold: u32) {
    let topics = (symbol_short!("sigs_chng"),);
    env.events().publish(topics, (new_signers.clone(), new_threshold));
}

#[contract]
pub struct Multisig;

#[contractimpl]
impl Multisig {
    pub fn init(env: Env, signers: Vec<Address>, threshold: u32, token: Address) {
        extend_ttl(&env);
        // Prevent re-initialization: `init` may only be called once. Without
        // this guard, anyone could re-initialize the contract with their own
        // signer set (threshold = 1) and drain every token it holds.
        if env.storage().instance().has(&CONFIG_KEY) {
            panic!("Contract already initialized");
        }

        // Validate threshold
        if threshold == 0 {
            panic!("Threshold must be at least 1");
        }
        if threshold > signers.len() as u32 {
            panic!("Threshold cannot exceed number of signers");
        }
        if !has_unique_signers(&signers) {
            panic!("Duplicate signers are not allowed");
        }

        let config = MultisigConfig {
            signers,
            threshold,
            token,
        };
        env.storage().instance().set(&CONFIG_KEY, &config);
        env.storage().instance().set(&PROPOSAL_COUNT_KEY, &0u32);
    }

    pub fn propose(env: Env, destination: Address, amount: i128) -> u32 {
        extend_ttl(&env);
        if amount <= 0 {
            panic!("Amount must be positive");
        }

        let mut count: u32 = env
            .storage()
            .instance()
            .get(&PROPOSAL_COUNT_KEY)
            .unwrap();
        let proposal_id = count;
        count += 1;
        env.storage().instance().set(&PROPOSAL_COUNT_KEY, &count);

        let proposal = Proposal {
            id: proposal_id,
            destination,
            amount,
            executed: false,
            approvals: Vec::new(&env),
            createdAt: env.ledger().timestamp(),
        };

        let proposals_key = (PROPOSALS_KEY, proposal_id);
        env.storage().instance().set(&proposals_key, &proposal);

        emit_proposed(&env, proposal_id, &proposal.destination, proposal.amount);

        proposal_id
    }

    pub fn approve(env: Env, signer: Address, proposal_id: u32) {
        extend_ttl(&env);
        signer.require_auth();

        let config: MultisigConfig = env.storage().instance().get(&CONFIG_KEY).unwrap();
        if !config.signers.contains(&signer) {
            panic!("Not an authorized signer");
        }

        let proposals_key = (PROPOSALS_KEY, proposal_id);
        let mut proposal: Proposal = env
            .storage()
            .instance()
            .get(&proposals_key)
            .unwrap();

        if proposal.executed {
            panic!("Proposal already executed");
        }

        // Record the approval exactly once and emit the event. A signer who
        // has already approved is a no-op (no duplicate pushes, no duplicate
        // events).
        if !proposal.approvals.contains(&signer) {
            proposal.approvals.push_back(signer.clone());
            emit_approved(&env, proposal_id, &signer);
        }

        if proposal.approvals.len() >= config.threshold && !proposal.executed {
            proposal.executed = true;

            // Execute transfer
            let token_client = token::Client::new(&env, &config.token);
            token_client.transfer(
                &env.current_contract_address(),
                &proposal.destination,
                &proposal.amount,
            );
            emit_executed(&env, proposal_id, &proposal.destination, proposal.amount);
        }

        env.storage().instance().set(&proposals_key, &proposal);
    }

    /// Rotate the signer set and threshold.
    ///
    /// A rotation is a security-critical configuration change, so it must be
    /// authorized by at least the CURRENT `threshold` of distinct current
    /// signers — the same quorum required to execute a payout. The caller
    /// supplies the list of approving signers (`approvers`); the contract
    /// requires each of them to cryptographically authorize this invocation
    /// (`require_auth`) and to be a current signer, then enforces the quorum
    /// against the current configuration.
    ///
    /// This prevents a single compromised signer from unilaterally replacing
    /// the signer set with attacker-controlled addresses (e.g. threshold = 1)
    /// and draining the wallet.
    pub fn set_signers(
        env: Env,
        approvers: Vec<Address>,
        new_signers: Vec<Address>,
        new_threshold: u32,
    ) {
        extend_ttl(&env);
        let mut config: MultisigConfig = env.storage().instance().get(&CONFIG_KEY).unwrap();

        // Collect the distinct listed approvers. Every one of them must be a
        // current signer. `require_auth` makes it impossible to claim approval
        // from a signer who did not actually sign — and because duplicates are
        // never pushed, each distinct approver authorizes exactly once (a
        // duplicate entry would otherwise hit `Error(Auth, ExistingValue)`).
        let mut unique_approvers: Vec<Address> = Vec::new(&env);
        for approver in approvers.iter() {
            if !config.signers.contains(&approver) {
                panic!("Not an authorized signer");
            }
            if !unique_approvers.contains(&approver) {
                approver.require_auth();
                unique_approvers.push_back(approver.clone());
            }
        }

        // Quorum gate: rotation requires the same consent as a payout.
        // Duplicate approvers count only once.
        if (unique_approvers.len() as u32) < config.threshold {
            panic!("Rotation requires at least the threshold of current signer approvals");
        }

        if new_threshold == 0 {
            panic!("Threshold must be at least 1");
        }
        if new_threshold > new_signers.len() as u32 {
            panic!("Threshold cannot exceed number of signers");
        }
        if !has_unique_signers(&new_signers) {
            panic!("Duplicate signers are not allowed");
        }

        config.signers = new_signers;
        config.threshold = new_threshold;
        env.storage().instance().set(&CONFIG_KEY, &config);

        emit_signers_changed(&env, &config.signers, config.threshold);
    }

    /// O(1) lookup of a single proposal. Read-only — does not extend the
    /// storage TTL.
    pub fn get_proposal(env: Env, proposal_id: u32) -> Proposal {
        let proposals_key = (PROPOSALS_KEY, proposal_id);
        env.storage().instance().get(&proposals_key).unwrap()
    }

    /// Total number of proposals ever created. Read-only — does not extend
    /// the storage TTL.
    pub fn get_proposal_count(env: Env) -> u32 {
        env.storage().instance().get(&PROPOSAL_COUNT_KEY).unwrap_or(0)
    }

    /// Paginated proposal listing — O(limit) reads, bounded gas. Read-only —
    /// does not extend the storage TTL.
    ///
    /// The caller-supplied `limit` is clamped to MAX_PAGE_SIZE so a single
    /// invocation can never trigger more than 100 storage reads, and
    /// `saturating_add` prevents u32 overflow in the end-index computation.
    pub fn get_proposals(env: Env, offset: u32, limit: u32) -> Vec<Proposal> {
        let count: u32 = env.storage().instance().get(&PROPOSAL_COUNT_KEY).unwrap_or(0);
        let mut result = Vec::new(&env);
        let end = offset.saturating_add(limit.min(MAX_PAGE_SIZE)).min(count);
        for i in offset..end {
            let proposals_key = (PROPOSALS_KEY, i);
            if let Some(p) = env.storage().instance().get(&proposals_key) {
                result.push_back(p);
            }
        }
        result
    }

    /// O(1) config lookup. Read-only — does not extend the storage TTL.
    pub fn get_config(env: Env) -> MultisigConfig {
        env.storage().instance().get(&CONFIG_KEY).unwrap()
    }
}

/// True when every element of `signers` is distinct.
fn has_unique_signers(signers: &Vec<Address>) -> bool {
    for i in 0..signers.len() {
        for j in (i + 1)..signers.len() {
            if signers.get(i).unwrap() == signers.get(j).unwrap() {
                return false;
            }
        }
    }
    true
}

// ── Tests ────────────────────────────────────

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::storage::Instance as _;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::testutils::Ledger as _;
    use soroban_sdk::token::StellarAssetClient;

    #[test]
    fn test_init_with_valid_signers() {
        let env = Env::default();
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);
        let token = Address::generate(&env);

        let signers = Vec::from_array(&env, [signer1.clone(), signer2.clone()]);

        let contract_id = env.register(Multisig, ());
        let client = MultisigClient::new(&env, &contract_id);
        client.init(&signers, &1u32, &token);

        let config = client.get_config();
        assert_eq!(config.signers.len(), 2);
        assert_eq!(config.threshold, 1);
        assert_eq!(config.token, token);
    }

    #[test]
    #[should_panic(expected = "Threshold must be at least 1")]
    fn test_init_with_zero_threshold() {
        let env = Env::default();
        let signer1 = Address::generate(&env);
        let token = Address::generate(&env);

        let signers = Vec::from_array(&env, [signer1.clone()]);

        let contract_id = env.register(Multisig, ());
        let client = MultisigClient::new(&env, &contract_id);
        client.init(&signers, &0u32, &token);
    }

    #[test]
    #[should_panic(expected = "Threshold cannot exceed number of signers")]
    fn test_init_with_threshold_exceeding_signers() {
        let env = Env::default();
        let signer1 = Address::generate(&env);
        let token = Address::generate(&env);

        let signers = Vec::from_array(&env, [signer1.clone()]);

        let contract_id = env.register(Multisig, ());
        let client = MultisigClient::new(&env, &contract_id);
        client.init(&signers, &5u32, &token);
    }

    #[test]
    #[should_panic(expected = "Contract already initialized")]
    fn test_double_init_rejected() {
        let env = Env::default();
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);
        let token = Address::generate(&env);

        let signers = Vec::from_array(&env, [signer1.clone(), signer2.clone()]);

        let contract_id = env.register(Multisig, ());
        let client = MultisigClient::new(&env, &contract_id);
        client.init(&signers, &2u32, &token);

        // Attack scenario: a second `init` with an attacker-controlled signer
        // set and threshold 1 must be rejected, otherwise the contract could
        // be taken over and drained.
        let attacker = Address::generate(&env);
        let attacker_signers = Vec::from_array(&env, [attacker.clone()]);
        client.init(&attacker_signers, &1u32, &token);
    }

    #[test]
    fn test_propose_creates_proposal() {
        let env = Env::default();
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);
        let token = Address::generate(&env);
        let destination = Address::generate(&env);

        let signers = Vec::from_array(&env, [signer1.clone(), signer2.clone()]);

        let contract_id = env.register(Multisig, ());
        let client = MultisigClient::new(&env, &contract_id);
        client.init(&signers, &2u32, &token);

        let proposal_id = client.propose(&destination, &100_000_000i128);
        assert_eq!(proposal_id, 0);

        let proposal = client.get_proposal(&proposal_id);
        assert_eq!(proposal.id, 0);
        assert_eq!(proposal.destination, destination);
        assert_eq!(proposal.amount, 100_000_000i128);
        assert!(!proposal.executed);
        assert_eq!(proposal.approvals.len(), 0);
    }

    #[test]
    #[should_panic(expected = "Not an authorized signer")]
    fn test_unauthorized_approver_rejected() {
        let env = Env::default();
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);
        let outsider = Address::generate(&env);
        let token = Address::generate(&env);
        let destination = Address::generate(&env);

        let signers = Vec::from_array(&env, [signer1.clone(), signer2.clone()]);

        let contract_id = env.register(Multisig, ());
        let client = MultisigClient::new(&env, &contract_id);
        client.init(&signers, &2u32, &token);

        let proposal_id = client.propose(&destination, &100_000_000i128);

        // outsider is not in the signer list
        client.mock_all_auths().approve(&outsider, &proposal_id);
    }

    #[test]
    fn test_multiple_approvals() {
        let env = Env::default();
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);
        let destination = Address::generate(&env);

        // Deploy a real SAC token and mint funds to the multisig contract
        let token_admin = Address::generate(&env);
        let token = env.register_stellar_asset_contract(token_admin.clone());

        let signers = Vec::from_array(&env, [signer1.clone(), signer2.clone()]);

        let contract_id = env.register(Multisig, ());
        let client = MultisigClient::new(&env, &contract_id);
        client.init(&signers, &2u32, &token);

        // Mint tokens to the multisig contract so it can transfer when executed
        StellarAssetClient::new(&env, &token)
            .mock_all_auths()
            .mint(&contract_id, &1_000_000_000i128);

        let proposal_id = client.propose(&destination, &100_000_000i128);

        // First approval
        client.mock_all_auths().approve(&signer1, &proposal_id);
        let proposal = client.get_proposal(&proposal_id);
        assert_eq!(proposal.approvals.len(), 1);
        assert!(!proposal.executed);

        // Second approval should trigger execution
        client.mock_all_auths().approve(&signer2, &proposal_id);
        let proposal = client.get_proposal(&proposal_id);
        assert_eq!(proposal.approvals.len(), 2);
        assert!(proposal.executed);
    }

    #[test]
    #[should_panic(expected = "Proposal already executed")]
    fn test_double_execute_prevented() {
        let env = Env::default();
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);
        let destination = Address::generate(&env);

        // Deploy a real SAC token and mint funds to the multisig contract
        let token_admin = Address::generate(&env);
        let token = env.register_stellar_asset_contract(token_admin.clone());

        let signers = Vec::from_array(&env, [signer1.clone(), signer2.clone()]);

        let contract_id = env.register(Multisig, ());
        let client = MultisigClient::new(&env, &contract_id);
        client.init(&signers, &2u32, &token);

        // Mint tokens to the multisig contract so it can transfer when executed
        StellarAssetClient::new(&env, &token)
            .mock_all_auths()
            .mint(&contract_id, &1_000_000_000i128);

        let proposal_id = client.propose(&destination, &100_000_000i128);

        client.mock_all_auths().approve(&signer1, &proposal_id);
        client.mock_all_auths().approve(&signer2, &proposal_id);

        // Third approval should panic
        client.mock_all_auths().approve(&signer1, &proposal_id);
    }

    #[test]
    fn test_proposal_increments() {
        let env = Env::default();
        let signer1 = Address::generate(&env);
        let token = Address::generate(&env);
        let destination = Address::generate(&env);

        let signers = Vec::from_array(&env, [signer1.clone()]);

        let contract_id = env.register(Multisig, ());
        let client = MultisigClient::new(&env, &contract_id);
        client.init(&signers, &1u32, &token);

        let id1 = client.propose(&destination, &10i128);
        let id2 = client.propose(&destination, &20i128);

        assert_eq!(id1, 0);
        assert_eq!(id2, 1);

        let p1 = client.get_proposal(&0);
        let p2 = client.get_proposal(&1);
        assert_eq!(p1.amount, 10);
        assert_eq!(p2.amount, 20);
    }

    // ── Authorization & rotation tests ───────────

    #[test]
    fn test_approve_requires_signer_auth() {
        let env = Env::default();
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);
        let token = Address::generate(&env);
        let destination = Address::generate(&env);

        let signers = Vec::from_array(&env, [signer1.clone(), signer2.clone()]);

        let contract_id = env.register(Multisig, ());
        let client = MultisigClient::new(&env, &contract_id);
        client.init(&signers, &2u32, &token);

        let proposal_id = client.propose(&destination, &100_000_000i128);

        // Unauthenticated approval → require_auth() must fail.
        let result = client.try_approve(&signer1, &proposal_id);
        assert!(result.is_err());
        let proposal = client.get_proposal(&proposal_id);
        assert_eq!(proposal.approvals.len(), 0);
        assert!(!proposal.executed);
    }

    #[test]
    #[should_panic(expected = "Duplicate signers are not allowed")]
    fn test_duplicate_signers_rejected() {
        let env = Env::default();
        let signer1 = Address::generate(&env);
        let token = Address::generate(&env);

        let signers = Vec::from_array(&env, [signer1.clone(), signer1.clone()]);

        let contract_id = env.register(Multisig, ());
        let client = MultisigClient::new(&env, &contract_id);
        client.init(&signers, &1u32, &token);
    }

    #[test]
    #[should_panic(expected = "Amount must be positive")]
    fn test_propose_rejects_non_positive_amount() {
        let env = Env::default();
        let signer1 = Address::generate(&env);
        let token = Address::generate(&env);
        let destination = Address::generate(&env);

        let signers = Vec::from_array(&env, [signer1.clone()]);

        let contract_id = env.register(Multisig, ());
        let client = MultisigClient::new(&env, &contract_id);
        client.init(&signers, &1u32, &token);

        client.propose(&destination, &0i128);
    }

    #[test]
    fn test_rotation_updates_signers_and_threshold() {
        let env = Env::default();
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);
        let signer3 = Address::generate(&env);
        let token = Address::generate(&env);

        let signers = Vec::from_array(&env, [signer1.clone(), signer2.clone()]);

        let contract_id = env.register(Multisig, ());
        let client = MultisigClient::new(&env, &contract_id);
        client.init(&signers, &2u32, &token);

        // A quorum of current signers (both, threshold = 2) rotates the set.
        let approvers = Vec::from_array(&env, [signer1.clone(), signer2.clone()]);
        let new_signers = Vec::from_array(&env, [signer2.clone(), signer3.clone()]);
        client.mock_all_auths().set_signers(&approvers, &new_signers, &1u32);

        let config = client.get_config();
        assert_eq!(config.signers.len(), 2);
        assert_eq!(config.threshold, 1);
    }

    // ── Rotation quorum security tests ─────────────

    #[test]
    #[should_panic(expected = "Rotation requires")]
    fn test_single_signer_cannot_rotate_when_threshold_requires_quorum() {
        // The critical vulnerability: with a 2-of-2 config, a single signer
        // must NOT be able to replace the signer set with attacker-controlled
        // addresses and threshold 1 — otherwise one compromised key could
        // drain the entire wallet.
        let env = Env::default();
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);
        let attacker = Address::generate(&env);
        let token = Address::generate(&env);

        let signers = Vec::from_array(&env, [signer1.clone(), signer2.clone()]);

        let contract_id = env.register(Multisig, ());
        let client = MultisigClient::new(&env, &contract_id);
        client.init(&signers, &2u32, &token);

        // Only signer1 approves — one short of the threshold of 2.
        let approvers = Vec::from_array(&env, [signer1.clone()]);
        let attacker_signers = Vec::from_array(&env, [attacker.clone()]);
        client.mock_all_auths().set_signers(&approvers, &attacker_signers, &1u32);
    }

    #[test]
    #[should_panic(expected = "Rotation requires")]
    fn test_rotation_below_threshold_rejected_in_2_of_3_config() {
        // In a 2-of-3 config, two signers may rotate — but only one may not.
        let env = Env::default();
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);
        let signer3 = Address::generate(&env);
        let attacker = Address::generate(&env);
        let token = Address::generate(&env);

        let signers = Vec::from_array(&env, [signer1.clone(), signer2.clone(), signer3.clone()]);

        let contract_id = env.register(Multisig, ());
        let client = MultisigClient::new(&env, &contract_id);
        client.init(&signers, &2u32, &token);

        let approvers = Vec::from_array(&env, [signer1.clone()]);
        let attacker_signers = Vec::from_array(&env, [attacker.clone()]);
        client.mock_all_auths().set_signers(&approvers, &attacker_signers, &1u32);
    }

    #[test]
    fn test_rotation_succeeds_with_threshold_quorum_from_larger_set() {
        // In a 2-of-3 config, any two distinct current signers may rotate.
        let env = Env::default();
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);
        let signer3 = Address::generate(&env);
        let signer4 = Address::generate(&env);
        let token = Address::generate(&env);

        let signers = Vec::from_array(&env, [signer1.clone(), signer2.clone(), signer3.clone()]);

        let contract_id = env.register(Multisig, ());
        let client = MultisigClient::new(&env, &contract_id);
        client.init(&signers, &2u32, &token);

        let approvers = Vec::from_array(&env, [signer1.clone(), signer3.clone()]);
        let new_signers = Vec::from_array(&env, [signer2.clone(), signer4.clone()]);
        client.mock_all_auths().set_signers(&approvers, &new_signers, &2u32);

        let config = client.get_config();
        assert_eq!(config.signers.len(), 2);
        assert_eq!(config.threshold, 2);
    }

    #[test]
    fn test_quorum_with_duplicates_succeeds() {
        // A quorum that happens to list one signer twice must still succeed
        // (duplicates are deduplicated before `require_auth`, so they neither
        // pad the count nor trip `Error(Auth, ExistingValue)`).
        let env = Env::default();
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);
        let signer3 = Address::generate(&env);
        let token = Address::generate(&env);

        let signers = Vec::from_array(&env, [signer1.clone(), signer2.clone()]);

        let contract_id = env.register(Multisig, ());
        let client = MultisigClient::new(&env, &contract_id);
        client.init(&signers, &2u32, &token);

        let approvers = Vec::from_array(&env, [signer1.clone(), signer2.clone(), signer1.clone()]);
        let new_signers = Vec::from_array(&env, [signer2.clone(), signer3.clone()]);
        client.mock_all_auths().set_signers(&approvers, &new_signers, &2u32);

        let config = client.get_config();
        assert_eq!(config.signers.len(), 2);
        assert_eq!(config.threshold, 2);
    }

    #[test]
    #[should_panic(expected = "Rotation requires")]
    fn test_duplicate_approvers_count_once_against_threshold() {
        // Approving twice with the same signer is still one approval — it
        // cannot be padded to reach the quorum.
        let env = Env::default();
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);
        let token = Address::generate(&env);

        let signers = Vec::from_array(&env, [signer1.clone(), signer2.clone()]);

        let contract_id = env.register(Multisig, ());
        let client = MultisigClient::new(&env, &contract_id);
        client.init(&signers, &2u32, &token);

        let duplicate_approvers = Vec::from_array(&env, [signer1.clone(), signer1.clone()]);
        let new_signers = Vec::from_array(&env, [signer2.clone()]);
        client
            .mock_all_auths()
            .set_signers(&duplicate_approvers, &new_signers, &1u32);
    }

    #[test]
    #[should_panic(expected = "Not an authorized signer")]
    fn test_rotation_rejects_approver_who_is_not_a_current_signer() {
        // An outsider listed as an approver is rejected even when a quorum of
        // signers is present.
        let env = Env::default();
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);
        let outsider = Address::generate(&env);
        let token = Address::generate(&env);

        let signers = Vec::from_array(&env, [signer1.clone(), signer2.clone()]);

        let contract_id = env.register(Multisig, ());
        let client = MultisigClient::new(&env, &contract_id);
        client.init(&signers, &2u32, &token);

        let approvers = Vec::from_array(&env, [signer1.clone(), outsider.clone()]);
        let new_signers = Vec::from_array(&env, [outsider.clone()]);
        client.mock_all_auths().set_signers(&approvers, &new_signers, &1u32);
    }

    #[test]
    fn test_rotation_requires_each_approver_to_authorize() {
        // Without mock auths, an approver who did not sign fails require_auth
        // and the configuration is left unchanged.
        let env = Env::default();
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);
        let token = Address::generate(&env);

        let signers = Vec::from_array(&env, [signer1.clone(), signer2.clone()]);

        let contract_id = env.register(Multisig, ());
        let client = MultisigClient::new(&env, &contract_id);
        client.init(&signers, &2u32, &token);

        let approvers = Vec::from_array(&env, [signer1.clone(), signer2.clone()]);
        let new_signers = Vec::from_array(&env, [signer1.clone()]);

        // No auth payload → require_auth for signer1 must fail.
        let result = client.try_set_signers(&approvers, &new_signers, &1u32);
        assert!(result.is_err());

        // Config unchanged.
        let config = client.get_config();
        assert_eq!(config.signers.len(), 2);
        assert_eq!(config.threshold, 2);
    }

    #[test]
    fn test_single_signer_rotation_allowed_when_threshold_is_one() {
        // In a 1-of-1 config the single signer IS the entire quorum and may
        // rotate (they could drain the wallet directly anyway).
        let env = Env::default();
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);
        let token = Address::generate(&env);

        let signers = Vec::from_array(&env, [signer1.clone()]);

        let contract_id = env.register(Multisig, ());
        let client = MultisigClient::new(&env, &contract_id);
        client.init(&signers, &1u32, &token);

        let approvers = Vec::from_array(&env, [signer1.clone()]);
        let new_signers = Vec::from_array(&env, [signer2.clone()]);
        client.mock_all_auths().set_signers(&approvers, &new_signers, &1u32);

        let config = client.get_config();
        assert_eq!(config.signers.len(), 1);
        assert_eq!(config.signers.get(0).unwrap(), signer2);
        assert_eq!(config.threshold, 1);
    }

    #[test]
    fn test_proposal_enumeration() {
        let env = Env::default();
        let signer1 = Address::generate(&env);
        let token = Address::generate(&env);
        let destination = Address::generate(&env);

        let signers = Vec::from_array(&env, [signer1.clone()]);

        let contract_id = env.register(Multisig, ());
        let client = MultisigClient::new(&env, &contract_id);
        client.init(&signers, &1u32, &token);

        client.propose(&destination, &10i128);
        client.propose(&destination, &20i128);
        client.propose(&destination, &30i128);

        assert_eq!(client.get_proposal_count(), 3);

        let page = client.get_proposals(&1, &2);
        assert_eq!(page.len(), 2);
        assert_eq!(page.get(0).unwrap().amount, 20);
        assert_eq!(page.get(1).unwrap().amount, 30);
    }

    #[test]
    fn test_get_proposals_limit_is_clamped() {
        // A caller must not be able to request an unbounded page: the limit is
        // clamped to MAX_PAGE_SIZE, so a single read can never issue more than
        // 100 storage reads.
        let env = Env::default();
        let signer1 = Address::generate(&env);
        let token = Address::generate(&env);
        let destination = Address::generate(&env);

        let signers = Vec::from_array(&env, [signer1.clone()]);

        let contract_id = env.register(Multisig, ());
        let client = MultisigClient::new(&env, &contract_id);
        client.init(&signers, &1u32, &token);

        for i in 0..150 {
            client.propose(&destination, &((i + 1) as i128 * 10));
        }

        // Request 150 entries — only MAX_PAGE_SIZE are returned.
        let page = client.get_proposals(&0, &150);
        assert_eq!(page.len(), MAX_PAGE_SIZE);

        // A u32::MAX offset must not panic (saturating arithmetic) and simply
        // returns nothing.
        let overflow = client.get_proposals(&u32::MAX, &u32::MAX);
        assert_eq!(overflow.len(), 0);
    }

    #[test]
    fn test_reads_do_not_extend_ttl() {
        // Read-only functions must not bump the instance TTL: an unbounded
        // read flood from any caller would otherwise keep the contract alive
        // forever. init + propose already extended it, so a subsequent read
        // must leave it exactly unchanged.
        let env = Env::default();
        let signer1 = Address::generate(&env);
        let token = Address::generate(&env);
        let destination = Address::generate(&env);

        let signers = Vec::from_array(&env, [signer1.clone()]);

        let contract_id = env.register(Multisig, ());
        let client = MultisigClient::new(&env, &contract_id);
        client.init(&signers, &1u32, &token);

        let proposal_id = client.propose(&destination, &100_000_000i128);

        let ttl_before = env.as_contract(&contract_id, || env.storage().instance().get_ttl());

        // Read-only calls: config + lookups + an aggressive page request.
        client.get_config();
        client.get_proposal(&proposal_id);
        client.get_proposals(&0, &u32::MAX);
        client.get_proposal_count();

        let ttl_after = env.as_contract(&contract_id, || env.storage().instance().get_ttl());
        assert_eq!(
            ttl_after, ttl_before,
            "a read-only call must not extend the instance TTL"
        );
    }

    // ── Storage TTL tests ────────────────────────

    #[test]
    fn test_ttl_extended_after_init() {
        // The network default persistent TTL is only ~4096 ledgers. `init`
        // must explicitly extend the instance + code TTL far past that, or
        // the contract would be archived within hours.
        let env = Env::default();
        let signer1 = Address::generate(&env);
        let token = Address::generate(&env);
        let signers = Vec::from_array(&env, [signer1.clone()]);

        let contract_id = env.register(Multisig, ());
        let client = MultisigClient::new(&env, &contract_id);
        client.init(&signers, &1u32, &token);

        // Storage access from tests must run in the contract's context.
        let ttl = env.as_contract(&contract_id, || env.storage().instance().get_ttl());
        assert!(
            ttl >= LEDGERS_TO_LIVE,
            "contract instance TTL was not extended past the network default"
        );
    }

    #[test]
    fn test_proposal_survives_default_ttl() {
        // Without explicit TTL extension a proposal would be archived after
        // ~4096 ledgers. Jump well past that and verify the proposal is
        // still readable (a read of an archived entry errors in tests).
        let env = Env::default();
        let signer1 = Address::generate(&env);
        let token = Address::generate(&env);
        let destination = Address::generate(&env);
        let signers = Vec::from_array(&env, [signer1.clone()]);

        let contract_id = env.register(Multisig, ());
        let client = MultisigClient::new(&env, &contract_id);
        client.init(&signers, &1u32, &token);

        let proposal_id = client.propose(&destination, &100_000_000i128);

        // The write path itself must extend the instance TTL — not just init.
        let ttl = env.as_contract(&contract_id, || env.storage().instance().get_ttl());
        assert!(
            ttl >= LEDGERS_TO_LIVE,
            "propose did not extend the instance TTL"
        );

        // Jump 100k ledgers (>> the ~4096 default TTL, < LEDGERS_TO_LIVE).
        env.ledger()
            .set_sequence_number(env.ledger().sequence() + 100_000);

        let proposal = client.get_proposal(&proposal_id);
        assert_eq!(proposal.amount, 100_000_000i128);
        assert!(!proposal.executed);
        assert_eq!(client.get_proposal_count(), 1);
    }

    // ── Boundary / rotation config-validation edge tests ──

    #[test]
    #[should_panic]
    fn test_approve_nonexistent_proposal_panics() {
        // Approving a proposal id that was never created must not silently
        // succeed — the missing storage entry panics rather than corrupting
        // state or minting an approval out of thin air.
        let env = Env::default();
        let signer1 = Address::generate(&env);
        let token = Address::generate(&env);

        let signers = Vec::from_array(&env, [signer1.clone()]);

        let contract_id = env.register(Multisig, ());
        let client = MultisigClient::new(&env, &contract_id);
        client.init(&signers, &1u32, &token);

        client.mock_all_auths().approve(&signer1, &999u32);
    }

    #[test]
    #[should_panic(
        expected = "Rotation requires at least the threshold of current signer approvals"
    )]
    fn test_rotation_with_no_approvers_rejected() {
        // Even in a 1-of-N configuration, an empty approver list can never
        // meet the current threshold — rotation needs at least one real
        // current signer.
        let env = Env::default();
        let signer1 = Address::generate(&env);
        let token = Address::generate(&env);

        let signers = Vec::from_array(&env, [signer1.clone()]);

        let contract_id = env.register(Multisig, ());
        let client = MultisigClient::new(&env, &contract_id);
        client.init(&signers, &1u32, &token);

        let empty_approvers = Vec::new(&env);
        let replacement = Vec::from_array(&env, [Address::generate(&env)]);
        client.set_signers(&empty_approvers, &replacement, &1u32);
    }

    #[test]
    #[should_panic(expected = "Threshold must be at least 1")]
    fn test_rotation_rejects_zero_new_threshold() {
        // The quorum is met, but the new configuration is still invalid: a
        // threshold of 0 would let a single (or no) signer authorize payouts.
        let env = Env::default();
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);
        let token = Address::generate(&env);

        let signers = Vec::from_array(&env, [signer1.clone(), signer2.clone()]);

        let contract_id = env.register(Multisig, ());
        let client = MultisigClient::new(&env, &contract_id);
        client.init(&signers, &2u32, &token);

        let approvers = Vec::from_array(&env, [signer1.clone(), signer2.clone()]);
        let replacement = Vec::from_array(&env, [Address::generate(&env)]);
        client.mock_all_auths().set_signers(&approvers, &replacement, &0u32);
    }

    #[test]
    #[should_panic(expected = "Threshold cannot exceed number of signers")]
    fn test_rotation_rejects_threshold_exceeding_new_signers() {
        let env = Env::default();
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);
        let token = Address::generate(&env);

        let signers = Vec::from_array(&env, [signer1.clone(), signer2.clone()]);

        let contract_id = env.register(Multisig, ());
        let client = MultisigClient::new(&env, &contract_id);
        client.init(&signers, &2u32, &token);

        // Quorum met (2-of-2), but the rotated config demands 3 approvals
        // from a 1-signer set — invalid.
        let approvers = Vec::from_array(&env, [signer1.clone(), signer2.clone()]);
        let replacement = Vec::from_array(&env, [signer1.clone()]);
        client.mock_all_auths().set_signers(&approvers, &replacement, &3u32);
    }

    #[test]
    #[should_panic(expected = "Duplicate signers are not allowed")]
    fn test_rotation_rejects_duplicate_new_signers() {
        let env = Env::default();
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);
        let token = Address::generate(&env);

        let signers = Vec::from_array(&env, [signer1.clone(), signer2.clone()]);

        let contract_id = env.register(Multisig, ());
        let client = MultisigClient::new(&env, &contract_id);
        client.init(&signers, &2u32, &token);

        // Quorum met, but the rotated signer set contains a duplicate — a
        // single address counting twice would let one key dominate the set.
        let approvers = Vec::from_array(&env, [signer1.clone(), signer2.clone()]);
        let duplicated = Vec::from_array(&env, [signer1.clone(), signer1.clone()]);
        client
            .mock_all_auths()
            .set_signers(&approvers, &duplicated, &2u32);
    }
}
