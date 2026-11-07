//! Runs every case in fixtures/cases/ (built by fixtures/build-cases.mjs) through settle-core.
//!
//! The expected source hashes were computed in JavaScript, so a pass here means Rust and
//! JavaScript agree on the canonical bytes of real Sleeper data.

use serde_json::Value;
use settle_core::canonical::{canonical_sha256, canonicalize, to_canonical_string};
use settle_core::settle::{all_urls, followup_urls, initial_urls, run, settle};
use settle_core::{JobInput, JobOutput, Kind};
use std::path::PathBuf;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

struct Case {
    name: String,
    input: JobInput,
    fetched: Vec<(String, Value)>,
    expect: Value,
}

fn cases() -> Vec<Case> {
    let dir = repo().join("fixtures/cases");
    let mut paths: Vec<_> = std::fs::read_dir(&dir)
        .expect("fixtures/cases exists; run `node fixtures/build-cases.mjs`")
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().map_or(false, |x| x == "json"))
        .collect();
    paths.sort();
    assert!(paths.len() >= 20, "expected the full case set, found {}", paths.len());
    paths
        .into_iter()
        .map(|p| {
            let v: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
            let fetched = v["fetched"]
                .as_array()
                .unwrap()
                .iter()
                .map(|pair| (pair[0].as_str().unwrap().to_string(), pair[1].clone()))
                .collect();
            Case {
                name: v["name"].as_str().unwrap().to_string(),
                input: serde_json::from_value(v["input"].clone()).unwrap(),
                fetched,
                expect: v["expect"].clone(),
            }
        })
        .collect()
}

#[test]
fn every_case_matches_its_expectations() {
    for c in cases() {
        let out: JobOutput = run(&c.input, &c.fetched, None);
        let name = &c.name;
        if let Some(code) = c.expect["error"].as_str() {
            let err = out.error.as_ref().unwrap_or_else(|| panic!("{name}: expected {code}, got success"));
            assert_eq!(err.code.as_str(), code, "{name}: {}", err.message);
            assert!(out.source.is_none() && out.payouts.is_empty(), "{name}: an error pays nothing");
            continue;
        }
        assert!(out.error.is_none(), "{name}: unexpected error {:?}", out.error);
        let s = out.settlement().unwrap();
        let source = &s.source;
        assert_eq!(source.sha256, c.expect["source_sha256"].as_str().unwrap(), "{name}: source hash (JS) vs Rust");
        let want_urls: Vec<String> = serde_json::from_value(c.expect["source_urls"].clone()).unwrap();
        assert_eq!(source.urls, want_urls, "{name}: source urls");
        match s.kind {
            Kind::WeeklyHighScore => {
                let payouts = serde_json::to_value(&s.payouts).unwrap();
                assert_eq!(payouts, c.expect["payouts"], "{name}: payouts");
                assert!(s.placements.is_none(), "{name}: weekly has no placements");
                let n = c.expect["score_count"].as_u64().unwrap() as usize;
                assert_eq!(s.scores.len(), n, "{name}: one score per roster");
                let tops = c.expect["top_scores"].as_array().unwrap();
                for (i, t) in tops.iter().enumerate() {
                    assert_eq!(s.scores[i].roster_id as u64, t["roster_id"].as_u64().unwrap(), "{name}: rank {i}");
                    assert_eq!(s.scores[i].points_x100, t["points_x100"].as_i64().unwrap(), "{name}: rank {i}");
                }
                // Sorted highest first, ties by roster id.
                for w in s.scores.windows(2) {
                    assert!(
                        w[0].points_x100 > w[1].points_x100
                            || (w[0].points_x100 == w[1].points_x100 && w[0].roster_id < w[1].roster_id),
                        "{name}: scores sorted"
                    );
                }
                let missing: Vec<u16> = s.scores.iter().filter(|x| x.missing).map(|x| x.roster_id).collect();
                let want_missing: Vec<u16> =
                    serde_json::from_value(c.expect.get("missing").cloned().unwrap_or(Value::Array(vec![]))).unwrap();
                assert_eq!(missing, want_missing, "{name}: missing rosters");
                for m in s.scores.iter().filter(|x| x.missing) {
                    assert_eq!(m.points_x100, 0, "{name}: a missing roster scores 0");
                    assert!(!s.payouts.iter().any(|p| p.roster_id == m.roster_id), "{name}: a missing roster can't win");
                }
                let total: u128 = s.payouts.iter().map(|p| p.amount.0).sum();
                assert!(total <= c.input.rules.weekly_amount.0, "{name}: never more than the weekly amount");
            }
            Kind::Season => {
                let placements = serde_json::to_value(s.placements.as_ref().unwrap()).unwrap();
                assert_eq!(placements, c.expect["placements"], "{name}: placements");
                assert!(s.payouts.is_empty() && s.scores.is_empty(), "{name}: season has placements only");
            }
        }
    }
}

