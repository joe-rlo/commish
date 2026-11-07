//! Wire types shared by the job, the contract, the CLI and the browser.
//!
//! JSON shapes follow SPEC.md 6.6. Amounts (u128) travel as decimal strings,
//! points travel as integer hundredths.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;

/// What is being settled.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    WeeklyHighScore,
    Season,
}

impl Kind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Kind::WeeklyHighScore => "weekly_high_score",
            Kind::Season => "season",
        }
    }
}

/// A token amount in the token's smallest unit, serialized as a decimal string.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Default, Hash)]
pub struct Amount(pub u128);

impl Serialize for Amount {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0.to_string())
    }
}

impl<'de> Deserialize<'de> for Amount {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        parse_decimal_u128(&s)
            .map(Amount)
            .ok_or_else(|| serde::de::Error::custom("amount must be a decimal string"))
    }
}

/// A u64 serialized as a decimal string (JSON numbers above 2^53 are not safe).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Default, Hash)]
pub struct U64Str(pub u64);

impl Serialize for U64Str {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0.to_string())
    }
}

impl<'de> Deserialize<'de> for U64Str {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        parse_decimal_u128(&s)
            .and_then(|v| u64::try_from(v).ok())
            .map(U64Str)
            .ok_or_else(|| serde::de::Error::custom("expected a decimal u64 string"))
    }
}

/// Strict decimal parser: digits only, no sign, no leading zeros (except "0").
pub fn parse_decimal_u128(s: &str) -> Option<u128> {
    if s.is_empty() || s.len() > 39 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if s.len() > 1 && s.starts_with('0') {
        return None;
    }
    s.parse::<u128>().ok()
}

/// League rules as stored in the contract (SPEC.md 6.1).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Rules {
    /// Weekly high-score payout, smallest token units. 0 turns weekly payouts off.
    pub weekly_amount: Amount,
    /// Weeks 1..=regular_season_weeks pay a weekly high score.
    pub regular_season_weeks: u8,
    /// Season split in basis points, 1st place first. 1 to 3 places, sums to 10000.
    pub season_split_bps: Vec<u16>,
}

impl Rules {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.regular_season_weeks == 0 || self.regular_season_weeks > 18 {
            return Err("regular_season_weeks must be 1..=18");
        }
        let n = self.season_split_bps.len();
        if n == 0 || n > 3 {
            return Err("season split must have 1 to 3 places");
        }
        if self.season_split_bps.iter().any(|&b| b == 0) {
            return Err("each paid place needs a share above 0");
        }
        let sum: u32 = self.season_split_bps.iter().map(|&b| b as u32).sum();
        if sum != 10_000 {
            return Err("season split must sum to 100%");
        }
        Ok(())
    }
}

/// What the contract sends to the enclave job (SPEC.md 7.3).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct JobInput {
    pub sleeper_league_id: String,
    pub season: String,
    pub kind: Kind,
    /// Required for `weekly_high_score`, absent for `season`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub week: Option<u8>,
    pub rules: Rules,
    /// Block timestamp of the `settle` call, nanoseconds. The job never reads a clock.
    pub now_ns: U64Str,
}

/// One team's score for the week.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Score {
    pub roster_id: u16,
    /// Points × 100, rounded half away from zero on the decimal value.
    pub points_x100: i64,
    /// The roster had no entry in the week's matchups: scores 0 and can't win.
    #[serde(default, skip_serializing_if = "is_false")]
    pub missing: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// A computed payout before withholding (the contract applies withholding).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct PayoutLine {
    pub roster_id: u16,
    pub amount: Amount,
}

/// Which roster finished in a paid place.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Placement {
    pub place: u8,
    pub roster_id: u16,
}

/// Where the data came from, and its hash.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Source {
    /// Sleeper API URLs, in fetch order.
    pub urls: Vec<String>,
    /// SHA-256 (hex) of the RFC 8785 canonical JSON of `{url: response, ...}`.
    pub sha256: String,
}

/// The settlement result (SPEC.md 6.6).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Settlement {
    pub kind: Kind,
    pub league_ref: String,
    pub season: String,
    /// The week for `weekly_high_score`; null for `season`.
    pub week: Option<u8>,
    /// Every roster's points, highest first (ties by roster id). Empty for `season`.
    pub scores: Vec<Score>,
    /// Weekly payouts, by roster id. Empty for `season`.
    pub payouts: Vec<PayoutLine>,
    /// Season placements, by place. Null for `weekly_high_score`.
    pub placements: Option<Vec<Placement>>,
    pub source: Source,
    pub core_version: String,
}

