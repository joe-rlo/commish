//! Settling a week or a season from fetched Sleeper data (SPEC.md 6.2–6.6).
//!
//! The caller fetches; this module decides *what* to fetch and computes the result:
//!
//! ```text
//! let urls = initial_urls(&input)?;                // fetch these
//! let more = followup_urls(&input, &league_json)?; // then these (maybe none)
//! let result = settle(&input, &fetched)?;          // fetched = [(url, json)] in fetch order
//! ```

use crate::amounts::split_evenly;
use crate::canonical::canonical_sha256;
use crate::finality::check_week_final;
use crate::num::points_x100;
use crate::sleeper::{self, urls};
use crate::types::*;
use serde_json::{Map, Value};

/// Checks the request before any URL is built from it.
pub fn validate_input(input: &JobInput) -> Result<(), SettleError> {
    let id = &input.sleeper_league_id;
    if id.is_empty() || id.len() > 32 || !id.bytes().all(|b| b.is_ascii_digit()) {
        return Err(SettleError::new(ErrorCode::BadInput, "sleeper_league_id must be 1 to 32 digits"));
    }
    if input.season.len() != 4 || !input.season.bytes().all(|b| b.is_ascii_digit()) {
        return Err(SettleError::new(ErrorCode::BadInput, "season must be a 4-digit year"));
    }
    input.rules.validate().map_err(|e| SettleError::new(ErrorCode::BadInput, e))?;
    match (input.kind, input.week) {
        (Kind::WeeklyHighScore, None) => {
            Err(SettleError::new(ErrorCode::BadInput, "weekly_high_score needs a week"))
        }
        (Kind::WeeklyHighScore, Some(w)) if w == 0 || w > input.rules.regular_season_weeks => {
            Err(SettleError::new(
                ErrorCode::WeekOutOfRange,
                format!(
                    "week {w} isn't a regular-season week (1 to {})",
                    input.rules.regular_season_weeks
                ),
            ))
        }
        (Kind::Season, Some(_)) => Err(SettleError::new(ErrorCode::BadInput, "season takes no week")),
        _ => Ok(()),
    }
}

/// URLs to fetch first.
pub fn initial_urls(input: &JobInput) -> Result<Vec<String>, SettleError> {
    validate_input(input)?;
    let id = &input.sleeper_league_id;
    Ok(match input.kind {
        Kind::WeeklyHighScore => vec![
            urls::league(id),
            urls::rosters(id),
            urls::matchups(id, input.week.expect("validated")),
        ],
        Kind::Season => vec![urls::league(id), urls::rosters(id), urls::winners_bracket(id)],
    })
}

/// URLs to fetch once the league is known. A weekly settlement of a league that isn't
/// complete also needs `/state/nfl` to check finality.
pub fn followup_urls(input: &JobInput, league: &Value) -> Result<Vec<String>, SettleError> {
    validate_input(input)?;
    if league.is_null() {
        return Err(SettleError::new(
            ErrorCode::LeagueNotFound,
            format!("Sleeper has no league {}", input.sleeper_league_id),
        ));
    }
    let league = sleeper::parse_league(league)?;
    Ok(match input.kind {
        Kind::WeeklyHighScore if league.status != "complete" => vec![urls::nfl_state()],
        _ => vec![],
    })
}

/// Every URL a settlement reads, in fetch order.
pub fn all_urls(input: &JobInput, league: &Value) -> Result<Vec<String>, SettleError> {
    let mut all = initial_urls(input)?;
    all.extend(followup_urls(input, league)?);
    Ok(all)
}

/// The source hash: SHA-256 of the canonical JSON of `{url: response}` for `urls`.
pub fn source_for(urls: &[String], fetched: &[(String, Value)]) -> Result<Source, SettleError> {
    let mut doc = Map::new();
    for url in urls {
        doc.insert(url.clone(), get(fetched, url)?.clone());
    }
    Ok(Source { urls: urls.to_vec(), sha256: canonical_sha256(&Value::Object(doc)) })
}

fn get<'a>(fetched: &'a [(String, Value)], url: &str) -> Result<&'a Value, SettleError> {
    fetched
        .iter()
        .find(|(u, _)| u == url)
        .map(|(_, v)| v)
        .ok_or_else(|| SettleError::new(ErrorCode::MissingData, format!("missing response for {url}")))
}

