//! Creating a league and its vault, rule changes, and team claims.

use crate::vault::{vault_init_args, LEAGUE_ROLE};
use crate::*;
use near_sdk::json_types::{Base64VecU8, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::{Promise, PromiseError};

const GAS_FACTORY_CREATE: Gas = tgas(170);
const GAS_ON_VAULT_CREATED: Gas = tgas(40);
const GAS_STORAGE_DEPOSIT: Gas = tgas(10);
const GAS_ON_VAULT_REGISTERED: Gas = tgas(10);
pub(crate) const GAS_ADD_PROPOSAL: Gas = tgas(20);
const GAS_ON_MEMBER_PROPOSAL: Gas = tgas(50);
pub(crate) const GAS_ACT_PROPOSAL: Gas = tgas(30);

/// NEAR this contract keeps for a league's own storage here.
pub const LEAGUE_STORAGE_DEPOSIT: u128 = 50_000_000_000_000_000_000_000; // 0.05 NEAR

#[near]
impl Contract {
    /// Creates a league and its vault. The caller becomes the commissioner.
    ///
    /// Attach `vault_deposit + token_storage_deposit + 0.05 NEAR`; any excess is refunded.
    #[payable]
    pub fn create_league(&mut self, args: CreateLeagueArgs) -> u64 {
        let commissioner = env::predecessor_account_id();
        validate_league_args(&args, args.is_demo, &self.config, &commissioner);
        let required = self.config.vault_deposit.0 + self.config.token_storage_deposit.0 + LEAGUE_STORAGE_DEPOSIT;
        let attached = env::attached_deposit().as_yoctonear();
        require!(
            attached >= required,
            format!("Attach at least {required} yoctoNEAR to create the league's vault")
        );

        let id = self.leagues.len() as u64;
        let league = League {
            id,
            sleeper_league_id: args.sleeper_league_id.clone(),
            season: args.season.clone(),
            name: args.name.chars().take(80).collect(),
            commissioner: commissioner.clone(),
            vault: None,
            token: self.config.default_token_id.clone(),
            dues: args.dues,
            weekly_amount: args.weekly_amount,
            regular_season_weeks: args.regular_season_weeks,
            season_split_bps: args.season_split_bps.clone(),
            hold_window_ns: args.hold_window_ns,
            withhold_unpaid: args.withhold_unpaid,
            rules_locked: false,
            is_demo: args.is_demo,
            status: LeagueStatus::CreatingVault,
            created_at_ns: U64(env::block_timestamp()),
            dues_total: U128(0),
            on_hold_total: U128(0),
            settlement_keys: vec![],
        };
        self.leagues.push(league.clone());
        let teams: Vec<Team> = args
            .rosters
            .iter()
            .map(|r| Team {
                roster_id: r.roster_id,
                sleeper_owner_id: r.sleeper_owner_id.clone(),
                account: None,
                claim: ClaimStatus::Unclaimed,
                dues_paid: U128(0),
            })
            .collect();
        self.teams.insert(id, teams);

        let refund = attached - required;
        if refund > 0 {
            Promise::new(commissioner.clone()).transfer(NearToken::from_yoctonear(refund)).detach();
        }

        let name = format!("{}{}", self.config.vault_name_prefix, id);
        let init = vault_init_args(&name, &league.name, &league.sleeper_league_id, &env::current_account_id(), &commissioner);
        let create_args = json!({
            "name": name,
            "args": Base64VecU8(near_sdk::serde_json::to_vec(&init).unwrap()),
        });
        emit("league_created", json!({ "league_id": id, "commissioner": commissioner, "sleeper_league_id": league.sleeper_league_id }));
        Promise::new(self.config.sputnik_factory_id.clone())
            .function_call(
                "create".to_string(),
                near_sdk::serde_json::to_vec(&create_args).unwrap(),
                NearToken::from_yoctonear(self.config.vault_deposit.0),
                GAS_FACTORY_CREATE,
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_VAULT_CREATED).on_vault_created(id))
            .detach();
        id
    }

    #[private]
    pub fn on_vault_created(&mut self, league_id: u64, #[callback_result] created: Result<bool, PromiseError>) {
        let ok = matches!(created, Ok(true));
        let vault_deposit = self.config.vault_deposit.0;
        let token_deposit = self.config.token_storage_deposit.0;
        let vault: AccountId = format!("{}{}.{}", self.config.vault_name_prefix, league_id, self.config.sputnik_factory_id)
            .parse()
            .unwrap();
        let league = self.league_mut(league_id);
        if !ok {
            // The factory returns the deposit to us when it fails; pass it on. The vault and
            // token-registration deposits come back; the league's storage deposit stays.
            league.status = LeagueStatus::Failed;
            let commissioner = league.commissioner.clone();
            emit("league_failed", json!({ "league_id": league_id }));
            Promise::new(commissioner).transfer(NearToken::from_yoctonear(vault_deposit + token_deposit)).detach();
            return;
        }
        league.vault = Some(vault.clone());
        let token = league.token.clone();
        // Register the vault with the token so it can receive dues.
        Promise::new(token)
            .function_call(
                "storage_deposit".to_string(),
                near_sdk::serde_json::to_vec(&json!({ "account_id": vault, "registration_only": true })).unwrap(),
                NearToken::from_yoctonear(token_deposit),
                GAS_STORAGE_DEPOSIT,
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_VAULT_REGISTERED).on_vault_registered(league_id))
            .detach();
    }

    #[private]
    pub fn on_vault_registered(&mut self, league_id: u64, #[callback_result] r: Result<Value, PromiseError>) {
        let league = self.league_mut(league_id);
        if r.is_err() {
            // The vault exists but can't receive the token: no dues can be paid. Mark it failed.
            league.status = LeagueStatus::Failed;
            emit("league_failed", json!({ "league_id": league_id, "reason": "token registration failed" }));
            return;
        }
        league.status = LeagueStatus::Active;
        emit("league_active", json!({ "league_id": league_id, "vault": league.vault }));
    }

    /// Commissioner only, before the first dues payment.
    pub fn update_rules(&mut self, league_id: u64, update: RulesUpdate) {
        let caller = env::predecessor_account_id();
        let config = self.config.clone();
        let team_count = self.teams_of(league_id).len();
        let league = self.league_mut(league_id);
        require!(caller == league.commissioner, "Only the commissioner can change the rules");
        require!(!league.rules_locked, "Rules are locked: a team has already paid");
        if let Some(v) = update.dues {
            league.dues = v;
        }
        if let Some(v) = update.weekly_amount {
            league.weekly_amount = v;
        }
        if let Some(v) = update.season_split_bps {
            league.season_split_bps = v;
        }
        if let Some(v) = update.hold_window_ns {
            league.hold_window_ns = v;
        }
        if let Some(v) = update.withhold_unpaid {
            league.withhold_unpaid = v;
        }
        validate_rules(league, team_count, &config);
        emit("rules_updated", json!({ "league_id": league_id }));
    }

    /// Claims a team for the caller. The commissioner approves or declines.
    pub fn claim_team(&mut self, league_id: u64, roster_id: u16) {
        let who = env::predecessor_account_id();
        self.active_league(league_id);
        let mut teams = self.teams_of(league_id);
        require!(
            !teams.iter().any(|t| t.account.as_ref() == Some(&who) || t.claim == ClaimStatus::Pending(who.clone())),
            "You already have a team in this league"
        );
        let team = teams.iter_mut().find(|t| t.roster_id == roster_id).unwrap_or_else(|| env::panic_str("No such team"));
        require!(team.claim == ClaimStatus::Unclaimed, "That team is already claimed");
        team.claim = ClaimStatus::Pending(who.clone());
        self.save_teams(league_id, teams);
        emit("team_claimed", json!({ "league_id": league_id, "roster_id": roster_id, "account": who }));
    }

    /// Commissioner only. Approves a pending claim: the account gets the team's payouts,
    /// joins the vault's `league` role, and is registered with the token.
    /// Attach `token_storage_deposit` for the registration.
    #[payable]
    pub fn approve_claim(&mut self, league_id: u64, roster_id: u16) {
        let caller = env::predecessor_account_id();
        let league = self.active_league(league_id).clone();
        require!(caller == league.commissioner, "Only the commissioner can approve claims");
        require!(
            env::attached_deposit().as_yoctonear() >= self.config.token_storage_deposit.0,
            format!("Attach {} yoctoNEAR to register the member with the token", self.config.token_storage_deposit.0)
        );
        let mut teams = self.teams_of(league_id);
        let team = teams.iter_mut().find(|t| t.roster_id == roster_id).unwrap_or_else(|| env::panic_str("No such team"));
        let ClaimStatus::Pending(member) = team.claim.clone() else { env::panic_str("That team has no pending claim") };
        team.claim = ClaimStatus::Approved;
        team.account = Some(member.clone());
        self.save_teams(league_id, teams);
        emit("claim_approved", json!({ "league_id": league_id, "roster_id": roster_id, "account": member }));
        self.register_with_token(&league.token, &member, env::attached_deposit());
        self.propose_membership(&league, &member, true);
    }

    /// Commissioner only. Returns a pending claim to unclaimed.
    pub fn decline_claim(&mut self, league_id: u64, roster_id: u16) {
        let caller = env::predecessor_account_id();
        let league = self.league(league_id).clone();
        require!(caller == league.commissioner, "Only the commissioner can decline claims");
        let mut teams = self.teams_of(league_id);
        let team = teams.iter_mut().find(|t| t.roster_id == roster_id).unwrap_or_else(|| env::panic_str("No such team"));
        require!(matches!(team.claim, ClaimStatus::Pending(_)), "That team has no pending claim");
        team.claim = ClaimStatus::Unclaimed;
        self.save_teams(league_id, teams);
        emit("claim_declined", json!({ "league_id": league_id, "roster_id": roster_id }));
    }

    /// The league's vault only (a league majority, through a `FunctionCall` proposal).
    /// Moves a team to another account. Attach `token_storage_deposit` for the registration.
    #[payable]
    pub fn reassign_team(&mut self, league_id: u64, roster_id: u16, account: AccountId) {
        let league = self.active_league(league_id).clone();
        require!(Some(env::predecessor_account_id()) == league.vault, "Only the league's vault can reassign a team");
        let mut teams = self.teams_of(league_id);
        require!(
            !teams.iter().any(|t| t.roster_id != roster_id && t.account.as_ref() == Some(&account)),
            "That account already has a team in this league"
        );
        let team = teams.iter_mut().find(|t| t.roster_id == roster_id).unwrap_or_else(|| env::panic_str("No such team"));
        let old = team.account.replace(account.clone());
        team.claim = ClaimStatus::Approved;
        self.save_teams(league_id, teams);
        emit("team_reassigned", json!({ "league_id": league_id, "roster_id": roster_id, "from": old, "to": account }));
        if env::attached_deposit().as_yoctonear() >= self.config.token_storage_deposit.0 {
            self.register_with_token(&league.token, &account, env::attached_deposit());
        }
        if let Some(old) = old {
            if old != league.commissioner && old != account {
                self.propose_membership(&league, &old, false);
            }
        }
        if account != league.commissioner {
            self.propose_membership(&league, &account, true);
        }
    }

    /// Second half of a membership change: approve the proposal this contract just made.
    #[private]
    pub fn on_member_proposal(&mut self, league_id: u64, kind: Value, #[callback_result] id: Result<u64, PromiseError>) {
        let Ok(id) = id else {
            emit("membership_failed", json!({ "league_id": league_id, "kind": kind }));
            return;
        };
        let vault = self.league(league_id).vault.clone().unwrap();
        Promise::new(vault)
            .function_call(
                "act_proposal".to_string(),
                near_sdk::serde_json::to_vec(&json!({ "id": id, "action": "VoteApprove", "proposal": kind, "memo": "commish" })).unwrap(),
                NO_DEPOSIT,
                GAS_ACT_PROPOSAL,
            )
            .detach();
    }
}