/// Why a settlement can't be computed. Nothing is paid.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    /// The week's scores aren't final yet (SPEC.md 6.2).
    WeekNotFinal,
    /// The week isn't a regular-season week.
    WeekOutOfRange,
    /// Season payouts need the league's status to be `complete`.
    SeasonNotComplete,
    /// The bracket has no 1st-place result.
    BracketIncomplete,
    /// No team has a score for this week.
    NoScores,
    /// The Sleeper league doesn't match the request (id, season or sport).
    LeagueMismatch,
    /// The request itself is malformed.
    BadInput,
    /// Sleeper returned data in a shape we can't use.
    BadData,
    /// A required Sleeper response is missing.
    MissingData,
    /// Sleeper has no league with this id.
    LeagueNotFound,
    /// Sleeper couldn't be reached, or answered with an HTTP error.
    SleeperUnreachable,
}

impl ErrorCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            ErrorCode::WeekNotFinal => "WEEK_NOT_FINAL",
            ErrorCode::WeekOutOfRange => "WEEK_OUT_OF_RANGE",
            ErrorCode::SeasonNotComplete => "SEASON_NOT_COMPLETE",
            ErrorCode::BracketIncomplete => "BRACKET_INCOMPLETE",
            ErrorCode::NoScores => "NO_SCORES",
            ErrorCode::LeagueMismatch => "LEAGUE_MISMATCH",
            ErrorCode::BadInput => "BAD_INPUT",
            ErrorCode::BadData => "BAD_DATA",
            ErrorCode::MissingData => "MISSING_DATA",
            ErrorCode::LeagueNotFound => "LEAGUE_NOT_FOUND",
            ErrorCode::SleeperUnreachable => "SLEEPER_UNREACHABLE",
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct SettleError {
    pub code: ErrorCode,
    pub message: String,
}

impl SettleError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        SettleError { code, message: message.into() }
    }
}

impl fmt::Display for SettleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for SettleError {}

/// What the enclave job prints to stdout, and what the contract parses.
///
/// On success it is the `Settlement` fields plus `outlayer_request_id`. On failure it
/// carries `error` and no result fields. The job prints it as canonical JSON, so the
/// SHA-256 the contract stores equals the output hash in OutLayer's attestation.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct JobOutput {
    pub core_version: String,
    pub kind: Kind,
    pub league_ref: String,
    pub season: String,
    pub week: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<SettleError>,
    #[serde(default)]
    pub scores: Vec<Score>,
    #[serde(default)]
    pub payouts: Vec<PayoutLine>,
    #[serde(default)]
    pub placements: Option<Vec<Placement>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Source>,
    /// OutLayer's request id (from `NEAR_REQUEST_ID`), so a receipt can link to its attestation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outlayer_request_id: Option<String>,
}

impl JobOutput {
    pub fn from_result(
        input: &JobInput,
        result: Result<Settlement, SettleError>,
        outlayer_request_id: Option<String>,
    ) -> JobOutput {
        let league_ref = format!("sleeper:{}", input.sleeper_league_id);
        match result {
            Ok(s) => JobOutput {
                core_version: s.core_version,
                kind: s.kind,
                league_ref: s.league_ref,
                season: s.season,
                week: s.week,
                error: None,
                scores: s.scores,
                payouts: s.payouts,
                placements: s.placements,
                source: Some(s.source),
                outlayer_request_id,
            },
            Err(e) => JobOutput {
                core_version: crate::CORE_VERSION.to_string(),
                kind: input.kind,
                league_ref,
                season: input.season.clone(),
                week: input.week,
                error: Some(e),
                scores: vec![],
                payouts: vec![],
                placements: None,
                source: None,
                outlayer_request_id,
            },
        }
    }

    /// The settlement, if the job succeeded.
    pub fn settlement(&self) -> Option<Settlement> {
        if self.error.is_some() {
            return None;
        }
        Some(Settlement {
            kind: self.kind,
            league_ref: self.league_ref.clone(),
            season: self.season.clone(),
            week: self.week,
            scores: self.scores.clone(),
            payouts: self.payouts.clone(),
            placements: match self.kind {
                Kind::Season => Some(self.placements.clone().unwrap_or_default()),
                Kind::WeeklyHighScore => None,
            },
            source: self.source.clone()?,
            core_version: self.core_version.clone(),
        })
    }
}
