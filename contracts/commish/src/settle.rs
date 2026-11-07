//! Settling a week or the season (SPEC.md 6, 7.3, 7.4).
//!
//! ```text
//! settle ──► outlayer.request_execution (pinned wasm) ── yield … resume ──► on_settle_result
//!   records the result (hashes, scores, placements, attestation ref)
//!   ──► token.ft_balance_of(vault) ──► on_settle_balance
//!   applies settle-core's amounts and withholding, then one vault Transfer proposal
//!   per payout ──► on_proposals_added (records proposal ids; hold window running)
//!
//! finalize (after the hold window) ──► [ft_balance_of(vault), get_proposal(id)…] ──► on_finalize_status
//!   InProgress → register the winner with the token, then approve (the vault pays)
//!   Approved   → paid (the league approved it early)
//!   Rejected / Removed / Expired → stopped, the money stays in the pot
//!   ──► on_finalize_done
//! ```
//!
//! The pinned job is the only way to produce a result: the contract names the wasm by its
//! SHA-256 in the OutLayer request, and OutLayer's worker refuses any other bytes.

use crate::league::{GAS_ACT_PROPOSAL, GAS_ADD_PROPOSAL};
use crate::vault::{ProposalStatus, PROPOSAL_PERIOD_NS};
use crate::*;
use near_sdk::json_types::U64;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::{Promise, PromiseError};
use settle_core::amounts::{apply_withholding, season_amounts, TeamState};
use settle_core::{Amount, JobInput, JobOutput, Kind, PayoutLine, Rules, U64Str};

const GAS_OUTLAYER: Gas = tgas(100);
const GAS_ON_SETTLE_RESULT: Gas = tgas(170);
const GAS_VIEW: Gas = tgas(5);
const GAS_ON_SETTLE_BALANCE: Gas = tgas(140);
const GAS_ON_PROPOSALS_ADDED: Gas = tgas(15);
const GAS_ON_FINALIZE_STATUS: Gas = tgas(230);
const GAS_REGISTER: Gas = tgas(8);
const GAS_ON_FINALIZE_DONE: Gas = tgas(15);
/// Largest enclave output we read.
const MAX_RESULT_BYTES: usize = 16 * 1024;
/// OutLayer resource limits for the job (it uses ~16M instructions and ~1.5 s).
const JOB_MAX_INSTRUCTIONS: u64 = 2_000_000_000;
const JOB_MAX_SECONDS: u64 = 60;
const JOB_MAX_MEMORY_MB: u32 = 128;

pub(crate) fn job_input_json(league: &League, key: SettlementKey, now_ns: u64) -> String {
    let (kind, week) = match key {
        SettlementKey::Week(w) => (Kind::WeeklyHighScore, Some(w)),
        SettlementKey::Season => (Kind::Season, None),
    };
    let input = JobInput {
        sleeper_league_id: league.sleeper_league_id.clone(),
        season: league.season.clone(),
        kind,
        week,
        rules: Rules {
            weekly_amount: Amount(league.weekly_amount.0),
            regular_season_weeks: league.regular_season_weeks,
            season_split_bps: league.season_split_bps.clone(),
        },
        now_ns: U64Str(now_ns),
    };
    serde_json::to_string(&input).unwrap()
}

fn sha256_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    env::sha256(bytes).iter().flat_map(|b| [HEX[(b >> 4) as usize] as char, HEX[(b & 15) as usize] as char]).collect()
}

fn transfer_kind(token: &AccountId, receiver: &AccountId, amount: u128) -> Value {
    json!({ "Transfer": { "token_id": token, "receiver_id": receiver, "amount": amount.to_string(), "msg": null } })
}

