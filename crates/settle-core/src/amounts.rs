//! Amount math that needs on-chain state, so the contract calls it (SPEC.md 6.4–6.5a).
//!
//! - weekly ties split evenly, rounded down; dust stays in the pot
//! - season amounts from the payout base and split; a place with no result goes to 1st
//! - withholding: no approved account, dues unpaid, or not enough in the pot

use crate::types::{Amount, PayoutLine, Placement};
use serde::{Deserialize, Serialize};

/// Splits `total` across `n` winners, rounded down. Returns (each, dust).
pub fn split_evenly(total: u128, n: usize) -> (u128, u128) {
    if n == 0 {
        return (0, total);
    }
    let n = n as u128;
    let each = total / n;
    (each, total - each * n)
}

/// One paid place of a season settlement.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct PlaceAmount {
    pub place: u8,
    pub roster_id: u16,
    pub amount: Amount,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeasonAmountError {
    /// Placements have no 1st place.
    NoFirstPlace,
    /// A placement names a place outside the split, or a place twice.
    BadPlacements,
    /// The split is invalid (empty, more than 3 places, or doesn't sum to 10000).
    BadSplit,
}

/// Season amounts: each place gets `base × bps / 10000`, rounded down. A place with no
/// result (for example no 3rd-place game) adds its share to 1st place. Rounding dust stays
/// in the pot. Output is ordered by place.
pub fn season_amounts(
    base: u128,
    split_bps: &[u16],
    placements: &[Placement],
) -> Result<Vec<PlaceAmount>, SeasonAmountError> {
    let places = split_bps.len();
    let sum: u32 = split_bps.iter().map(|&b| b as u32).sum();
    if places == 0 || places > 3 || sum != 10_000 {
        return Err(SeasonAmountError::BadSplit);
    }
    let mut by_place: Vec<Option<u16>> = vec![None; places];
    for p in placements {
        let idx = (p.place as usize).checked_sub(1).ok_or(SeasonAmountError::BadPlacements)?;
        if idx >= places || by_place[idx].is_some() {
            return Err(SeasonAmountError::BadPlacements);
        }
        by_place[idx] = Some(p.roster_id);
    }
    let first = by_place[0].ok_or(SeasonAmountError::NoFirstPlace)?;
    let shares: Vec<u128> = split_bps.iter().map(|&b| base * b as u128 / 10_000).collect();
    let mut out = vec![PlaceAmount { place: 1, roster_id: first, amount: Amount(shares[0]) }];
    for i in 1..places {
        match by_place[i] {
            Some(roster_id) => out.push(PlaceAmount {
                place: (i + 1) as u8,
                roster_id,
                amount: Amount(shares[i]),
            }),
            None => out[0].amount = Amount(out[0].amount.0 + shares[i]),
        }
    }
    Ok(out)
}

/// What the contract knows about a team when it settles.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct TeamState {
    pub roster_id: u16,
    /// The team has an approved NEAR account to pay.
    pub has_approved_account: bool,
    /// Dues required and dues paid so far, smallest token units.
    pub dues: Amount,
    pub dues_paid: Amount,
}

/// Why a payout stays in the pot.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WithheldReason {
    /// The winning team has no approved account.
    NoAccount,
    /// The winning team hasn't paid its dues and the league withholds winnings.
    DuesUnpaid,
    /// The pot holds less than the payout.
    PotTooSmall,
}

impl WithheldReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            WithheldReason::NoAccount => "no_account",
            WithheldReason::DuesUnpaid => "dues_unpaid",
            WithheldReason::PotTooSmall => "pot_too_small",
        }
    }

    /// Plain words for the UI.
    pub fn label(&self) -> &'static str {
        match self {
            WithheldReason::NoAccount => "no approved account",
            WithheldReason::DuesUnpaid => "dues unpaid",
            WithheldReason::PotTooSmall => "pot too small",
        }
    }
}

/// A payout after withholding.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct PayoutDecision {
    pub roster_id: u16,
    pub amount: Amount,
    pub withheld: Option<WithheldReason>,
}

