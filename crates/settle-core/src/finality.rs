//! When is a week final? (SPEC.md 6.2, field names confirmed in spike S3)
//!
//! Week `W` of season `S` is final when either:
//! - the league's `status` is `complete`, or
//! - `/state/nfl` reports `season == S`, the current NFL week is past `W`, and at least
//!   36 hours have passed since 00:00 UTC on the Tuesday after week `W`.
//!
//! "Current NFL week" is `leg` (Sleeper: "week of regular season"), falling back to
//! `week`. During the NFL postseason (`season_type == "post"`) every regular week of
//! that season has been played.
//!
//! The Tuesday after week 1 is the first Tuesday strictly after `season_start_date`
//! (week 1 runs Thursday to Monday). Week `W`'s Tuesday is 7·(W−1) days later.

use serde::{Deserialize, Serialize};

/// The fields of Sleeper's `/state/nfl` that finality uses.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
pub struct NflState {
    pub season: String,
    #[serde(default)]
    pub season_type: String,
    #[serde(default)]
    pub week: Option<u32>,
    #[serde(default)]
    pub leg: Option<u32>,
    #[serde(default)]
    pub season_start_date: Option<String>,
}

const NS_PER_SEC: u64 = 1_000_000_000;
const SECS_PER_DAY: i64 = 86_400;
/// Stat-correction buffer after the Tuesday following a week.
pub const CORRECTION_BUFFER_SECS: i64 = 36 * 3_600;

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm).
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = m as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Parses `YYYY-MM-DD` into days since the epoch. Validates month and day ranges.
pub fn parse_date(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let y: i64 = s[0..4].parse().ok()?;
    let m: u32 = s[5..7].parse().ok()?;
    let d: u32 = s[8..10].parse().ok()?;
    if !(1..=12).contains(&m) || d == 0 {
        return None;
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let dim = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if d > dim[(m - 1) as usize] {
        return None;
    }
    Some(days_from_civil(y, m, d))
}

/// Weekday with Monday = 0 … Sunday = 6. 1970-01-01 was a Thursday (3).
pub fn weekday(days: i64) -> i64 {
    (days + 3).rem_euclid(7)
}

/// Days-since-epoch of the Tuesday after week `week` (1-based).
pub fn tuesday_after_week(season_start_days: i64, week: u8) -> i64 {
    const TUESDAY: i64 = 1;
    let mut first = season_start_days + 1;
    while weekday(first) != TUESDAY {
        first += 1;
    }
    first + 7 * (week as i64 - 1)
}

/// The earliest time (ns since epoch) week `week` can be final by the clock rule.
pub fn final_at_ns(season_start_date: &str, week: u8) -> Option<u64> {
    let start = parse_date(season_start_date)?;
    let secs = tuesday_after_week(start, week) * SECS_PER_DAY + CORRECTION_BUFFER_SECS;
    u64::try_from(secs).ok()?.checked_mul(NS_PER_SEC)
}

/// Why a week isn't final yet, in plain words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotFinal {
    /// The league isn't complete and no NFL state was provided.
    NoState,
    /// The NFL state is for a different season.
    OtherSeason { state_season: String },
    /// The NFL hasn't moved past this week.
    WeekNotOver { current_week: u32 },
    /// Inside the stat-correction buffer.
    TooSoon { final_at_ns: u64 },
    /// The NFL state has no usable week or start date.
    StateIncomplete,
}

impl NotFinal {
    pub fn message(&self, week: u8) -> String {
        match self {
            NotFinal::NoState => format!("week {week} needs the NFL state to check finality"),
            NotFinal::OtherSeason { state_season } => {
                format!("the NFL is in the {state_season} season, so week {week} can't be checked by the clock rule")
            }
            NotFinal::WeekNotOver { current_week } => {
                format!("the NFL is in week {current_week}; week {week} isn't over")
            }
            NotFinal::TooSoon { final_at_ns } => format!(
                "week {week} settles 36 hours after the Tuesday that follows it (at {} seconds since epoch)",
                final_at_ns / NS_PER_SEC
            ),
            NotFinal::StateIncomplete => "the NFL state has no week or season start date".to_string(),
        }
    }
}

