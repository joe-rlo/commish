//! Commish: a fantasy league's dues sit in the league's own Sputnik DAO vault, and winners
//! are paid from the league's Sleeper results, computed by an attested OutLayer job.
//!
//! One contract serves every league. It never holds league money: dues are forwarded to the
//! vault inside the same `ft_on_transfer`, and payouts are vault `Transfer` proposals that
//! this contract (the vault's `settler` role) approves only after the hold window.
//!
//! What each party can do:
//! - **Anyone**: create a league, claim a team, pay dues for a team, `settle` a final week
//!   or season, `finalize` after the hold window.
//! - **Commissioner**: approve or decline team claims, change rules before the first payment.
//!   No commissioner method moves money.
//! - **The league's vault** (a league majority): reassign a team.
//! - **Nobody**: change the pinned job or the deploy-time config. There are no admin methods.
//!
//! Invariants (each has a test in `tests/`):
//! - this contract holds no league tokens once `ft_on_transfer` resolves
//! - a settlement key settles once
//! - payouts go only to approved accounts of the winning rosters, within the rules and the pot
//! - rules can't change after the first dues payment
//! - the commissioner has no method that moves money
//! - `finalize` before the hold window ends fails

mod dues;
mod league;
mod settle;
pub mod types;
pub mod vault;

use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault};
pub use types::*;

pub(crate) const TGAS: u64 = 1_000_000_000_000;
pub(crate) const fn tgas(n: u64) -> Gas {
    Gas::from_gas(n * TGAS)
}
pub(crate) const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
pub(crate) const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);

/// Hold window limits (SPEC 5.2): 1 to 72 hours; demo leagues from 10 seconds.
pub const MIN_HOLD_NS: u64 = 3_600 * 1_000_000_000;
pub const MAX_HOLD_NS: u64 = 72 * 3_600 * 1_000_000_000;
pub const DEMO_MIN_HOLD_NS: u64 = 10 * 1_000_000_000;
/// Dues limits (SPEC 5.2): $1 to $10,000 in a 6-decimal token.
pub const MIN_DUES: u128 = 1_000_000;
pub const MAX_DUES: u128 = 10_000_000_000;
pub const MAX_ROSTERS: usize = 32;
/// A settlement request with no answer after this long may be requested again.
pub const STALE_REQUEST_NS: u64 = 20 * 60 * 1_000_000_000;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Leagues,
    Teams,
    Settlements,
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Contract {
    config: Config,
    leagues: Vector<League>,
    teams: LookupMap<u64, Vec<Team>>,
    settlements: LookupMap<String, Settlement>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(config: Config) -> Self {
        validate_config(&config);
        Self {
            config,
            leagues: Vector::new(StorageKey::Leagues),
            teams: LookupMap::new(StorageKey::Teams),
            settlements: LookupMap::new(StorageKey::Settlements),
        }
    }

    // ---------- views ----------

    pub fn get_config(&self) -> Config {
        self.config.clone()
    }

    pub fn get_league(&self, league_id: u64) -> Option<LeagueView> {
        let league = self.leagues.get(league_id as u32)?.clone();
        let teams = self.teams.get(&league_id).cloned().unwrap_or_default();
        Some(LeagueView {
            team_count: teams.len() as u32,
            paid_count: teams.iter().filter(|t| t.dues_paid.0 >= league.dues.0).count() as u32,
            approved_count: teams.iter().filter(|t| t.claim == ClaimStatus::Approved).count() as u32,
            pending_claims: teams.iter().filter(|t| matches!(t.claim, ClaimStatus::Pending(_))).count() as u32,
            league,
        })
    }

    pub fn list_leagues(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<LeagueView> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(100);
        (from..self.leagues.len() as u64).take(limit as usize).filter_map(|id| self.get_league(id)).collect()
    }

    pub fn league_count(&self) -> u64 {
        self.leagues.len() as u64
    }

    /// The newest demo league created by the demo admin, if any.
    pub fn latest_demo_league(&self) -> Option<LeagueView> {
        let admin = self.config.demo_admin.as_ref()?;
        (0..self.leagues.len())
            .rev()
            .filter_map(|i| self.leagues.get(i))
            .find(|l| l.is_demo && &l.commissioner == admin && l.status == LeagueStatus::Active)
            .and_then(|l| self.get_league(l.id))
    }

    pub fn get_teams(&self, league_id: u64) -> Vec<Team> {
        self.teams.get(&league_id).cloned().unwrap_or_default()
    }

    pub fn get_settlement(&self, league_id: u64, key: SettlementKey) -> Option<Settlement> {
        self.settlements.get(&key.storage_key(league_id)).cloned()
    }

    /// Settlements of a league, newest first.
    pub fn get_settlements(&self, league_id: u64) -> Vec<SettlementView> {
        let Some(league) = self.leagues.get(league_id as u32) else { return vec![] };
        let mut out: Vec<SettlementView> = league
            .settlement_keys
            .iter()
            .filter_map(|k| self.settlements.get(&k.storage_key(league_id)))
            .map(|s| SettlementView { league_id, settlement: s.clone() })
            .collect();
        out.sort_by(|a, b| b.settlement.requested_at_ns.0.cmp(&a.settlement.requested_at_ns.0));
        out
    }

    /// The input this contract would send to the enclave for a settlement, so anyone can
    /// recompute it (the CLI's `verify` uses this).
    pub fn job_input(&self, league_id: u64, key: SettlementKey, now_ns: Option<near_sdk::json_types::U64>) -> String {
        let league = self.league(league_id);
        settle::job_input_json(league, key, now_ns.map(|n| n.0).unwrap_or_else(env::block_timestamp))
    }
}

impl Contract {
    pub(crate) fn league(&self, league_id: u64) -> &League {
        self.leagues.get(league_id as u32).unwrap_or_else(|| env::panic_str("No league with that id"))
    }

    pub(crate) fn league_mut(&mut self, league_id: u64) -> &mut League {
        self.leagues.get_mut(league_id as u32).unwrap_or_else(|| env::panic_str("No league with that id"))
    }

    pub(crate) fn teams_of(&self, league_id: u64) -> Vec<Team> {
        self.teams.get(&league_id).cloned().unwrap_or_default()
    }

    pub(crate) fn save_teams(&mut self, league_id: u64, teams: Vec<Team>) {
        self.teams.insert(league_id, teams);
    }

    pub(crate) fn active_league(&self, league_id: u64) -> &League {
        let league = self.league(league_id);
        require!(league.status == LeagueStatus::Active, "The league's vault isn't ready yet");
        league
    }
}

fn validate_config(c: &Config) {
    require!(!c.job_wasm_url.is_empty() && c.job_wasm_url.starts_with("https://"), "job_wasm_url must be https");
    require!(
        c.job_wasm_sha256.len() == 64 && c.job_wasm_sha256.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
        "job_wasm_sha256 must be 64 lowercase hex characters"
    );
    require!(c.core_version == settle_core::CORE_VERSION, "core_version must match the settle-core this contract was built with");
    let p = &c.vault_name_prefix;
    require!(
        !p.is_empty() && p.len() <= 24 && p.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            && !p.starts_with('-'),
        "vault_name_prefix must be 1-24 of a-z, 0-9, '-'"
    );
    require!(c.vault_deposit.0 > 0 && c.token_storage_deposit.0 > 0 && c.outlayer_deposit.0 > 0, "deposits must be set");
}

/// Emits a NEP-297 event.
pub(crate) fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        near_sdk::serde_json::json!({ "standard": "commish", "version": "1.0.0", "event": event, "data": [data] })
    ));
}

