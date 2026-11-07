//! `pnpm commish verify`: recompute a settlement from public data. Needs no keys.
//!
//! ```text
//! commish-verify --sleeper <id> --week <n> | --season [--weekly 5] [--split 60,25,15]
//! commish-verify --settlement <league_id>:<week n | season> [--contract commish.commishhq.testnet]
//! ```
//!
//! Without `--settlement`: fetches Sleeper, runs settle-core natively, prints the scoreboard,
//! winners, amounts and the data hash.
//!
//! With `--settlement`: reads the settlement from the contract, rebuilds the exact input the
//! contract sent to the enclave (checks its SHA-256), reruns the job here with live Sleeper
//! data, and checks the output's SHA-256 against what the contract stored. Then it checks
//! OutLayer's attestation: same code hash, input hash and output hash.

use serde_json::{json, Value};
use settle_core::num::format_points_x100;
use settle_core::{JobInput, JobOutput, Kind};
use std::process::ExitCode;

const DEFAULT_CONTRACT: &str = "commish-v2.commishhq.testnet";
const DEFAULT_RPC: &str = "https://rpc.testnet.near.org";
const OUTLAYER_API: &str = "https://testnet-api.outlayer.ai";

struct Args {
    sleeper: Option<String>,
    week: Option<u8>,
    season: bool,
    weekly: String,
    split: String,
    settlement: Option<String>,
    contract: String,
    rpc: String,
    json: bool,
}

fn usage() -> ! {
    eprintln!(
        "usage:\n  commish verify --sleeper <id> --week <n> | --season [--weekly 5] [--split 60,25,15]\n  commish verify --settlement <league_id>:<week|season> [--contract {DEFAULT_CONTRACT}] [--rpc {DEFAULT_RPC}]\n  add --json for machine-readable output"
    );
    std::process::exit(2)
}