/// Computes the settlement. `fetched` holds the responses for `all_urls`.
pub fn settle(input: &JobInput, fetched: &[(String, Value)]) -> Result<Settlement, SettleError> {
    validate_input(input)?;
    let id = &input.sleeper_league_id;
    let league_json = get(fetched, &urls::league(id))?;
    if league_json.is_null() {
        return Err(SettleError::new(ErrorCode::LeagueNotFound, format!("Sleeper has no league {id}")));
    }
    let league = sleeper::parse_league(league_json)?;
    if &league.league_id != id {
        return Err(SettleError::new(ErrorCode::LeagueMismatch, "Sleeper returned a different league"));
    }
    if league.season != input.season {
        return Err(SettleError::new(
            ErrorCode::LeagueMismatch,
            format!("the league is for the {} season, not {}", league.season, input.season),
        ));
    }
    if !league.sport.is_empty() && league.sport != "nfl" {
        return Err(SettleError::new(ErrorCode::LeagueMismatch, "not an NFL league"));
    }

    let rosters = sleeper::parse_rosters(get(fetched, &urls::rosters(id))?)?;
    if rosters.len() < 2 {
        return Err(SettleError::new(ErrorCode::BadData, "the league has fewer than 2 rosters"));
    }
    let mut roster_ids: Vec<u16> = rosters.iter().map(|r| r.roster_id).collect();
    roster_ids.sort_unstable();
    if roster_ids.windows(2).any(|w| w[0] == w[1]) {
        return Err(SettleError::new(ErrorCode::BadData, "duplicate roster_id in rosters"));
    }

    let source = source_for(&all_urls(input, league_json)?, fetched)?;
    let league_ref = format!("sleeper:{id}");

    match input.kind {
        Kind::WeeklyHighScore => {
            let week = input.week.expect("validated");
            let state = if league.status == "complete" {
                None
            } else {
                Some(sleeper::parse_state(get(fetched, &urls::nfl_state())?)?)
            };
            check_week_final(&league.status, &input.season, week, state.as_ref(), input.now_ns.0)
                .map_err(|nf| SettleError::new(ErrorCode::WeekNotFinal, nf.message(week)))?;

            let matchups = sleeper::parse_matchups(get(fetched, &urls::matchups(id, week))?)?;
            let scores = weekly_scores(&roster_ids, &matchups)?;
            let payouts = weekly_payouts(&scores, input.rules.weekly_amount.0)?;
            Ok(Settlement {
                kind: Kind::WeeklyHighScore,
                league_ref,
                season: input.season.clone(),
                week: Some(week),
                scores,
                payouts,
                placements: None,
                source,
                core_version: crate::CORE_VERSION.to_string(),
            })
        }
        Kind::Season => {
            if league.status != "complete" {
                return Err(SettleError::new(
                    ErrorCode::SeasonNotComplete,
                    format!("the league's status is \"{}\"; season payouts wait for \"complete\"", league.status),
                ));
            }
            let bracket = sleeper::parse_bracket(get(fetched, &urls::winners_bracket(id))?)?;
            let placements =
                season_placements(&bracket, input.rules.season_split_bps.len(), &roster_ids)?;
            Ok(Settlement {
                kind: Kind::Season,
                league_ref,
                season: input.season.clone(),
                week: None,
                scores: vec![],
                payouts: vec![],
                placements: Some(placements),
                source,
                core_version: crate::CORE_VERSION.to_string(),
            })
        }
    }
}