/// Is week `week` of `season` final?
pub fn check_week_final(
    league_status: &str,
    season: &str,
    week: u8,
    state: Option<&NflState>,
    now_ns: u64,
) -> Result<(), NotFinal> {
    if league_status == "complete" {
        return Ok(());
    }
    let state = state.ok_or(NotFinal::NoState)?;
    if state.season != season {
        return Err(NotFinal::OtherSeason { state_season: state.season.clone() });
    }
    if state.season_type != "post" {
        let current = state.leg.or(state.week).ok_or(NotFinal::StateIncomplete)?;
        if current <= week as u32 {
            return Err(NotFinal::WeekNotOver { current_week: current });
        }
    }
    let start = state.season_start_date.as_deref().ok_or(NotFinal::StateIncomplete)?;
    let final_at = final_at_ns(start, week).ok_or(NotFinal::StateIncomplete)?;
    if now_ns < final_at {
        return Err(NotFinal::TooSoon { final_at_ns: final_at });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ns(date: &str, hour: i64) -> u64 {
        ((parse_date(date).unwrap() * SECS_PER_DAY + hour * 3600) as u64) * NS_PER_SEC
    }

    fn state(week: u32, start: &str) -> NflState {
        NflState {
            season: "2026".into(),
            season_type: "regular".into(),
            week: Some(week),
            leg: Some(week),
            season_start_date: Some(start.into()),
        }
    }

    #[test]
    fn dates() {
        assert_eq!(parse_date("1970-01-01"), Some(0));
        assert_eq!(weekday(0), 3, "1970-01-01 was a Thursday");
        assert_eq!(weekday(parse_date("2026-09-09").unwrap()), 2, "2026-09-09 is a Wednesday");
        assert_eq!(weekday(parse_date("2025-09-04").unwrap()), 3, "2025-09-04 is a Thursday");
        assert_eq!(parse_date("2024-02-29").is_some(), true);
        assert_eq!(parse_date("2025-02-29"), None);
        assert_eq!(parse_date("2025-13-01"), None);
        assert_eq!(parse_date("2025-9-01"), None);
    }

    #[test]
    fn tuesday_after_week_one_and_nine() {
        let start = parse_date("2026-09-09").unwrap(); // Wednesday
        assert_eq!(tuesday_after_week(start, 1), parse_date("2026-09-15").unwrap());
        assert_eq!(tuesday_after_week(start, 9), parse_date("2026-11-10").unwrap());
        let start = parse_date("2025-09-04").unwrap(); // Thursday
        assert_eq!(tuesday_after_week(start, 1), parse_date("2025-09-09").unwrap());
        // A Tuesday start date counts from the following Tuesday.
        let start = parse_date("2026-09-08").unwrap();
        assert_eq!(tuesday_after_week(start, 1), parse_date("2026-09-15").unwrap());
    }

    #[test]
    fn complete_league_is_always_final() {
        assert_eq!(check_week_final("complete", "2025", 3, None, 0), Ok(()));
    }

    #[test]
    fn in_season_rules() {
        let s = state(9, "2026-09-09");
        // Week 9 while the NFL is in week 9: not over.
        assert_eq!(
            check_week_final("in_season", "2026", 9, Some(&s), ns("2026-11-20", 0)),
            Err(NotFinal::WeekNotOver { current_week: 9 })
        );
        // Week 8 is over. Its Tuesday is 2026-11-03; final from 2026-11-04 12:00 UTC.
        assert!(matches!(
            check_week_final("in_season", "2026", 8, Some(&s), ns("2026-11-04", 11)),
            Err(NotFinal::TooSoon { .. })
        ));
        assert_eq!(check_week_final("in_season", "2026", 8, Some(&s), ns("2026-11-04", 12)), Ok(()));
        // Other season, or no state at all.
        assert!(matches!(
            check_week_final("in_season", "2025", 8, Some(&s), ns("2026-11-20", 0)),
            Err(NotFinal::OtherSeason { .. })
        ));
        assert_eq!(check_week_final("in_season", "2026", 8, None, 0), Err(NotFinal::NoState));
    }

    #[test]
    fn leg_wins_over_week_and_postseason_counts_as_past() {
        let mut s = state(9, "2026-09-09");
        s.week = Some(1);
        s.leg = Some(10);
        assert_eq!(check_week_final("in_season", "2026", 9, Some(&s), ns("2026-12-31", 0)), Ok(()));
        let mut s = state(1, "2026-09-09");
        s.leg = None;
        s.season_type = "post".into();
        assert_eq!(check_week_final("in_season", "2026", 17, Some(&s), ns("2027-01-20", 0)), Ok(()));
        let mut s = state(10, "bad");
        s.season_start_date = None;
        assert_eq!(
            check_week_final("in_season", "2026", 9, Some(&s), ns("2026-12-31", 0)),
            Err(NotFinal::StateIncomplete)
        );
    }
}
