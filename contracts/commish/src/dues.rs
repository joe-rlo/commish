//! Dues: members pay with `ft_transfer_call` to this contract, `msg = {"league_id":7,"roster_id":3}`.
//!
//! The payment credits the team, not the payer, so paying before claim approval still counts.
//! Up to the dues amount is accepted, forwarded to the vault in the same call chain, and
//! the rest is returned. If the forward fails, the whole payment is returned. Either way
//! this contract holds none of it once `ft_on_transfer` resolves. The first payment locks
//! the rules.

use crate::*;
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::json;
use near_sdk::{Promise, PromiseError, PromiseOrValue};

const GAS_FT_TRANSFER: Gas = tgas(10);
const GAS_ON_DUES_FORWARDED: Gas = tgas(10);

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct DuesMsg {
    league_id: u64,
    roster_id: u16,
}

#[near]
impl FungibleTokenReceiver for Contract {
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let m: DuesMsg = near_sdk::serde_json::from_str(&msg)
            .unwrap_or_else(|_| env::panic_str(r#"msg must be {"league_id":<id>,"roster_id":<id>}"#));
        let league = self.active_league(m.league_id).clone();
        require!(env::predecessor_account_id() == league.token, "This league takes dues in a different token");
        let vault = league.vault.clone().unwrap();
        let mut teams = self.teams_of(m.league_id);
        let team = teams
            .iter_mut()
            .find(|t| t.roster_id == m.roster_id)
            .unwrap_or_else(|| env::panic_str("No such team in this league"));
        let owed = league.dues.0.saturating_sub(team.dues_paid.0);
        let accepted = owed.min(amount.0);
        if accepted == 0 {
            return PromiseOrValue::Value(amount); // already paid: return it all
        }
        team.dues_paid = U128(team.dues_paid.0 + accepted);
        self.save_teams(m.league_id, teams);
        let was_locked = league.rules_locked;
        let l = self.league_mut(m.league_id);
        l.dues_total = U128(l.dues_total.0 + accepted);
        l.rules_locked = true;
        emit(
            "dues_paid",
            json!({ "league_id": m.league_id, "roster_id": m.roster_id, "payer": sender_id, "amount": accepted.to_string() }),
        );
        PromiseOrValue::Promise(
            Promise::new(league.token.clone())
                .function_call(
                    "ft_transfer".to_string(),
                    near_sdk::serde_json::to_vec(&json!({
                        "receiver_id": vault,
                        "amount": accepted.to_string(),
                        "memo": format!("Commish dues: league {} roster {}", m.league_id, m.roster_id),
                    }))
                    .unwrap(),
                    ONE_YOCTO,
                    GAS_FT_TRANSFER,
                )
                .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_DUES_FORWARDED).on_dues_forwarded(
                    m.league_id,
                    m.roster_id,
                    U128(accepted),
                    amount,
                    was_locked,
                )),
        )
    }
}

#[near]
impl Contract {
    /// Returns the unused amount to the token: the excess if the forward worked, everything if not.
    #[private]
    pub fn on_dues_forwarded(
        &mut self,
        league_id: u64,
        roster_id: u16,
        accepted: U128,
        amount: U128,
        was_locked: bool,
    ) -> U128 {
        // `ft_transfer` returns nothing, so check the promise outcome directly.
        let forwarded = env::promise_results_count() == 1
            && !matches!(env::promise_result_checked(0, 1024), Err(PromiseError::Failed));
        if forwarded {
            return U128(amount.0 - accepted.0);
        }
        // Undo the credit; the token refunds the whole payment to the payer.
        let mut teams = self.teams_of(league_id);
        if let Some(t) = teams.iter_mut().find(|t| t.roster_id == roster_id) {
            t.dues_paid = U128(t.dues_paid.0.saturating_sub(accepted.0));
        }
        self.save_teams(league_id, teams);
        let l = self.league_mut(league_id);
        l.dues_total = U128(l.dues_total.0.saturating_sub(accepted.0));
        if !was_locked {
            l.rules_locked = false;
        }
        emit("dues_refunded", json!({ "league_id": league_id, "roster_id": roster_id, "amount": accepted.0.to_string() }));
        amount
    }
}