#[near]
impl Contract {
    /// Settles a week (`{"Week": 9}`) or the season (`"Season"`). Anyone can call it.
    ///
    /// Attach `outlayer_deposit + settle_storage_deposit`. OutLayer refunds unused compute
    /// to the caller. Needs 300 Tgas.
    #[payable]
    pub fn settle(&mut self, league_id: u64, key: SettlementKey) {
        let caller = env::predecessor_account_id();
        let league = self.active_league(league_id).clone();
        let now = env::block_timestamp();
        match key {
            SettlementKey::Week(w) => require!(
                w >= 1 && w <= league.regular_season_weeks,
                format!("Week {w} isn't a regular-season week (1 to {})", league.regular_season_weeks)
            ),
            SettlementKey::Season => {
                if league.weekly_amount.0 > 0 {
                    for w in 1..=league.regular_season_weeks {
                        let done = self.settlements.get(&SettlementKey::Week(w).storage_key(league_id)).map(|s| s.status);
                        require!(
                            matches!(done, Some(SettlementStatus::OnHold) | Some(SettlementStatus::Final)),
                            format!("Settle every week first: week {w} isn't settled yet")
                        );
                    }
                }
            }
        }
        if let Some(existing) = self.settlements.get(&key.storage_key(league_id)) {
            let stale = matches!(existing.status, SettlementStatus::Requested | SettlementStatus::Computed)
                && now > existing.requested_at_ns.0 + STALE_REQUEST_NS;
            require!(existing.status == SettlementStatus::Failed || stale, format!("{} is already settled", key.label()));
        }
        let needed = self.config.outlayer_deposit.0 + self.config.settle_storage_deposit.0;
        require!(env::attached_deposit().as_yoctonear() >= needed, format!("Attach {needed} yoctoNEAR to settle"));
        let to_outlayer = env::attached_deposit().as_yoctonear() - self.config.settle_storage_deposit.0;

        let input = job_input_json(&league, key, now);
        let settlement = Settlement {
            key,
            status: SettlementStatus::Requested,
            requested_by: caller.clone(),
            requested_at_ns: U64(now),
            input_sha256: sha256_hex(input.as_bytes()),
            result_sha256: None,
            attestation_ref: None,
            source_sha256: None,
            source_urls: vec![],
            scores: vec![],
            placements: vec![],
            payouts: vec![],
            pot_balance: None,
            payout_base: None,
            created_at_ns: None,
            hold_ends_at_ns: None,
            finalized_at_ns: None,
            error: None,
        };
        self.settlements.insert(key.storage_key(league_id), settlement);
        let l = self.league_mut(league_id);
        if !l.settlement_keys.contains(&key) {
            l.settlement_keys.push(key);
        }
        emit("settle_requested", json!({ "league_id": league_id, "key": key, "by": caller }));

        let args = json!({
            "source": { "WasmUrl": {
                "url": self.config.job_wasm_url,
                "hash": self.config.job_wasm_sha256,
                "build_target": self.config.job_build_target,
            }},
            "resource_limits": {
                "max_instructions": JOB_MAX_INSTRUCTIONS,
                "max_memory_mb": JOB_MAX_MEMORY_MB,
                "max_execution_seconds": JOB_MAX_SECONDS,
            },
            "input_data": input,
            "secrets_ref": null,
            "response_format": "Json",
            "payer_account_id": caller,
            "params": null,
        });
        Promise::new(self.config.outlayer_id.clone())
            .function_call(
                "request_execution".to_string(),
                serde_json::to_vec(&args).unwrap(),
                NearToken::from_yoctonear(to_outlayer),
                GAS_OUTLAYER,
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_SETTLE_RESULT).on_settle_result(league_id, key))
            .detach();
    }

    /// OutLayer's answer: the job's stdout (canonical JSON), or `null` if the run failed.
    #[private]
    pub fn on_settle_result(&mut self, league_id: u64, key: SettlementKey) {
        let bytes = match env::promise_result_checked(0, MAX_RESULT_BYTES) {
            Ok(b) => b,
            Err(PromiseError::Failed) => return self.fail(league_id, key, "The enclave request failed"),
            Err(_) => return self.fail(league_id, key, "The enclave result is too large"),
        };
        if bytes.is_empty() || bytes == b"null" {
            return self.fail(league_id, key, "The enclave run failed or timed out");
        }
        let result_sha = sha256_hex(&bytes);
        let out: JobOutput = match serde_json::from_slice(&bytes) {
            Ok(o) => o,
            Err(_) => return self.fail(league_id, key, "The enclave result isn't a settlement"),
        };
        let league = self.league(league_id).clone();
        let teams = self.teams_of(league_id);
        let mut s = self.settlements.get(&key.storage_key(league_id)).cloned().unwrap();
        s.result_sha256 = Some(result_sha);
        s.attestation_ref = out.outlayer_request_id.clone();

        if let Some(e) = &out.error {
            s.status = SettlementStatus::Failed;
            s.error = Some(format!("{}: {}", e.code.as_str(), e.message));
            emit("settle_failed", json!({ "league_id": league_id, "key": key, "error": s.error }));
            self.settlements.insert(key.storage_key(league_id), s);
            return;
        }
        if let Err(why) = check_result(&out, &league, key, &teams, &self.config) {
            self.settlements.insert(key.storage_key(league_id), s); // keep the hashes for the record
            return self.fail(league_id, key, &format!("Rejected the enclave result: {why}"));
        }
        let source = out.source.clone().unwrap();
        s.source_sha256 = Some(source.sha256);
        s.source_urls = source.urls;
        s.scores = out.scores.iter().map(|x| ScoreLine { roster_id: x.roster_id, points_x100: x.points_x100, missing: x.missing }).collect();
        s.placements = out
            .placements
            .clone()
            .unwrap_or_default()
            .iter()
            .map(|p| PlacementLine { place: p.place, roster_id: p.roster_id })
            .collect();
        s.payouts = out
            .payouts
            .iter()
            .map(|p| Payout {
                roster_id: p.roster_id,
                place: None,
                account: None,
                amount: U128(p.amount.0),
                status: PayoutStatus::Pending,
                withheld_reason: None,
                proposal_id: None,
            })
            .collect();
        s.status = SettlementStatus::Computed;
        self.settlements.insert(key.storage_key(league_id), s);

        Promise::new(league.token.clone())
            .function_call(
                "ft_balance_of".to_string(),
                serde_json::to_vec(&json!({ "account_id": league.vault })).unwrap(),
                NO_DEPOSIT,
                GAS_VIEW,
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_SETTLE_BALANCE).on_settle_balance(league_id, key))
            .detach();
    }

    /// The pot is known: compute amounts and withholding with settle-core, then propose payouts.
    #[private]
    pub fn on_settle_balance(&mut self, league_id: u64, key: SettlementKey, #[callback_result] balance: Result<U128, PromiseError>) {
        let Ok(balance) = balance else { return self.fail(league_id, key, "Couldn't read the pot's balance") };
        let league = self.league(league_id).clone();
        let teams = self.teams_of(league_id);
        let mut s = self.settlements.get(&key.storage_key(league_id)).cloned().unwrap();
        let available = balance.0.saturating_sub(league.on_hold_total.0);

        // Lines to pay before withholding, with season places.
        let lines: Vec<(PayoutLine, Option<u8>)> = match key {
            SettlementKey::Week(_) => {
                s.payouts.iter().map(|p| (PayoutLine { roster_id: p.roster_id, amount: Amount(p.amount.0) }, None)).collect()
            }
            SettlementKey::Season => {
                let placements: Vec<settle_core::Placement> =
                    s.placements.iter().map(|p| settle_core::Placement { place: p.place, roster_id: p.roster_id }).collect();
                match season_amounts(available, &league.season_split_bps, &placements) {
                    Ok(v) => {
                        s.payout_base = Some(U128(available));
                        v.into_iter()
                            .filter(|p| p.amount.0 > 0)
                            .map(|p| (PayoutLine { roster_id: p.roster_id, amount: p.amount }, Some(p.place)))
                            .collect()
                    }
                    Err(_) => return self.fail(league_id, key, "The season placements don't fit the league's split"),
                }
            }
        };
        let states: Vec<TeamState> = teams
            .iter()
            .map(|t| TeamState {
                roster_id: t.roster_id,
                has_approved_account: t.claim == ClaimStatus::Approved && t.account.is_some(),
                dues: Amount(league.dues.0),
                dues_paid: Amount(t.dues_paid.0),
            })
            .collect();
        let plain: Vec<PayoutLine> = lines.iter().map(|(l, _)| l.clone()).collect();
        let decisions = apply_withholding(&plain, &states, league.withhold_unpaid, available);

        let now = env::block_timestamp();
        s.pot_balance = Some(balance);
        s.payouts = decisions
            .iter()
            .zip(lines.iter())
            .map(|(d, (_, place))| {
                let account = teams.iter().find(|t| t.roster_id == d.roster_id).and_then(|t| t.account.clone());
                Payout {
                    roster_id: d.roster_id,
                    place: *place,
                    account,
                    amount: U128(d.amount.0),
                    status: if d.withheld.is_some() { PayoutStatus::Withheld } else { PayoutStatus::Pending },
                    withheld_reason: d.withheld.map(|r| r.as_str().to_string()),
                    proposal_id: None,
                }
            })
            .collect();

        let to_pay: Vec<usize> = (0..s.payouts.len()).filter(|&i| s.payouts[i].status == PayoutStatus::Pending).collect();
        if to_pay.is_empty() {
            s.status = SettlementStatus::Final;
            s.finalized_at_ns = Some(U64(now));
            emit("settled", json!({ "league_id": league_id, "key": key, "paid": 0 }));
            self.settlements.insert(key.storage_key(league_id), s);
            return;
        }
        let vault = league.vault.clone().unwrap();
        let mut batch: Option<Promise> = None;
        let mut held = 0u128;
        for &i in &to_pay {
            let p = &s.payouts[i];
            held += p.amount.0;
            let description = format!(
                "Commish: {} · roster {} · {} · commish:{}:{}:{}",
                key.label(),
                p.roster_id,
                p.account.as_ref().unwrap(),
                league_id,
                match key { SettlementKey::Week(w) => format!("w{w}"), SettlementKey::Season => "season".into() },
                p.roster_id
            );
            let call = Promise::new(vault.clone()).function_call(
                "add_proposal".to_string(),
                serde_json::to_vec(&json!({ "proposal": {
                    "description": description,
                    "kind": transfer_kind(&league.token, p.account.as_ref().unwrap(), p.amount.0),
                }}))
                .unwrap(),
                NO_DEPOSIT,
                GAS_ADD_PROPOSAL,
            );
            batch = Some(match batch { None => call, Some(b) => b.and(call) });
        }
        s.status = SettlementStatus::OnHold;
        s.created_at_ns = Some(U64(now));
        s.hold_ends_at_ns = Some(U64(now + league.hold_window_ns.0));
        self.settlements.insert(key.storage_key(league_id), s);
        let l = self.league_mut(league_id);
        l.on_hold_total = U128(l.on_hold_total.0 + held);
        let idx: Vec<u8> = to_pay.iter().map(|&i| i as u8).collect();
        batch
            .unwrap()
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_PROPOSALS_ADDED).on_proposals_added(league_id, key, idx))
            .detach();
    }

    #[private]
    pub fn on_proposals_added(&mut self, league_id: u64, key: SettlementKey, idx: Vec<u8>) {
        let mut s = self.settlements.get(&key.storage_key(league_id)).cloned().unwrap();
        let mut released = 0u128;
        for (n, &i) in idx.iter().enumerate() {
            let id: Option<u64> = env::promise_result_checked(n as u64, 64).ok().and_then(|b| serde_json::from_slice(&b).ok());
            let p = &mut s.payouts[i as usize];
            match id {
                Some(id) => {
                    p.proposal_id = Some(id);
                    p.status = PayoutStatus::OnHold;
                }
                None => {
                    p.status = PayoutStatus::Failed;
                    released += p.amount.0;
                }
            }
        }
        if !s.payouts.iter().any(|p| p.status == PayoutStatus::OnHold) {
            s.status = SettlementStatus::Final;
            s.finalized_at_ns = Some(U64(env::block_timestamp()));
        }
        emit("settled", json!({ "league_id": league_id, "key": key, "hold_ends_at_ns": s.hold_ends_at_ns }));
        self.settlements.insert(key.storage_key(league_id), s);
        let l = self.league_mut(league_id);
        l.on_hold_total = U128(l.on_hold_total.0.saturating_sub(released));
    }

    /// Pays the payouts still on hold once the hold window is over. Anyone can call it.
    /// Payouts the league rejected are marked stopped and their money stays in the pot.
    pub fn finalize(&mut self, league_id: u64, key: SettlementKey) {
        let league = self.active_league(league_id).clone();
        let s = self.settlements.get(&key.storage_key(league_id)).cloned().unwrap_or_else(|| env::panic_str("Not settled yet"));
        require!(s.status == SettlementStatus::OnHold, "Nothing on hold to finalize");
        let ends = s.hold_ends_at_ns.unwrap().0;
        require!(
            env::block_timestamp() >= ends,
            format!("The hold window ends at {} (ns since epoch)", ends)
        );
        let ids: Vec<u64> = s
            .payouts
            .iter()
            .filter(|p| p.status == PayoutStatus::OnHold)
            .filter_map(|p| p.proposal_id)
            .collect();
        let vault = league.vault.clone().unwrap();
        let mut batch = Promise::new(league.token.clone()).function_call(
            "ft_balance_of".to_string(),
            serde_json::to_vec(&json!({ "account_id": vault })).unwrap(),
            NO_DEPOSIT,
            GAS_VIEW,
        );
        for id in &ids {
            batch = batch.and(Promise::new(vault.clone()).function_call(
                "get_proposal".to_string(),
                serde_json::to_vec(&json!({ "id": id })).unwrap(),
                NO_DEPOSIT,
                GAS_VIEW,
            ));
        }
        batch
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_FINALIZE_STATUS).on_finalize_status(league_id, key, ids))
            .detach();
    }

    #[private]
    pub fn on_finalize_status(&mut self, league_id: u64, key: SettlementKey, ids: Vec<u64>) {
        let league = self.league(league_id).clone();
        let vault = league.vault.clone().unwrap();
        let mut s = self.settlements.get(&key.storage_key(league_id)).cloned().unwrap();
        let mut pot: u128 = match env::promise_result_checked(0, 128).ok().and_then(|b| serde_json::from_slice::<U128>(&b).ok()) {
            Some(b) => b.0,
            None => env::panic_str("Couldn't read the pot's balance"),
        };
        let now = env::block_timestamp();
        let mut released = 0u128;
        let mut acting: Vec<u64> = vec![];
        let mut chain: Option<Promise> = None;
        for (n, id) in ids.iter().enumerate() {
            // Only lines still on hold: another finalize may have resolved this one already.
            let Some(p) = s.payouts.iter_mut().find(|p| p.proposal_id == Some(*id) && p.status == PayoutStatus::OnHold)
            else {
                continue;
            };
            let proposal: Option<Value> =
                env::promise_result_checked((n + 1) as u64, 8 * 1024).ok().and_then(|b| serde_json::from_slice(&b).ok());
            let Some(proposal) = proposal else {
                // `get_proposal` panics on a missing id: the league removed it.
                p.status = PayoutStatus::Stopped;
                released += p.amount.0;
                continue;
            };
            let status = proposal["status"].as_str().and_then(ProposalStatus::parse);
            let submitted: u64 = proposal["submission_time"].as_str().and_then(|t| t.parse().ok()).unwrap_or(0);
            let expired = submitted + PROPOSAL_PERIOD_NS < now;
            match status {
                Some(ProposalStatus::Approved) => {
                    p.status = PayoutStatus::Paid; // a league majority approved it early
                    released += p.amount.0;
                }
                Some(ProposalStatus::InProgress) | Some(ProposalStatus::Failed) if !expired => {
                    if p.amount.0 > pot {
                        // The league moved money out since settling: don't send a transfer that would fail.
                        p.status = PayoutStatus::Withheld;
                        p.withheld_reason = Some("pot_too_small".into());
                        released += p.amount.0;
                        continue;
                    }
                    pot -= p.amount.0;
                    let receiver = p.account.clone().unwrap();
                    let action = if status == Some(ProposalStatus::Failed) { "Finalize" } else { "VoteApprove" };
                    // Register the winner first (refunded if already registered), so the transfer can't fail.
                    let step = Promise::new(league.token.clone())
                        .function_call(
                            "storage_deposit".to_string(),
                            serde_json::to_vec(&json!({ "account_id": receiver, "registration_only": true })).unwrap(),
                            NearToken::from_yoctonear(self.config.token_storage_deposit.0),
                            GAS_REGISTER,
                        )
                        .then(Promise::new(vault.clone()).function_call(
                            "act_proposal".to_string(),
                            serde_json::to_vec(&json!({
                                "id": id,
                                "action": action,
                                "proposal": transfer_kind(&league.token, &receiver, p.amount.0),
                                "memo": format!("Commish: hold window over for {}", key.label()),
                            }))
                            .unwrap(),
                            NO_DEPOSIT,
                            GAS_ACT_PROPOSAL.saturating_add(tgas(20)),
                        ));
                    chain = Some(match chain { None => step, Some(c) => c.and(step) });
                    acting.push(*id);
                }
                _ => {
                    // Rejected, Removed, Expired or Moved: the league stopped it.
                    p.status = PayoutStatus::Stopped;
                    released += p.amount.0;
                }
            }
        }
        self.settlements.insert(key.storage_key(league_id), s);
        let l = self.league_mut(league_id);
        l.on_hold_total = U128(l.on_hold_total.0.saturating_sub(released));
        match chain {
            Some(c) => {
                c.then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_FINALIZE_DONE).on_finalize_done(league_id, key, acting))
                    .detach();
            }
            None => self.close_if_done(league_id, key),
        }
    }

    #[private]
    pub fn on_finalize_done(&mut self, league_id: u64, key: SettlementKey, acted: Vec<u64>) {
        let mut s = self.settlements.get(&key.storage_key(league_id)).cloned().unwrap();
        let mut released = 0u128;
        for (n, id) in acted.iter().enumerate() {
            let ok = !matches!(env::promise_result_checked(n as u64, 1024), Err(PromiseError::Failed));
            if let Some(p) = s.payouts.iter_mut().find(|p| p.proposal_id == Some(*id) && p.status == PayoutStatus::OnHold) {
                if ok {
                    p.status = PayoutStatus::Paid;
                    released += p.amount.0;
                }
                // If the vote failed (say the league rejected it in the same block), it stays on
                // hold and the next `finalize` reads the vault's verdict.
            }
        }
        self.settlements.insert(key.storage_key(league_id), s);
        let l = self.league_mut(league_id);
        l.on_hold_total = U128(l.on_hold_total.0.saturating_sub(released));
        self.close_if_done(league_id, key);
    }
}

