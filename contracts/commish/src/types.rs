//! Contract state types (SPEC.md 7.4).

use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId};

/// Fixed at deploy time. There are no setters: the pinned job can't be swapped under a league.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Config {
    /// OutLayer contract (`outlayer.testnet`).
    pub outlayer_id: AccountId,
    /// Where OutLayer downloads the settlement job, and the SHA-256 it must have.
    pub job_wasm_url: String,
    pub job_wasm_sha256: String,
    pub job_build_target: String,
    /// settle-core version the job must report.
    pub core_version: String,
    /// Sputnik DAO factory (`sputnik-v2.testnet`).
    pub sputnik_factory_id: AccountId,
    /// Token leagues use by default (Test USDC on testnet).
    pub default_token_id: AccountId,
    /// Vaults are named `<prefix><league id>.<factory>`.
    pub vault_name_prefix: String,
    /// NEAR sent to the factory to create a vault (storage for the DAO contract).
    pub vault_deposit: U128,
    /// NEAR for one NEP-145 storage registration on the token.
    pub token_storage_deposit: U128,
    /// NEAR forwarded to OutLayer per settlement. Unused compute is refunded to the caller.
    pub outlayer_deposit: U128,
    /// NEAR kept per settlement to pay for its storage here.
    pub settle_storage_deposit: U128,
    /// The one account that may create demo leagues (short hold window).
    pub demo_admin: Option<AccountId>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LeagueStatus {
    /// The vault is being created.
    CreatingVault,
    /// The vault exists and is registered with the token.
    Active,
    /// Vault creation failed; the deposit was returned.
    Failed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct League {
    pub id: u64,
    pub sleeper_league_id: String,
    pub season: String,
    pub name: String,
    pub commissioner: AccountId,
    /// The league's Sputnik DAO, once created.
    pub vault: Option<AccountId>,
    pub token: AccountId,
    pub dues: U128,
    pub weekly_amount: U128,
    pub regular_season_weeks: u8,
    pub season_split_bps: Vec<u16>,
    pub hold_window_ns: U64,
    pub withhold_unpaid: bool,
    pub rules_locked: bool,
    pub is_demo: bool,
    pub status: LeagueStatus,
    pub created_at_ns: U64,
    /// Sum of all dues received.
    pub dues_total: U128,
    /// Sum of payouts sent to the vault as proposals and not yet finalized.
    pub on_hold_total: U128,
    /// Settlement keys in the order they were first requested.
    pub settlement_keys: Vec<SettlementKey>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClaimStatus {
    Unclaimed,
    /// Waiting for the commissioner.
    Pending(AccountId),
    Approved,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Team {
    pub roster_id: u16,
    pub sleeper_owner_id: Option<String>,
    /// The approved NEAR account that receives this team's payouts.
    pub account: Option<AccountId>,
    pub claim: ClaimStatus,
    pub dues_paid: U128,
}

/// What a settlement is for.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum SettlementKey {
    Week(u8),
    Season,
}

impl SettlementKey {
    pub fn storage_key(&self, league_id: u64) -> String {
        match self {
            SettlementKey::Week(w) => format!("{league_id}:w{w}"),
            SettlementKey::Season => format!("{league_id}:season"),
        }
    }

    pub fn label(&self) -> String {
        match self {
            SettlementKey::Week(w) => format!("Week {w} high score"),
            SettlementKey::Season => "Season payout".to_string(),
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettlementStatus {
    /// Waiting for the enclave.
    Requested,
    /// Result recorded; reading the pot and creating payouts.
    Computed,
    /// Payouts are vault proposals, waiting out the hold window.
    OnHold,
    /// Every payout is paid, stopped, withheld or failed.
    Final,
    /// The enclave run failed or returned an error (for example `WEEK_NOT_FINAL`). Can be retried.
    Failed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayoutStatus {
    /// The vault proposal is being created.
    Pending,
    /// The vault proposal exists; the hold window is running.
    OnHold,
    /// Approved by the vault; the transfer was sent.
    Paid,
    /// The league rejected or removed the proposal, or it expired. The money stays in the pot.
    Stopped,
    /// Not paid by the rules (no account, dues unpaid, pot too small). The money stays in the pot.
    Withheld,
    /// The vault proposal couldn't be created.
    Failed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Payout {
    pub roster_id: u16,
    /// Season place (1, 2, 3); none for weekly.
    pub place: Option<u8>,
    pub account: Option<AccountId>,
    pub amount: U128,
    pub status: PayoutStatus,
    /// `no_account`, `dues_unpaid` or `pot_too_small` when withheld.
    pub withheld_reason: Option<String>,
    pub proposal_id: Option<u64>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct ScoreLine {
    pub roster_id: u16,
    pub points_x100: i64,
    pub missing: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug)]
pub struct PlacementLine {
    pub place: u8,
    pub roster_id: u16,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Settlement {
    pub key: SettlementKey,
    pub status: SettlementStatus,
    pub requested_by: AccountId,
    pub requested_at_ns: U64,
    /// SHA-256 of the input sent to OutLayer (equals the attestation's `input_hash`).
    pub input_sha256: String,
    /// SHA-256 of the enclave's output bytes (equals the attestation's `output_hash`).
    pub result_sha256: Option<String>,
    /// OutLayer request id; the attestation is at `/attestations/by-request/<id>`.
    pub attestation_ref: Option<String>,
    /// SHA-256 of the canonical Sleeper data the result came from.
    pub source_sha256: Option<String>,
    pub source_urls: Vec<String>,
    pub scores: Vec<ScoreLine>,
    pub placements: Vec<PlacementLine>,
    pub payouts: Vec<Payout>,
    /// The vault's token balance when payouts were computed.
    pub pot_balance: Option<U128>,
    /// Season only: the amount split between places.
    pub payout_base: Option<U128>,
    /// When the hold window started (the payouts became vault proposals).
    pub created_at_ns: Option<U64>,
    pub hold_ends_at_ns: Option<U64>,
    pub finalized_at_ns: Option<U64>,
    /// Why it failed (the enclave's error code and message, or what went wrong here).
    pub error: Option<String>,
}

/// Rosters as read from Sleeper when the league is created.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct RosterInit {
    pub roster_id: u16,
    pub sleeper_owner_id: Option<String>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct CreateLeagueArgs {
    pub sleeper_league_id: String,
    pub season: String,
    pub name: String,
    pub rosters: Vec<RosterInit>,
    pub dues: U128,
    pub weekly_amount: U128,
    pub regular_season_weeks: u8,
    pub season_split_bps: Vec<u16>,
    pub hold_window_ns: U64,
    pub withhold_unpaid: bool,
    #[serde(default)]
    pub is_demo: bool,
}

/// Rule changes before the first payment. Absent fields stay as they are.
#[near(serializers = [json])]
#[derive(Clone, Debug, Default)]
pub struct RulesUpdate {
    pub dues: Option<U128>,
    pub weekly_amount: Option<U128>,
    pub season_split_bps: Option<Vec<u16>>,
    pub hold_window_ns: Option<U64>,
    pub withhold_unpaid: Option<bool>,
}

/// `get_league` view.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct LeagueView {
    #[serde(flatten)]
    pub league: League,
    pub team_count: u32,
    pub paid_count: u32,
    pub approved_count: u32,
    pub pending_claims: u32,
}

/// `get_settlements` item.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SettlementView {
    pub league_id: u64,
    #[serde(flatten)]
    pub settlement: Settlement,
}