/// Applies withholding in order. `available` is what the pot can pay right now (vault
/// balance minus payouts still on hold); paid lines draw it down, withheld lines don't.
///
/// Checks, in order: approved account, then dues (when `withhold_unpaid`), then pot size.
pub fn apply_withholding(
    payouts: &[PayoutLine],
    teams: &[TeamState],
    withhold_unpaid: bool,
    available: u128,
) -> Vec<PayoutDecision> {
    let mut left = available;
    payouts
        .iter()
        .map(|p| {
            let team = teams.iter().find(|t| t.roster_id == p.roster_id);
            let reason = match team {
                None => Some(WithheldReason::NoAccount),
                Some(t) if !t.has_approved_account => Some(WithheldReason::NoAccount),
                Some(t) if withhold_unpaid && t.dues_paid.0 < t.dues.0 => {
                    Some(WithheldReason::DuesUnpaid)
                }
                Some(_) if p.amount.0 > left => Some(WithheldReason::PotTooSmall),
                Some(_) => None,
            };
            if reason.is_none() {
                left -= p.amount.0;
            }
            PayoutDecision { roster_id: p.roster_id, amount: p.amount, withheld: reason }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pl(place: u8, roster_id: u16) -> Placement {
        Placement { place, roster_id }
    }

    #[test]
    fn split_evenly_keeps_dust() {
        assert_eq!(split_evenly(5_000_000, 1), (5_000_000, 0));
        assert_eq!(split_evenly(5_000_000, 2), (2_500_000, 0));
        assert_eq!(split_evenly(5_000_000, 3), (1_666_666, 2));
        assert_eq!(split_evenly(1, 3), (0, 1));
        assert_eq!(split_evenly(7, 0), (0, 7));
    }

    #[test]
    fn season_amounts_three_places() {
        let out = season_amounts(530_000_000, &[6000, 2500, 1500], &[pl(1, 8), pl(2, 2), pl(3, 1)])
            .unwrap();
        assert_eq!(
            out,
            vec![
                PlaceAmount { place: 1, roster_id: 8, amount: Amount(318_000_000) },
                PlaceAmount { place: 2, roster_id: 2, amount: Amount(132_500_000) },
                PlaceAmount { place: 3, roster_id: 1, amount: Amount(79_500_000) },
            ]
        );
    }

    #[test]
    fn missing_third_place_goes_to_first() {
        let out = season_amounts(1_000_001, &[6000, 2500, 1500], &[pl(1, 8), pl(2, 2)]).unwrap();
        // shares: 600000 (floor of 600000.6), 250000, 150000; 3rd's share joins 1st.
        assert_eq!(out[0], PlaceAmount { place: 1, roster_id: 8, amount: Amount(750_000) });
        assert_eq!(out[1], PlaceAmount { place: 2, roster_id: 2, amount: Amount(250_000) });
        assert_eq!(out.len(), 2);
        let paid: u128 = out.iter().map(|p| p.amount.0).sum();
        assert_eq!(1_000_001 - paid, 1, "dust stays in the pot");
    }

    #[test]
    fn winner_takes_all() {
        let out = season_amounts(600, &[10_000], &[pl(1, 3)]).unwrap();
        assert_eq!(out, vec![PlaceAmount { place: 1, roster_id: 3, amount: Amount(600) }]);
    }

    #[test]
    fn season_amounts_rejects_bad_input() {
        assert_eq!(season_amounts(1, &[], &[pl(1, 1)]), Err(SeasonAmountError::BadSplit));
        assert_eq!(season_amounts(1, &[5000, 4000], &[pl(1, 1)]), Err(SeasonAmountError::BadSplit));
        assert_eq!(season_amounts(1, &[7000, 3000], &[pl(2, 1)]), Err(SeasonAmountError::NoFirstPlace));
        assert_eq!(
            season_amounts(1, &[7000, 3000], &[pl(1, 1), pl(1, 2)]),
            Err(SeasonAmountError::BadPlacements)
        );
        assert_eq!(
            season_amounts(1, &[7000, 3000], &[pl(1, 1), pl(3, 2)]),
            Err(SeasonAmountError::BadPlacements)
        );
        assert_eq!(season_amounts(1, &[10_000], &[pl(0, 1)]), Err(SeasonAmountError::BadPlacements));
    }

    fn team(roster_id: u16, approved: bool, paid: u128) -> TeamState {
        TeamState {
            roster_id,
            has_approved_account: approved,
            dues: Amount(50_000_000),
            dues_paid: Amount(paid),
        }
    }

    fn line(roster_id: u16, amount: u128) -> PayoutLine {
        PayoutLine { roster_id, amount: Amount(amount) }
    }

    #[test]
    fn withholding_no_account() {
        let d = apply_withholding(&[line(3, 5)], &[team(3, false, 50_000_000)], true, 100);
        assert_eq!(d[0].withheld, Some(WithheldReason::NoAccount));
        let d = apply_withholding(&[line(3, 5)], &[], true, 100);
        assert_eq!(d[0].withheld, Some(WithheldReason::NoAccount));
    }

    #[test]
    fn withholding_dues_unpaid_only_when_flag_on() {
        let teams = [team(3, true, 49_999_999)];
        let d = apply_withholding(&[line(3, 5)], &teams, true, 100);
        assert_eq!(d[0].withheld, Some(WithheldReason::DuesUnpaid));
        let d = apply_withholding(&[line(3, 5)], &teams, false, 100);
        assert_eq!(d[0].withheld, None);
    }

    #[test]
    fn withholding_pot_too_small_draws_down_in_order() {
        let teams = [team(1, true, 50_000_000), team(2, true, 50_000_000), team(3, false, 0)];
        // roster 3 is withheld (no account) and doesn't use the pot; 1 is paid; 2 doesn't fit.
        let d = apply_withholding(&[line(3, 4), line(1, 4), line(2, 4)], &teams, true, 7);
        assert_eq!(d[0].withheld, Some(WithheldReason::NoAccount));
        assert_eq!(d[1].withheld, None);
        assert_eq!(d[2].withheld, Some(WithheldReason::PotTooSmall));
    }

    #[test]
    fn exact_pot_is_enough() {
        let d = apply_withholding(&[line(1, 5)], &[team(1, true, 50_000_000)], true, 5);
        assert_eq!(d[0].withheld, None);
    }
}