/// Every roster's score for the week, highest first, ties by roster id.
pub fn weekly_scores(roster_ids: &[u16], matchups: &[sleeper::Matchup]) -> Result<Vec<Score>, SettleError> {
    for m in matchups {
        if !roster_ids.contains(&m.roster_id) {
            return Err(SettleError::new(
                ErrorCode::BadData,
                format!("matchups name roster {} which isn't in the league", m.roster_id),
            ));
        }
    }
    let mut scores = Vec::with_capacity(roster_ids.len());
    for &roster_id in roster_ids {
        let mut entries = matchups.iter().filter(|m| m.roster_id == roster_id);
        let entry = entries.next();
        if entries.next().is_some() {
            return Err(SettleError::new(
                ErrorCode::BadData,
                format!("roster {roster_id} appears twice in the week's matchups"),
            ));
        }
        scores.push(match entry {
            Some(m) => {
                let p = m.effective_points();
                let x100 = points_x100(p).ok_or_else(|| {
                    SettleError::new(ErrorCode::BadData, format!("roster {roster_id} has unusable points"))
                })?;
                Score { roster_id, points_x100: x100, missing: false }
            }
            None => Score { roster_id, points_x100: 0, missing: true },
        });
    }
    let present: Vec<&Score> = scores.iter().filter(|s| !s.missing).collect();
    if present.is_empty() || present.iter().all(|s| s.points_x100 == 0) {
        return Err(SettleError::new(ErrorCode::NoScores, "no team has points for this week"));
    }
    scores.sort_by(|a, b| b.points_x100.cmp(&a.points_x100).then(a.roster_id.cmp(&b.roster_id)));
    Ok(scores)
}

/// The weekly high score: the roster(s) with the most points. Ties split the amount
/// evenly, rounded down; rounding dust stays in the pot. Missing rosters can't win.
pub fn weekly_payouts(scores: &[Score], weekly_amount: u128) -> Result<Vec<PayoutLine>, SettleError> {
    let top = scores
        .iter()
        .filter(|s| !s.missing)
        .map(|s| s.points_x100)
        .max()
        .ok_or_else(|| SettleError::new(ErrorCode::NoScores, "no team has points for this week"))?;
    let mut winners: Vec<u16> =
        scores.iter().filter(|s| !s.missing && s.points_x100 == top).map(|s| s.roster_id).collect();
    winners.sort_unstable();
    let (each, _dust) = split_evenly(weekly_amount, winners.len());
    if each == 0 {
        return Ok(vec![]);
    }
    Ok(winners.into_iter().map(|roster_id| PayoutLine { roster_id, amount: Amount(each) }).collect())
}

/// Season placements from `winners_bracket`: the `p == 1` game gives 1st (`w`) and 2nd
/// (`l`), the `p == 3` game gives 3rd (`w`). Only the paid places are returned; a paid
/// place with no result is left out (its share goes to 1st, see `amounts::season_amounts`).
pub fn season_placements(
    bracket: &[sleeper::BracketMatch],
    paid_places: usize,
    roster_ids: &[u16],
) -> Result<Vec<Placement>, SettleError> {
    let game = |p: u32| -> Result<Option<&sleeper::BracketMatch>, SettleError> {
        let mut games = bracket.iter().filter(|m| m.p == Some(p));
        let g = games.next();
        if games.next().is_some() {
            return Err(SettleError::new(ErrorCode::BadData, format!("two bracket games with p = {p}")));
        }
        Ok(g)
    };
    let final_game = game(1)?.ok_or_else(|| {
        SettleError::new(ErrorCode::BracketIncomplete, "the bracket has no championship game (p = 1)")
    })?;
    let (champion, runner_up) = match (final_game.w, final_game.l) {
        (Some(w), Some(l)) => (w, l),
        _ => {
            return Err(SettleError::new(
                ErrorCode::BracketIncomplete,
                "the championship game has no result yet",
            ))
        }
    };
    let mut placements = vec![Placement { place: 1, roster_id: champion }];
    if paid_places >= 2 {
        placements.push(Placement { place: 2, roster_id: runner_up });
    }
    if paid_places >= 3 {
        if let Some(third) = game(3)?.and_then(|g| g.w) {
            placements.push(Placement { place: 3, roster_id: third });
        }
    }
    for p in &placements {
        if !roster_ids.contains(&p.roster_id) {
            return Err(SettleError::new(
                ErrorCode::BadData,
                format!("the bracket names roster {} which isn't in the league", p.roster_id),
            ));
        }
    }
    let mut seen: Vec<u16> = placements.iter().map(|p| p.roster_id).collect();
    seen.sort_unstable();
    if seen.windows(2).any(|w| w[0] == w[1]) {
        return Err(SettleError::new(ErrorCode::BadData, "one roster holds two paid places"));
    }
    Ok(placements)
}

/// Runs a settlement and wraps the outcome the way the enclave job prints it.
pub fn run(input: &JobInput, fetched: &[(String, Value)], outlayer_request_id: Option<String>) -> JobOutput {
    JobOutput::from_result(input, settle(input, fetched), outlayer_request_id)
}