impl Contract {
    pub(crate) fn register_with_token(&self, token: &AccountId, account: &AccountId, deposit: NearToken) {
        Promise::new(token.clone())
            .function_call(
                "storage_deposit".to_string(),
                near_sdk::serde_json::to_vec(&json!({ "account_id": account, "registration_only": true })).unwrap(),
                NearToken::from_yoctonear(deposit.as_yoctonear().min(self.config.token_storage_deposit.0)),
                GAS_STORAGE_DEPOSIT,
            )
            .detach();
    }

    /// Adds (or removes) a member of the vault's `league` role: a proposal, then this
    /// contract's approval as the vault's `settler`.
    pub(crate) fn propose_membership(&self, league: &League, member: &AccountId, add: bool) {
        let vault = league.vault.clone().unwrap();
        let kind = if add {
            json!({ "AddMemberToRole": { "member_id": member, "role": LEAGUE_ROLE } })
        } else {
            json!({ "RemoveMemberFromRole": { "member_id": member, "role": LEAGUE_ROLE } })
        };
        let description = format!(
            "Commish: {} {} {} the league (league {})",
            if add { "add" } else { "remove" },
            member,
            if add { "to" } else { "from" },
            league.id
        );
        Promise::new(vault)
            .function_call(
                "add_proposal".to_string(),
                near_sdk::serde_json::to_vec(&json!({ "proposal": { "description": description, "kind": kind } })).unwrap(),
                NO_DEPOSIT,
                GAS_ADD_PROPOSAL,
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_MEMBER_PROPOSAL).on_member_proposal(league.id, kind))
            .detach();
    }
}