fn parse_args() -> Args {
    let mut a = Args {
        sleeper: None,
        week: None,
        season: false,
        weekly: "5".into(),
        split: "60,25,15".into(),
        settlement: None,
        contract: std::env::var("COMMISH_CONTRACT_ID").unwrap_or_else(|_| DEFAULT_CONTRACT.into()),
        rpc: std::env::var("NEAR_RPC_URL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| DEFAULT_RPC.into()),
        json: false,
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        let mut val = || it.next().unwrap_or_else(|| usage());
        match arg.as_str() {
            "--sleeper" => a.sleeper = Some(val()),
            "--week" => a.week = Some(val().parse().unwrap_or_else(|_| usage())),
            "--season" => a.season = true,
            "--weekly" => a.weekly = val(),
            "--split" => a.split = val(),
            "--settlement" => a.settlement = Some(val()),
            "--contract" => a.contract = val(),
            "--rpc" => a.rpc = val(),
            "--json" => a.json = true,
            "-h" | "--help" => usage(),
            _ => usage(),
        }
    }
    a
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder().timeout_global(Some(std::time::Duration::from_secs(30))).build().new_agent()
}

fn get_json(url: &str) -> Result<Value, String> {
    let mut r = agent().get(url).call().map_err(|e| format!("{url}: {e}"))?;
    r.body_mut().read_json().map_err(|e| format!("{url}: {e}"))
}

fn view(rpc: &str, contract: &str, method: &str, args: Value) -> Result<Value, String> {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD;
    let body = json!({
        "jsonrpc": "2.0", "id": 1, "method": "query",
        "params": { "request_type": "call_function", "finality": "final", "account_id": contract,
                    "method_name": method, "args_base64": b64.encode(args.to_string()) }
    });
    let mut r = agent().post(rpc).send_json(&body).map_err(|e| format!("rpc: {e}"))?;
    let v: Value = r.body_mut().read_json().map_err(|e| format!("rpc: {e}"))?;
    let bytes: Vec<u8> = v["result"]["result"]
        .as_array()
        .ok_or_else(|| format!("rpc error: {}", v["error"].to_string().chars().take(300).collect::<String>()))?
        .iter()
        .map(|b| b.as_u64().unwrap_or(0) as u8)
        .collect();
    serde_json::from_slice(&bytes).map_err(|e| format!("rpc result: {e}"))
}

fn dollars(units: u128) -> String {
    let cents = (units + 5_000) / 10_000;
    format!("${}.{:02}", cents / 100, cents % 100)
}

fn parse_dollars(s: &str) -> u128 {
    let s = s.trim_start_matches('$');
    let (w, f) = s.split_once('.').unwrap_or((s, ""));
    let f = format!("{:0<6}", f);
    w.parse::<u128>().unwrap_or_else(|_| usage()) * 1_000_000 + f[..6].parse::<u128>().unwrap_or_else(|_| usage())
}

/// Team names for display: roster id → `metadata.team_name`, falling back to `display_name`.
fn team_names(league_id: &str) -> Vec<(u16, String)> {
    let users = get_json(&format!("https://api.sleeper.app/v1/league/{league_id}/users")).unwrap_or(Value::Null);
    let rosters = get_json(&format!("https://api.sleeper.app/v1/league/{league_id}/rosters")).unwrap_or(Value::Null);
    let mut out = vec![];
    for r in rosters.as_array().cloned().unwrap_or_default() {
        let rid = r["roster_id"].as_u64().unwrap_or(0) as u16;
        let owner = r["owner_id"].as_str().unwrap_or("");
        let name = users
            .as_array()
            .and_then(|us| us.iter().find(|u| u["user_id"] == owner))
            .map(|u| u["metadata"]["team_name"].as_str().filter(|s| !s.trim().is_empty()).or(u["display_name"].as_str()).unwrap_or("").trim().to_string())
            .unwrap_or_else(|| format!("Roster {rid}"));
        out.push((rid, name));
    }
    out
}

fn print_result(out: &JobOutput, names: &[(u16, String)]) {
    let name = |r: u16| names.iter().find(|(id, _)| *id == r).map(|(_, n)| n.clone()).unwrap_or_else(|| format!("Roster {r}"));
    if let Some(e) = &out.error {
        println!("✗ {}: {}", e.code.as_str(), e.message);
        return;
    }
    match out.kind {
        Kind::WeeklyHighScore => {
            println!("Week {} high score · {} · season {}", out.week.unwrap_or(0), out.league_ref, out.season);
            for (i, s) in out.scores.iter().enumerate() {
                let paid = out.payouts.iter().find(|p| p.roster_id == s.roster_id);
                println!(
                    "  {:>2}. {:<28} roster {:>2}  {:>8}{}",
                    i + 1,
                    name(s.roster_id).chars().take(28).collect::<String>(),
                    s.roster_id,
                    if s.missing { "no lineup".into() } else { format_points_x100(s.points_x100) },
                    paid.map(|p| format!("  ← {}", dollars(p.amount.0))).unwrap_or_default()
                );
            }
        }
        Kind::Season => {
            println!("Season payout · {} · season {}", out.league_ref, out.season);
            for p in out.placements.clone().unwrap_or_default() {
                println!("  place {}: {} (roster {})", p.place, name(p.roster_id), p.roster_id);
            }
            println!("  (amounts come from the vault balance at settlement; see --settlement)");
        }
    }
    if let Some(src) = &out.source {
        println!("Data: {} Sleeper URLs", src.urls.len());
        for u in &src.urls {
            println!("  {u}");
        }
        println!("  sha256 {}", src.sha256);
    }
}

fn run_job(input: &JobInput, request_id: Option<String>) -> (JobOutput, String) {
    let mut fetch = outlayer_job::native::UreqFetch::default();
    let out = outlayer_job::run_output(input, &mut fetch, request_id);
    let text = settle_core::canonical::to_canonical_string(&out);
    (out, text)
}

fn sha256_hex(b: &[u8]) -> String {
    settle_core::canonical::sha256_hex(b)
}

fn main() -> ExitCode {
    let a = parse_args();
    if let Some(spec) = a.settlement.clone() {
        return verify_settlement(&a, &spec);
    }
    let Some(sleeper) = a.sleeper.clone() else { usage() };
    if a.week.is_some() == a.season {
        usage();
    }
    let league = get_json(&format!("https://api.sleeper.app/v1/league/{sleeper}")).unwrap_or(Value::Null);
    let season = league["season"].as_str().unwrap_or("").to_string();
    let rsw = league["settings"]["playoff_week_start"].as_u64().map(|p| p.saturating_sub(1)).unwrap_or(14) as u8;
    let split: Vec<u16> = a.split.split(',').map(|p| (p.trim().parse::<f64>().unwrap_or_else(|_| usage()) * 100.0).round() as u16).collect();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() as u64;
    let input = JobInput {
        sleeper_league_id: sleeper.clone(),
        season,
        kind: if a.season { Kind::Season } else { Kind::WeeklyHighScore },
        week: a.week,
        rules: settle_core::Rules {
            weekly_amount: settle_core::Amount(parse_dollars(&a.weekly)),
            regular_season_weeks: rsw.max(1),
            season_split_bps: split,
        },
        now_ns: settle_core::U64Str(now),
    };
    let (out, text) = run_job(&input, None);
    if a.json {
        println!("{text}");
    } else {
        print_result(&out, &team_names(&sleeper));
        println!("Result sha256 (canonical JSON, no request id): {}", sha256_hex(text.as_bytes()));
    }
    if out.error.is_some() {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    }
}

fn verify_settlement(a: &Args, spec: &str) -> ExitCode {
    let (lid, key) = spec.split_once(':').unwrap_or_else(|| usage());
    let league_id: u64 = lid.parse().unwrap_or_else(|_| usage());
    let key = match key.trim_start_matches('w') {
        "season" | "Season" => json!("Season"),
        w => json!({ "Week": w.parse::<u8>().unwrap_or_else(|_| usage()) }),
    };
    let fail = |m: String| {
        eprintln!("✗ {m}");
        ExitCode::from(1)
    };
    let s = match view(&a.rpc, &a.contract, "get_settlement", json!({ "league_id": league_id, "key": key })) {
        Ok(v) if !v.is_null() => v,
        Ok(_) => return fail(format!("league {league_id} has no settlement for {key}")),
        Err(e) => return fail(e),
    };
    let config = match view(&a.rpc, &a.contract, "get_config", json!({})) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    // 1. The input the contract sent.
    let input_text = match view(&a.rpc, &a.contract, "job_input", json!({ "league_id": league_id, "key": key, "now_ns": s["requested_at_ns"] })) {
        Ok(Value::String(t)) => t,
        Ok(_) | Err(_) => return fail("couldn't rebuild the job input".into()),
    };
    let input: JobInput = serde_json::from_str(&input_text).unwrap();
    let input_ok = sha256_hex(input_text.as_bytes()) == s["input_sha256"].as_str().unwrap_or("");
    // 2. Rerun the job here.
    let request_id = s["attestation_ref"].as_str().map(|x| x.to_string());
    let (out, text) = run_job(&input, request_id.clone());
    let names = team_names(&input.sleeper_league_id);
    if !a.json {
        print_result(&out, &names);
        println!();
    }
    let ours = sha256_hex(text.as_bytes());
    let stored = s["result_sha256"].as_str().unwrap_or("").to_string();
    let result_ok = !stored.is_empty() && ours == stored;
    // 3. Compare the math line by line, so a stat correction shows up as a diff.
    let mut diffs: Vec<String> = vec![];
    let on_chain_scores: Vec<(u64, i64)> =
        s["scores"].as_array().cloned().unwrap_or_default().iter().map(|x| (x["roster_id"].as_u64().unwrap_or(0), x["points_x100"].as_i64().unwrap_or(0))).collect();
    for sc in &out.scores {
        match on_chain_scores.iter().find(|(r, _)| *r == sc.roster_id as u64) {
            Some((_, p)) if *p != sc.points_x100 => diffs.push(format!(
                "roster {}: {} on chain, {} now",
                sc.roster_id,
                format_points_x100(*p),
                format_points_x100(sc.points_x100)
            )),
            None if out.kind == Kind::WeeklyHighScore => diffs.push(format!("roster {} missing on chain", sc.roster_id)),
            _ => {}
        }
    }
    let chain_placements: Vec<(u64, u64)> =
        s["placements"].as_array().cloned().unwrap_or_default().iter().map(|p| (p["place"].as_u64().unwrap_or(0), p["roster_id"].as_u64().unwrap_or(0))).collect();
    let our_placements: Vec<(u64, u64)> = out.placements.clone().unwrap_or_default().iter().map(|p| (p.place as u64, p.roster_id as u64)).collect();
    if chain_placements != our_placements {
        diffs.push(format!("placements: {chain_placements:?} on chain, {our_placements:?} now"));
    }
    if out.kind == Kind::WeeklyHighScore {
        let chain_pay: Vec<(u64, String)> =
            s["payouts"].as_array().cloned().unwrap_or_default().iter().map(|p| (p["roster_id"].as_u64().unwrap_or(0), p["amount"].as_str().unwrap_or("").to_string())).collect();
        let our_pay: Vec<(u64, String)> = out.payouts.iter().map(|p| (p.roster_id as u64, p.amount.0.to_string())).collect();
        if chain_pay != our_pay {
            diffs.push(format!("payouts: {chain_pay:?} on chain, {our_pay:?} now"));
        }
    }
    let source_ok = out.source.as_ref().map(|x| x.sha256.as_str()) == s["source_sha256"].as_str();
    // 4. OutLayer's attestation.
    let mut att_lines = vec![];
    let mut att_ok = false;
    if let Some(rid) = &request_id {
        match get_json(&format!("{OUTLAYER_API}/attestations/by-request/{rid}")) {
            Ok(att) => {
                let code = att["executed_wasm_sha256"] == config["job_wasm_sha256"];
                let inp = att["input_hash"] == s["input_sha256"];
                let outp = att["output_hash"] == s["result_sha256"];
                let caller = att["caller_account_id"].as_str().unwrap_or("?").to_string();
                att_ok = code && inp && outp;
                att_lines.push(format!("  code   {} executed_wasm_sha256 = pinned {}", tick(code), config["job_wasm_sha256"].as_str().unwrap_or("")));
                att_lines.push(format!("  input  {} input_hash = contract's input_sha256", tick(inp)));
                att_lines.push(format!("  output {} output_hash = contract's result_sha256", tick(outp)));
                att_lines.push(format!("  worker measurement {}, TDX quote {} bytes, caller {caller}", att["worker_measurement"].as_str().unwrap_or("?"), att["tdx_quote"].as_str().map(|q| q.len()).unwrap_or(0)));
                att_lines.push(format!("  {OUTLAYER_API}/attestations/by-request/{rid}"));
            }
            Err(e) => att_lines.push(format!("  couldn't fetch the attestation: {e}")),
        }
    }
    if a.json {
        println!(
            "{}",
            json!({
                "matches": result_ok && diffs.is_empty(),
                "input_sha256_ok": input_ok, "result_sha256_ok": result_ok, "source_sha256_ok": source_ok,
                "attestation_ok": att_ok, "diffs": diffs, "recomputed": serde_json::from_str::<Value>(&text).unwrap(),
            })
        );
    } else {
        println!("On chain: {} league {league_id} {key}", a.contract);
        println!("  {} input sha256 {}", tick(input_ok), s["input_sha256"].as_str().unwrap_or(""));
        println!("  {} result sha256 {} {}", tick(result_ok), stored, if result_ok { "(recomputed here: identical bytes)" } else { "" });
        println!("  {} source sha256 {}", tick(source_ok), s["source_sha256"].as_str().unwrap_or(""));
        if !att_lines.is_empty() {
            println!("OutLayer attestation:");
            for l in &att_lines {
                println!("{l}");
            }
        }
        if result_ok && diffs.is_empty() {
            println!("\nMatches ✓");
        } else if diffs.is_empty() {
            println!("\nThe math matches, but the bytes differ (Sleeper's raw data changed since settlement).");
        } else {
            println!("\nDiffers ✗ (Sleeper may have applied a stat correction):");
            for d in &diffs {
                println!("  {d}");
            }
        }
    }
    if result_ok && diffs.is_empty() {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}

fn tick(ok: bool) -> &'static str {
    if ok {
        "✓"
    } else {
        "✗"
    }
}