impl Contract {
    fn fail(&mut self, league_id: u64, key: SettlementKey, why: &str) {
        let k = key.storage_key(league_id);
        if let Some(mut s) = self.settlements.get(&k).cloned() {
            // Undo any hold this settlement placed.
            let held: u128 = s.payouts.iter().filter(|p| matches!(p.status, PayoutStatus::OnHold)).map(|p| p.amount.0).sum();
            s.status = SettlementStatus::Failed;
            s.error = Some(why.to_string());
            self.settlements.insert(k, s);
            if held > 0 {
                let l = self.league_mut(league_id);
                l.on_hold_total = U128(l.on_hold_total.0.saturating_sub(held));
            }
        }
        emit("settle_failed", json!({ "league_id": league_id, "key": key, "error": why }));
    }

    fn close_if_done(&mut self, league_id: u64, key: SettlementKey) {
        let k = key.storage_key(league_id);
        let mut s = self.settlements.get(&k).cloned().unwrap();
        if !s.payouts.iter().any(|p| matches!(p.status, PayoutStatus::OnHold | PayoutStatus::Pending)) {
            s.status = SettlementStatus::Final;
            s.finalized_at_ns = Some(U64(env::block_timestamp()));
            emit("finalized", json!({ "league_id": league_id, "key": key }));
        }
        self.settlements.insert(k, s);
    }
}

