//! The league vault: a Sputnik DAO created through the Sputnik factory (SPEC.md 7.5).
//!
//! Policy:
//!
//! | Role      | Members                       | Can                                                     |
//! |-----------|-------------------------------|---------------------------------------------------------|
//! | `settler` | this contract only            | add + approve `transfer` and `add/remove_member_to_role` proposals, and re-run a failed transfer (`transfer:Finalize`) |
//! | `league`  | commissioner + approved teams | add, approve, reject or remove any proposal             |
//!
//! Sputnik decides a proposal with the first of the voter's roles whose votes reach its
//! threshold. `settler` has one member, so this contract approves alone, but only the
//! proposals this contract creates, after the hold window. During the window a majority of
//! `league` can reject a payout, and then this contract can no longer approve it.
//!
//! `league` votes need a majority **and at least 2 votes** (`quorum: 2`). Without the quorum,
//! a league whose only member is the commissioner would let the commissioner move the pot
//! alone. With it, nobody can move money through `league` until a second member joins, and
//! from then on it takes a majority.
//!
//! `proposal_bond` is 0, so this contract can create proposals without attaching NEAR.

use near_sdk::serde_json::{json, Value};
use near_sdk::AccountId;

pub const SETTLER_ROLE: &str = "settler";
pub const LEAGUE_ROLE: &str = "league";

/// Every proposal kind label Sputnik DAO v2 knows (`ProposalKind::to_policy_label`).
/// The `league` role gets an explicit vote policy for each so the quorum applies to all.
pub const PROPOSAL_KIND_LABELS: [&str; 17] = [
    "config",
    "policy",
    "add_member_to_role",
    "remove_member_from_role",
    "call",
    "upgrade_self",
    "upgrade_remote",
    "transfer",
    "set_vote_token",
    "add_bounty",
    "bounty_done",
    "vote",
    "factory_info_update",
    "policy_add_or_update_role",
    "policy_remove_role",
    "policy_update_default_vote_policy",
    "policy_update_parameters",
];

/// 14 days. Hold windows are at most 72 hours, so proposals never expire before `finalize`.
pub const PROPOSAL_PERIOD_NS: u64 = 14 * 24 * 3600 * 1_000_000_000;

/// Minimum votes for any `league` decision.
pub const LEAGUE_QUORUM: u32 = 2;

pub fn league_vote_policy() -> Value {
    json!({ "weight_kind": "RoleWeight", "quorum": LEAGUE_QUORUM.to_string(), "threshold": [1, 2] })
}

/// The policy each vault is created with.
pub fn vault_policy(settler: &AccountId, commissioner: &AccountId) -> Value {
    let league_votes: near_sdk::serde_json::Map<String, Value> =
        PROPOSAL_KIND_LABELS.iter().map(|l| (l.to_string(), league_vote_policy())).collect();
    json!({
        "roles": [
            {
                "name": SETTLER_ROLE,
                "kind": { "Group": [settler] },
                "permissions": [
                    "transfer:AddProposal",
                    "transfer:VoteApprove",
                    "transfer:Finalize",
                    "add_member_to_role:AddProposal",
                    "add_member_to_role:VoteApprove",
                    "remove_member_from_role:AddProposal",
                    "remove_member_from_role:VoteApprove"
                ],
                "vote_policy": {}
            },
            {
                "name": LEAGUE_ROLE,
                "kind": { "Group": [commissioner] },
                "permissions": ["*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove"],
                "vote_policy": Value::Object(league_votes)
            }
        ],
        // Used by `settler` (one member: one vote approves).
        "default_vote_policy": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 2] },
        "proposal_bond": "0",
        "proposal_period": PROPOSAL_PERIOD_NS.to_string(),
        "bounty_bond": "1000000000000000000000000",
        "bounty_forgiveness_period": "86400000000000"
    })
}

/// Arguments for the DAO's `new(config, policy)`.
pub fn vault_init_args(vault_name: &str, league_name: &str, sleeper_league_id: &str, settler: &AccountId, commissioner: &AccountId) -> Value {
    let purpose = format!(
        "Commish league vault for \"{}\" (Sleeper league {}). Payouts follow the league's rules; a majority of the league can stop any payout during its hold window.",
        league_name.chars().take(80).collect::<String>(),
        sleeper_league_id
    );
    json!({
        "config": { "name": vault_name, "purpose": purpose, "metadata": "" },
        "policy": vault_policy(settler, commissioner),
    })
}

/// Sputnik v2's proposal statuses, as `get_proposal` returns them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProposalStatus {
    InProgress,
    Approved,
    Rejected,
    Removed,
    Expired,
    Moved,
    Failed,
}

impl ProposalStatus {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "InProgress" => Self::InProgress,
            "Approved" => Self::Approved,
            "Rejected" => Self::Rejected,
            "Removed" => Self::Removed,
            "Expired" => Self::Expired,
            "Moved" => Self::Moved,
            "Failed" => Self::Failed,
            _ => return None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_shape() {
        let settler: AccountId = "commish.testnet".parse().unwrap();
        let commish: AccountId = "commissioner.testnet".parse().unwrap();
        let p = vault_policy(&settler, &commish);
        assert_eq!(p["proposal_bond"], "0");
        assert_eq!(p["roles"][0]["name"], "settler");
        assert_eq!(p["roles"][0]["kind"]["Group"][0], "commish.testnet");
        assert_eq!(p["roles"][1]["kind"]["Group"][0], "commissioner.testnet");
        let perms = p["roles"][0]["permissions"].as_array().unwrap();
        assert!(perms.iter().all(|x| {
            let s = x.as_str().unwrap();
            s.starts_with("transfer:") || s.contains("member")
        }));
        assert!(!perms.iter().any(|x| x == "*:*" || x.as_str().unwrap().starts_with("*")));
        let lv = p["roles"][1]["vote_policy"].as_object().unwrap();
        assert_eq!(lv.len(), 17);
        assert!(lv.values().all(|v| v["quorum"] == "2" && v["threshold"] == json!([1, 2])));
        assert_eq!(p["default_vote_policy"]["quorum"], "0");
    }
}
