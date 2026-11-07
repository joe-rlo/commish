//! The parts of Sleeper's API responses that the rules read (field names confirmed in
//! spike S3, see docs/SPIKES.md). Parsing is lenient about extra fields and strict about
//! the ones we use.

use crate::finality::NflState;
use crate::types::{ErrorCode, SettleError};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize, Clone, Debug)]
pub struct League {
    pub league_id: String,
    #[serde(default)]
    pub name: String,
    pub season: String,
    pub status: String,
    #[serde(default)]
    pub sport: String,
    #[serde(default)]
    pub total_rosters: Option<u32>,
    #[serde(default)]
    pub settings: LeagueSettings,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct LeagueSettings {
    #[serde(default)]
    pub playoff_week_start: Option<u32>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Roster {
    pub roster_id: u16,
    #[serde(default)]
    pub owner_id: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Matchup {
    pub roster_id: u16,
    #[serde(default)]
    pub points: Option<f64>,
    #[serde(default)]
    pub custom_points: Option<f64>,
    #[serde(default)]
    pub matchup_id: Option<u64>,
}

impl Matchup {
    /// `custom_points` when present and not null (a commissioner override), else `points`.
    pub fn effective_points(&self) -> f64 {
        self.custom_points.or(self.points).unwrap_or(0.0)
    }
}

/// One game of `winners_bracket`. `p` marks placement games: the `p == 1` game decides
/// 1st and 2nd, the `p == 3` game decides 3rd.
#[derive(Deserialize, Clone, Debug)]
pub struct BracketMatch {
    #[serde(default)]
    pub r: Option<u32>,
    #[serde(default)]
    pub m: Option<u32>,
    #[serde(default)]
    pub w: Option<u16>,
    #[serde(default)]
    pub l: Option<u16>,
    #[serde(default)]
    pub p: Option<u32>,
}

fn parse<T: for<'de> Deserialize<'de>>(what: &str, v: &Value) -> Result<T, SettleError> {
    T::deserialize(v).map_err(|e| SettleError::new(ErrorCode::BadData, format!("{what}: {e}")))
}

pub fn parse_league(v: &Value) -> Result<League, SettleError> {
    parse("league", v)
}

pub fn parse_rosters(v: &Value) -> Result<Vec<Roster>, SettleError> {
    parse("rosters", v)
}

pub fn parse_matchups(v: &Value) -> Result<Vec<Matchup>, SettleError> {
    // Sleeper returns `null` or `[]` for weeks with no data.
    if v.is_null() {
        return Ok(vec![]);
    }
    parse("matchups", v)
}

pub fn parse_bracket(v: &Value) -> Result<Vec<BracketMatch>, SettleError> {
    if v.is_null() {
        return Ok(vec![]);
    }
    parse("winners_bracket", v)
}

pub fn parse_state(v: &Value) -> Result<NflState, SettleError> {
    parse("state/nfl", v)
}

/// URL helpers. Every URL the rules read starts with `SLEEPER_API`.
pub mod urls {
    use crate::SLEEPER_API;

    pub fn league(id: &str) -> String {
        format!("{SLEEPER_API}/league/{id}")
    }
    pub fn rosters(id: &str) -> String {
        format!("{SLEEPER_API}/league/{id}/rosters")
    }
    pub fn users(id: &str) -> String {
        format!("{SLEEPER_API}/league/{id}/users")
    }
    pub fn matchups(id: &str, week: u8) -> String {
        format!("{SLEEPER_API}/league/{id}/matchups/{week}")
    }
    pub fn winners_bracket(id: &str) -> String {
        format!("{SLEEPER_API}/league/{id}/winners_bracket")
    }
    pub fn nfl_state() -> String {
        format!("{SLEEPER_API}/state/nfl")
    }
}