/// Defense in depth: the result must be for this league, this key, this rules version, and
/// only name rosters this league has. Amounts must be what the rules allow.
fn check_result(out: &JobOutput, league: &League, key: SettlementKey, teams: &[Team], config: &Config) -> Result<(), String> {
    if out.core_version != config.core_version {
        return Err(format!("core version {} isn't the pinned {}", out.core_version, config.core_version));
    }
    if out.league_ref != format!("sleeper:{}", league.sleeper_league_id) || out.season != league.season {
        return Err("it's for a different league or season".into());
    }
    let known = |r: u16| teams.iter().any(|t| t.roster_id == r);
    if out.source.is_none() {
        return Err("it has no source".into());
    }
    match key {
        SettlementKey::Week(w) => {
            if out.kind != Kind::WeeklyHighScore || out.week != Some(w) {
                return Err("it's for a different week".into());
            }
            if out.placements.is_some() {
                return Err("a weekly result has no placements".into());
            }
            if out.scores.iter().any(|s| !known(s.roster_id)) || out.payouts.iter().any(|p| !known(p.roster_id)) {
                return Err("it names a roster this league doesn't have".into());
            }
            let total: u128 = out.payouts.iter().map(|p| p.amount.0).sum();
            if total > league.weekly_amount.0 {
                return Err("it pays more than the weekly amount".into());
            }
            if let Some(first) = out.payouts.first() {
                if out.payouts.iter().any(|p| p.amount != first.amount) {
                    return Err("tied winners must get equal shares".into());
                }
            }
            let mut ids: Vec<u16> = out.payouts.iter().map(|p| p.roster_id).collect();
            ids.sort_unstable();
            ids.dedup();
            if ids.len() != out.payouts.len() {
                return Err("a roster is paid twice".into());
            }
        }
        SettlementKey::Season => {
            if out.kind != Kind::Season || out.week.is_some() || !out.payouts.is_empty() {
                return Err("it isn't a season result".into());
            }
            let placements = out.placements.as_ref().ok_or("it has no placements")?;
            if placements.iter().any(|p| !known(p.roster_id) || p.place == 0 || p.place as usize > league.season_split_bps.len()) {
                return Err("its placements don't fit this league".into());
            }
        }
    }
    Ok(())
}