#[test]
fn the_fetch_plan_matches_the_case_urls() {
    for c in cases() {
        if c.expect["error"].is_string() {
            continue;
        }
        let league = &c.fetched[0].1;
        let mut plan = initial_urls(&c.input).unwrap();
        plan.extend(followup_urls(&c.input, league).unwrap());
        assert_eq!(plan, all_urls(&c.input, league).unwrap());
        let want: Vec<String> = serde_json::from_value(c.expect["source_urls"].clone()).unwrap();
        assert_eq!(plan, want, "{}", c.name);
    }
}

#[test]
fn the_hash_of_raw_recorded_bytes_equals_the_js_hash() {
    // The recorded files keep Sleeper's own formatting (`9.0`, `0.0`, key order).
    // JS reformatted them when building the case; the canonical hash must not care.
    let rec = repo().join("fixtures/sleeper/armchair-2025");
    let raw = |p: &str| -> Value { serde_json::from_str(&std::fs::read_to_string(rec.join(p)).unwrap()).unwrap() };
    let raw_text = std::fs::read_to_string(rec.join("matchups/1.json")).unwrap();
    assert!(raw_text.contains(":0.0") || raw_text.contains(":9.0"), "the recording keeps Sleeper's float format");
    let api = "https://api.sleeper.app/v1/league/1197787383500648448";
    let doc = serde_json::json!({
        api: raw("league.json"),
        format!("{api}/rosters"): raw("rosters.json"),
        format!("{api}/matchups/1"): raw("matchups/1.json"),
    });
    let case: Value = serde_json::from_str(
        &std::fs::read_to_string(repo().join("fixtures/cases/weekly-single-winner.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(canonical_sha256(&doc), case["expect"]["source_sha256"].as_str().unwrap());
}

#[test]
fn output_is_canonical_and_deterministic() {
    for c in cases() {
        let a = to_canonical_string(&run(&c.input, &c.fetched, Some("42".into())));
        let b = to_canonical_string(&run(&c.input, &c.fetched, Some("42".into())));
        assert_eq!(a, b, "{}: same input, same bytes", c.name);
        // Canonical JSON round-trips through serde_json's own serializer unchanged, which is
        // what lets the contract's hash equal OutLayer's attested output hash.
        let reparsed: Value = serde_json::from_str(&a).unwrap();
        assert_eq!(serde_json::to_string(&reparsed).unwrap(), a, "{}: serde_json agrees", c.name);
        assert_eq!(canonicalize(&reparsed), a);
        // And it parses back into the wire type.
        let back: JobOutput = serde_json::from_str(&a).unwrap();
        assert_eq!(back.outlayer_request_id.as_deref(), Some("42"));
    }
}

#[test]
fn weekly_output_shape_matches_the_spec() {
    let c = cases().into_iter().find(|c| c.name == "weekly-single-winner").unwrap();
    let out = to_canonical_string(&run(&c.input, &c.fetched, None));
    let v: Value = serde_json::from_str(&out).unwrap();
    let keys: Vec<&str> = v.as_object().unwrap().keys().map(|k| k.as_str()).collect();
    assert_eq!(
        keys,
        vec!["core_version", "kind", "league_ref", "payouts", "placements", "scores", "season", "source", "week"]
    );
    assert_eq!(v["kind"], "weekly_high_score");
    assert_eq!(v["league_ref"], "sleeper:1197787383500648448");
    assert_eq!(v["week"], 1);
    assert_eq!(v["placements"], Value::Null);
    assert_eq!(v["payouts"], serde_json::json!([{"amount": "5000000", "roster_id": 2}]));
    assert_eq!(v["core_version"], settle_core::CORE_VERSION);
    assert!(out.len() < 4096, "fits comfortably in a NEAR callback: {} bytes", out.len());
}

#[test]
fn season_output_shape_matches_the_spec() {
    let c = cases().into_iter().find(|c| c.name == "season-three-places").unwrap();
    let v: Value = serde_json::from_str(&to_canonical_string(&run(&c.input, &c.fetched, None))).unwrap();
    assert_eq!(v["kind"], "season");
    assert_eq!(v["week"], Value::Null);
    assert_eq!(v["payouts"], serde_json::json!([]));
    assert_eq!(v["scores"], serde_json::json!([]));
    assert_eq!(
        v["placements"],
        serde_json::json!([{"place": 1, "roster_id": 8}, {"place": 2, "roster_id": 2}, {"place": 3, "roster_id": 1}])
    );
}

#[test]
fn bad_inputs_are_rejected_before_any_url_is_built() {
    let c = cases().into_iter().find(|c| c.name == "weekly-single-winner").unwrap();
    let mut bad = c.input.clone();
    bad.sleeper_league_id = "123/../../evil".into();
    assert_eq!(initial_urls(&bad).unwrap_err().code.as_str(), "BAD_INPUT");
    let mut bad = c.input.clone();
    bad.season = "25".into();
    assert_eq!(initial_urls(&bad).unwrap_err().code.as_str(), "BAD_INPUT");
    let mut bad = c.input.clone();
    bad.week = None;
    assert_eq!(initial_urls(&bad).unwrap_err().code.as_str(), "BAD_INPUT");
    let mut bad = c.input.clone();
    bad.week = Some(0);
    assert_eq!(initial_urls(&bad).unwrap_err().code.as_str(), "WEEK_OUT_OF_RANGE");
    let mut bad = c.input.clone();
    bad.rules.season_split_bps = vec![6000, 2500];
    assert_eq!(initial_urls(&bad).unwrap_err().code.as_str(), "BAD_INPUT");
}

#[test]
fn data_problems_are_reported_not_paid() {
    let c = cases().into_iter().find(|c| c.name == "weekly-single-winner").unwrap();
    // A different league in the response.
    let mut f = c.fetched.clone();
    f[0].1["league_id"] = Value::String("1".into());
    assert_eq!(settle(&c.input, &f).unwrap_err().code.as_str(), "LEAGUE_MISMATCH");
    // A missing response.
    let f: Vec<_> = c.fetched.iter().take(2).cloned().collect();
    assert_eq!(settle(&c.input, &f).unwrap_err().code.as_str(), "MISSING_DATA");
    // An unknown roster in the matchups.
    let mut f = c.fetched.clone();
    f[2].1[0]["roster_id"] = Value::from(99);
    assert_eq!(settle(&c.input, &f).unwrap_err().code.as_str(), "BAD_DATA");
    // A roster twice.
    let mut f = c.fetched.clone();
    let dup = f[2].1[1].clone();
    f[2].1.as_array_mut().unwrap().push(dup);
    assert_eq!(settle(&c.input, &f).unwrap_err().code.as_str(), "BAD_DATA");
    // Nobody scored: the week hasn't really happened.
    let mut f = c.fetched.clone();
    for m in f[2].1.as_array_mut().unwrap() {
        m["points"] = Value::from(0.0);
    }
    assert_eq!(settle(&c.input, &f).unwrap_err().code.as_str(), "NO_SCORES");
    // Empty week.
    let mut f = c.fetched.clone();
    f[2].1 = Value::Array(vec![]);
    assert_eq!(settle(&c.input, &f).unwrap_err().code.as_str(), "NO_SCORES");
    // Not an NFL league.
    let mut f = c.fetched.clone();
    f[0].1["sport"] = Value::String("nba".into());
    assert_eq!(settle(&c.input, &f).unwrap_err().code.as_str(), "LEAGUE_MISMATCH");
}

#[test]
fn zero_weekly_amount_pays_nothing_but_still_scores() {
    let c = cases().into_iter().find(|c| c.name == "weekly-single-winner").unwrap();
    let mut input = c.input.clone();
    input.rules.weekly_amount = settle_core::Amount(0);
    let s = settle(&input, &c.fetched).unwrap();
    assert!(s.payouts.is_empty());
    assert_eq!(s.scores.len(), 12);
}

#[test]
fn bracket_without_a_result_is_incomplete() {
    let c = cases().into_iter().find(|c| c.name == "season-three-places").unwrap();
    let mut f = c.fetched.clone();
    for g in f[2].1.as_array_mut().unwrap() {
        if g["p"] == 1 {
            g["w"] = Value::Null;
            g["l"] = Value::Null;
        }
    }
    assert_eq!(settle(&c.input, &f).unwrap_err().code.as_str(), "BRACKET_INCOMPLETE");
    let mut f = c.fetched.clone();
    f[2].1 = Value::Array(vec![]);
    assert_eq!(settle(&c.input, &f).unwrap_err().code.as_str(), "BRACKET_INCOMPLETE");
}