fn is_digits(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && s.bytes().all(|b| b.is_ascii_digit())
}

pub(crate) fn validate_league_args(a: &CreateLeagueArgs, is_demo: bool, config: &Config, caller: &AccountId) {
    require!(is_digits(&a.sleeper_league_id, 32), "sleeper_league_id must be digits");
    require!(is_digits(&a.season, 4) && a.season.len() == 4, "season must be a 4-digit year");
    require!(!a.name.trim().is_empty(), "name is required");
    if is_demo {
        require!(config.demo_admin.as_ref() == Some(caller), "Only the demo admin can create demo leagues");
    }
    let n = a.rosters.len();
    require!((2..=MAX_ROSTERS).contains(&n), "A league needs 2 to 32 teams");
    let mut ids: Vec<u16> = a.rosters.iter().map(|r| r.roster_id).collect();
    ids.sort_unstable();
    require!(ids.windows(2).all(|w| w[0] != w[1]), "Duplicate roster_id");
    for r in &a.rosters {
        if let Some(o) = &r.sleeper_owner_id {
            require!(is_digits(o, 32), "sleeper_owner_id must be digits");
        }
    }
    let probe = League {
        id: 0,
        sleeper_league_id: String::new(),
        season: String::new(),
        name: String::new(),
        commissioner: caller.clone(),
        vault: None,
        token: config.default_token_id.clone(),
        dues: a.dues,
        weekly_amount: a.weekly_amount,
        regular_season_weeks: a.regular_season_weeks,
        season_split_bps: a.season_split_bps.clone(),
        hold_window_ns: a.hold_window_ns,
        withhold_unpaid: a.withhold_unpaid,
        rules_locked: false,
        is_demo,
        status: LeagueStatus::CreatingVault,
        created_at_ns: U64(0),
        dues_total: U128(0),
        on_hold_total: U128(0),
        settlement_keys: vec![],
    };
    validate_rules(&probe, n, config);
}

pub(crate) fn validate_rules(l: &League, team_count: usize, _config: &Config) {
    require!((MIN_DUES..=MAX_DUES).contains(&l.dues.0), "Dues must be $1 to $10,000");
    let rules = settle_core::Rules {
        weekly_amount: settle_core::Amount(l.weekly_amount.0),
        regular_season_weeks: l.regular_season_weeks,
        season_split_bps: l.season_split_bps.clone(),
    };
    if let Err(e) = rules.validate() {
        env::panic_str(e);
    }
    let pot = l.dues.0 * team_count as u128;
    require!(
        l.weekly_amount.0 * l.regular_season_weeks as u128 <= pot,
        "Weekly payouts for the whole regular season must fit in the pot"
    );
    let min_hold = if l.is_demo { DEMO_MIN_HOLD_NS } else { MIN_HOLD_NS };
    require!(
        (min_hold..=MAX_HOLD_NS).contains(&l.hold_window_ns.0),
        if l.is_demo { "Demo hold window must be 10 seconds to 72 hours" } else { "Hold window must be 1 to 72 hours" }
    );
}
