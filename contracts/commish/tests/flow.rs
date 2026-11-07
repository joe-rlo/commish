//! SPEC 10.2: claims, dues, settle → hold → finalize, rejection, withholding, season.
//! Every settlement goes through the real OutLayer contract's yield/resume.

mod common;
use common::*;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::Account;
use serde_json::{json, Value};

const ALL: [u16; 12] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/// A league where `n` members claimed, got approved for, and paid rosters 1..=n.
async fn league_with_members(env: &Env, n: u16, rules: Value) -> (u64, near_workspaces::AccountId, Vec<Account>) {
    let (id, vault) = env.create_league(&ALL, rules).await;
    let mut members = vec![];
    for r in 1..=n {
        let m = env.member(&format!("m{r}"), 100 * USDC).await;
        env.claim_and_approve(&m, id, r).await;
        check(&env.pay(&m, id, r, 50 * USDC).await, "pay");
        members.push(m);
    }
    (id, vault, members)
}

#[tokio::test]
async fn claims_need_the_commissioner_and_add_members_to_the_vault() {
    let env = Env::new().await;
    let (id, vault) = env.create_league(&ALL, json!({})).await;
    let a = env.member("alice", 0).await;
    let b = env.member("bob", 0).await;

    check(&env.claim(&a, id, 2).await, "claim");
    let teams = env.teams(id).await;
    assert_eq!(teams[1]["claim"], json!({ "Pending": a.id() }));
    // Someone else can't take a pending team, and alice can't claim a second team.
    assert!(failure_text(&env.claim(&b, id, 2).await).contains("already claimed"));
    assert!(failure_text(&env.claim(&a, id, 3).await).contains("already have a team"));
    // Only the commissioner approves.
    assert!(failure_text(&env.approve(&b, id, 2).await).contains("Only the commissioner"));
    check(&env.approve(&env.commissioner, id, 2).await, "approve");
    let teams = env.teams(id).await;
    assert_eq!(teams[1]["claim"], "Approved");
    assert_eq!(teams[1]["account"], json!(a.id()));
    let group = env.vault_policy(&vault).await["roles"][1]["kind"]["Group"].clone();
    assert!(group.as_array().unwrap().contains(&json!(a.id())), "alice joined the league role: {group}");
    let reg: Value = env.token.view("storage_balance_of").args_json(json!({ "account_id": a.id() })).await.unwrap().json().unwrap();
    assert!(!reg.is_null(), "alice is registered with the token");

    // Decline returns a claim to unclaimed.
    check(&env.claim(&b, id, 3).await, "claim 3");
    check(
        &env.commissioner
            .call(env.commish.id(), "decline_claim")
            .args_json(json!({ "league_id": id, "roster_id": 3 }))
            .transact()
            .await
            .unwrap(),
        "decline",
    );
    assert_eq!(env.teams(id).await[2]["claim"], "Unclaimed");
}

#[tokio::test]
async fn dues_are_recorded_forwarded_refunded_and_lock_the_rules() {
    let env = Env::new().await;
    let (id, vault) = env.create_league(&ALL, json!({})).await;
    let a = env.member("alice", 200 * USDC).await;

    // Rules can change before anyone pays.
    check(
        &env.commissioner
            .call(env.commish.id(), "update_rules")
            .args_json(json!({ "league_id": id, "update": { "weekly_amount": (4 * USDC).to_string() } }))
            .transact()
            .await
            .unwrap(),
        "update rules",
    );
    // Pay 60 for a $50 team, before any claim exists: credited to the team, 10 comes back.
    check(&env.pay(&a, id, 5, 60 * USDC).await, "pay");
    assert_eq!(env.usdc_balance(&vault).await, 50 * USDC, "dues forwarded to the vault");
    assert_eq!(env.usdc_balance(env.commish.id()).await, 0, "the contract holds nothing");
    assert_eq!(env.usdc_balance(a.id()).await, 150 * USDC, "excess refunded");
    let teams = env.teams(id).await;
    assert_eq!(teams[4]["dues_paid"], (50 * USDC).to_string());
    let league = env.league(id).await;
    assert_eq!(league["rules_locked"], true);
    assert_eq!(league["dues_total"], (50 * USDC).to_string());
    assert_eq!(league["paid_count"], 1);

    // Paying an already-paid team returns everything.
    check(&env.pay(&a, id, 5, 10 * USDC).await, "overpay");
    assert_eq!(env.usdc_balance(a.id()).await, 150 * USDC);
    assert_eq!(env.usdc_balance(&vault).await, 50 * USDC);

    // Rules are locked now.
    let r = env
        .commissioner
        .call(env.commish.id(), "update_rules")
        .args_json(json!({ "league_id": id, "update": { "weekly_amount": "0" } }))
        .transact()
        .await
        .unwrap();
    assert!(failure_text(&r).contains("Rules are locked"));

    // Bad msg or unknown team: the token refunds the payer.
    let r = a
        .call(env.token.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": env.commish.id(), "amount": USDC.to_string(), "msg": "{\"league_id\":0,\"roster_id\":99}" }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(150))
        .transact()
        .await
        .unwrap();
    check(&r, "ft_transfer_call itself succeeds");
    assert_eq!(env.usdc_balance(a.id()).await, 150 * USDC, "refunded");
    assert_eq!(env.usdc_balance(env.commish.id()).await, 0);
}

#[tokio::test]
async fn ft_on_transfer_only_accepts_the_leagues_token() {
    let env = Env::new().await;
    let (id, _vault) = env.create_league(&ALL, json!({})).await;
    let fake = env.member("fake", 0).await;
    let r = fake
        .call(env.commish.id(), "ft_on_transfer")
        .args_json(json!({ "sender_id": fake.id(), "amount": (50 * USDC).to_string(), "msg": json!({ "league_id": id, "roster_id": 1 }).to_string() }))
        .transact()
        .await
        .unwrap();
    assert!(failure_text(&r).contains("different token"));
    assert_eq!(env.teams(id).await[0]["dues_paid"], "0");
}

#[tokio::test]
async fn settle_holds_then_pays_the_winner_and_cannot_repeat() {
    let env = Env::new().await;
    // Week 1's winner is roster 2.
    let (id, vault, members) = league_with_members(&env, 2, json!({})).await;
    let winner = &members[1];
    let anyone = env.member("anyone", 0).await;
    let before = env.usdc_balance(winner.id()).await;

    let r = env.settle(&anyone, id, week(1)).await;
    check(&r, "settle");
    let s = env.settlement(id, week(1)).await;
    assert_eq!(s["status"], "OnHold", "{s}");
    assert_eq!(s["payouts"].as_array().unwrap().len(), 1);
    let p = &s["payouts"][0];
    assert_eq!(p["roster_id"], 2);
    assert_eq!(p["account"], json!(winner.id()));
    assert_eq!(p["amount"], (5 * USDC).to_string());
    assert_eq!(p["status"], "OnHold");
    assert_eq!(s["scores"][0]["points_x100"], 17002);
    assert_eq!(s["scores"].as_array().unwrap().len(), 12);
    // Hashes and the attestation reference are recorded. The source hash is the one the JS
    // fixture builder computed for week 1.
    let case: Value = serde_json::from_str(&std::fs::read_to_string(repo().join("fixtures/cases/demo-week-01.json")).unwrap()).unwrap();
    assert_eq!(s["source_sha256"], case["expect"]["source_sha256"]);
    let expected_out = run_real_job(
        &env.commish.view("job_input").args_json(json!({"league_id": id, "key": week(1), "now_ns": s["requested_at_ns"]})).await.unwrap().json::<String>().unwrap(),
        s["attestation_ref"].as_str().unwrap().parse().unwrap(),
    );
    assert_eq!(s["result_sha256"], sha256_hex(expected_out.as_bytes()), "stored hash = SHA-256 of the canonical output");
    assert!(s["attestation_ref"].is_string());
    assert_eq!(env.league(id).await["on_hold_total"], (5 * USDC).to_string());

    // The proposal exists in the vault, untouched.
    let pid = p["proposal_id"].as_u64().unwrap();
    let prop = env.proposal(&vault, pid).await;
    assert_eq!(prop["status"], "InProgress");
    assert_eq!(prop["kind"]["Transfer"]["receiver_id"], json!(winner.id()));

    // A second settle for the same week fails.
    let r = anyone
        .call(env.commish.id(), "settle")
        .args_json(json!({ "league_id": id, "key": week(1) }))
        .deposit(NearToken::from_millinear(30))
        .gas(Gas::from_tgas(300))
        .transact()
        .await
        .unwrap();
    assert!(failure_text(&r).contains("already settled"));

    // Finalize before the hold window ends fails.
    let r = env.finalize(&anyone, id, week(1)).await;
    assert!(failure_text(&r).contains("hold window ends"));
    assert_eq!(env.usdc_balance(winner.id()).await, before);

    // After the window, anyone can finalize and the winner is paid from the vault.
    env.wait_until(s["hold_ends_at_ns"].as_str().unwrap().parse().unwrap()).await;
    check(&env.finalize(&anyone, id, week(1)).await, "finalize");
    let s = env.settlement(id, week(1)).await;
    assert_eq!(s["status"], "Final", "{s}");
    assert_eq!(s["payouts"][0]["status"], "Paid");
    assert_eq!(env.proposal(&vault, pid).await["status"], "Approved");
    assert_eq!(env.usdc_balance(winner.id()).await, before + 5 * USDC);
    assert_eq!(env.usdc_balance(&vault).await, 100 * USDC - 5 * USDC);
    assert_eq!(env.league(id).await["on_hold_total"], "0");
    // Finalizing again does nothing.
    assert!(failure_text(&env.finalize(&anyone, id, week(1)).await).contains("Nothing on hold"));
}

#[tokio::test]
async fn a_league_majority_stops_a_payout_during_the_hold() {
    let env = Env::new().await;
    // Week 3's winner is roster 8. Rosters 1..8 claimed and paid: league role = commissioner + 8.
    let (id, vault, members) = league_with_members(&env, 8, json!({})).await;
    let anyone = env.member("anyone", 0).await;
    check(&env.settle(&anyone, id, week(3)).await, "settle");
    let s = env.settlement(id, week(3)).await;
    let pid = s["payouts"][0]["proposal_id"].as_u64().unwrap();
    let kind = env.proposal(&vault, pid).await["kind"].clone();

    // 9 members: threshold is 9/2 + 1 = 5 rejects.
    for m in members.iter().take(5) {
        check(
            &m.call(&vault, "act_proposal")
                .args_json(json!({ "id": pid, "action": "VoteReject", "proposal": kind }))
                .gas(Gas::from_tgas(150))
                .transact()
                .await
                .unwrap(),
            "reject",
        );
    }
    assert_eq!(env.proposal(&vault, pid).await["status"], "Rejected");

    env.wait_until(s["hold_ends_at_ns"].as_str().unwrap().parse().unwrap()).await;
    let pot = env.usdc_balance(&vault).await;
    check(&env.finalize(&anyone, id, week(3)).await, "finalize");
    let s = env.settlement(id, week(3)).await;
    assert_eq!(s["status"], "Final");
    assert_eq!(s["payouts"][0]["status"], "Stopped");
    assert_eq!(env.usdc_balance(&vault).await, pot, "the money stays in the pot");
    assert_eq!(env.league(id).await["on_hold_total"], "0");
}

#[tokio::test]
async fn unpaid_or_unclaimed_winners_are_withheld() {
    let env = Env::new().await;
    let (id, vault) = env.create_league(&ALL, json!({})).await;
    let payer = env.member("payer", 500 * USDC).await;
    // Pot: rosters 1, 3, 4 paid by someone. Roster 2 (week 1 winner) is approved but unpaid.
    for r in [1u16, 3, 4] {
        check(&env.pay(&payer, id, r, 50 * USDC).await, "pay");
    }
    let w = env.member("winner", 0).await;
    env.claim_and_approve(&w, id, 2).await;
    let anyone = env.member("anyone", 0).await;
    check(&env.settle(&anyone, id, week(1)).await, "settle week 1");
    let s = env.settlement(id, week(1)).await;
    assert_eq!(s["status"], "Final");
    assert_eq!(s["payouts"][0]["status"], "Withheld");
    assert_eq!(s["payouts"][0]["withheld_reason"], "dues_unpaid");
    assert!(s["payouts"][0]["proposal_id"].is_null(), "no proposal");

    // Week 3's winner (roster 8) has no account at all.
    check(&env.settle(&anyone, id, week(3)).await, "settle week 3");
    let s = env.settlement(id, week(3)).await;
    assert_eq!(s["payouts"][0]["withheld_reason"], "no_account");
    assert_eq!(env.usdc_balance(&vault).await, 150 * USDC, "nothing left the pot");
}

#[tokio::test]
async fn a_payout_bigger_than_the_pot_is_withheld() {
    let env = Env::new().await;
    // Weekly $5, but only one $50 dues payment: pot is enough. Make it too small with $1 dues.
    let (id, vault) = env.create_league(&ALL, json!({ "dues": USDC.to_string(), "weekly_amount": (5 * USDC / 7).to_string() })).await;
    let w = env.member("winner", 10 * USDC).await;
    env.claim_and_approve(&w, id, 2).await;
    // Pot: 1 USDC... weekly amount is 714285: fits once; second payout on hold needs more.
    check(&env.pay(&w, id, 2, USDC).await, "pay");
    let anyone = env.member("anyone", 0).await;
    check(&env.settle(&anyone, id, week(1)).await, "week 1 (roster 2)");
    assert_eq!(env.settlement(id, week(1)).await["payouts"][0]["status"], "OnHold");
    // Week 2's winner is also roster 2: 714285 more than the 285715 left after the hold.
    check(&env.settle(&anyone, id, week(2)).await, "week 2 (roster 2)");
    let s = env.settlement(id, week(2)).await;
    assert_eq!(s["payouts"][0]["status"], "Withheld", "{s}");
    assert_eq!(s["payouts"][0]["withheld_reason"], "pot_too_small");
    assert_eq!(env.usdc_balance(&vault).await, USDC);
}

#[tokio::test]
async fn enclave_errors_and_foreign_results_pay_nothing_and_can_be_retried() {
    let env = Env::new().await;
    let (id, _vault, _members) = league_with_members(&env, 2, json!({})).await;
    let anyone = env.member("anyone", 0).await;

    // 1. The job reports WEEK_NOT_FINAL.
    let not_final = |input: &str, rid: u64| {
        let v: Value = serde_json::from_str(input).unwrap();
        json!({
            "core_version": settle_core::CORE_VERSION, "kind": v["kind"], "league_ref": format!("sleeper:{}", v["sleeper_league_id"].as_str().unwrap()),
            "season": v["season"], "week": v["week"], "scores": [], "payouts": [], "placements": null,
            "error": { "code": "WEEK_NOT_FINAL", "message": "the NFL is in week 1; week 1 isn't over" },
            "outlayer_request_id": rid.to_string(),
        })
        .to_string()
    };
    check(&env.settle_with(&anyone, id, week(1), Some(&not_final)).await, "settle");
    let s = env.settlement(id, week(1)).await;
    assert_eq!(s["status"], "Failed");
    assert!(s["error"].as_str().unwrap().starts_with("WEEK_NOT_FINAL"));

    // 2. A result for another league is rejected.
    let foreign = |input: &str, rid: u64| {
        let mut out: Value = serde_json::from_str(&run_real_job(input, rid)).unwrap();
        out["league_ref"] = json!("sleeper:1");
        out.to_string()
    };
    check(&env.settle_with(&anyone, id, week(1), Some(&foreign)).await, "settle again");
    let s = env.settlement(id, week(1)).await;
    assert_eq!(s["status"], "Failed");
    assert!(s["error"].as_str().unwrap().contains("different league"), "{s}");

    // 3. A result that pays more than the rules allow is rejected.
    let greedy = |input: &str, rid: u64| {
        let mut out: Value = serde_json::from_str(&run_real_job(input, rid)).unwrap();
        out["payouts"][0]["amount"] = json!((500 * USDC).to_string());
        out.to_string()
    };
    check(&env.settle_with(&anyone, id, week(1), Some(&greedy)).await, "settle greedy");
    assert!(env.settlement(id, week(1)).await["error"].as_str().unwrap().contains("more than the weekly amount"));

    // 4. A failed run (`null`) is recorded too.
    let null = |_: &str, _: u64| "null".to_string();
    check(&env.settle_with(&anyone, id, week(1), Some(&null)).await, "settle null");
    assert!(env.settlement(id, week(1)).await["error"].as_str().unwrap().contains("failed or timed out"));

    // 5. Retried with the real job: pays as normal.
    check(&env.settle(&anyone, id, week(1)).await, "retry");
    assert_eq!(env.settlement(id, week(1)).await["status"], "OnHold");
    assert_eq!(env.league(id).await["on_hold_total"], (5 * USDC).to_string());
}

#[tokio::test]
async fn weeks_outside_the_regular_season_are_refused() {
    let env = Env::new().await;
    let (id, _vault) = env.create_league(&ALL, json!({})).await;
    let anyone = env.member("anyone", 0).await;
    for w in [0u8, 15] {
        let r = anyone
            .call(env.commish.id(), "settle")
            .args_json(json!({ "league_id": id, "key": week(w) }))
            .deposit(NearToken::from_millinear(30))
            .gas(Gas::from_tgas(300))
            .transact()
            .await
            .unwrap();
        assert!(failure_text(&r).contains("isn't a regular-season week"));
    }
}

#[tokio::test]
async fn season_pays_placements_from_the_vault_balance() {
    let env = Env::new().await;
    // No weekly payouts, so the season can settle without the weeks. Real bracket: 8, 2, 1.
    let (id, vault) = env.create_league(&ALL, json!({ "weekly_amount": "0" })).await;
    let payer = env.member("payer", 500 * USDC).await;
    // Everyone's dues paid by one account (credit goes to the team, not the payer).
    for r in 1..=10u16 {
        check(&env.pay(&payer, id, r, 50 * USDC).await, "pay");
    }
    let (a, b, c) = (env.member("eight", 100 * USDC).await, env.member("two", 100 * USDC).await, env.member("one", 100 * USDC).await);
    env.claim_and_approve(&a, id, 8).await;
    env.claim_and_approve(&b, id, 2).await;
    env.claim_and_approve(&c, id, 1).await;
    check(&env.pay(&a, id, 11, 50 * USDC).await, "pay 11");
    check(&env.pay(&a, id, 12, 50 * USDC).await, "pay 12");
    assert_eq!(env.usdc_balance(&vault).await, 600 * USDC);

    let anyone = env.member("anyone", 0).await;
    check(&env.settle(&anyone, id, season()).await, "settle season");
    let s = env.settlement(id, season()).await;
    assert_eq!(s["status"], "OnHold", "{s}");
    assert_eq!(s["payout_base"], (600 * USDC).to_string());
    let amounts: Vec<(u64, u64, String)> = s["payouts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| (p["place"].as_u64().unwrap(), p["roster_id"].as_u64().unwrap(), p["amount"].as_str().unwrap().to_string()))
        .collect();
    assert_eq!(
        amounts,
        vec![(1, 8, (360 * USDC).to_string()), (2, 2, (150 * USDC).to_string()), (3, 1, (90 * USDC).to_string())]
    );
    env.wait_until(s["hold_ends_at_ns"].as_str().unwrap().parse().unwrap()).await;
    let (ba, bb, bc) = (env.usdc_balance(a.id()).await, env.usdc_balance(b.id()).await, env.usdc_balance(c.id()).await);
    check(&env.finalize(&anyone, id, season()).await, "finalize season");
    assert_eq!(env.usdc_balance(a.id()).await, ba + 360 * USDC);
    assert_eq!(env.usdc_balance(b.id()).await, bb + 150 * USDC);
    assert_eq!(env.usdc_balance(c.id()).await, bc + 90 * USDC);
    assert_eq!(env.usdc_balance(&vault).await, 0);
    // A key settles once.
    let r = anyone
        .call(env.commish.id(), "settle")
        .args_json(json!({ "league_id": id, "key": season() }))
        .deposit(NearToken::from_millinear(30))
        .gas(Gas::from_tgas(300))
        .transact()
        .await
        .unwrap();
    assert!(failure_text(&r).contains("already settled"));
}

#[tokio::test]
async fn season_without_a_third_place_game_gives_third_to_first() {
    let env = Env::new().await;
    let (id, vault) = env.create_league(&ALL, json!({ "weekly_amount": "0" })).await;
    let payer = env.member("payer", 500 * USDC).await;
    for r in 1..=10u16 {
        check(&env.pay(&payer, id, r, 50 * USDC).await, "pay");
    }
    let a = env.member("eight", 0).await;
    let b = env.member("two", 0).await;
    env.claim_and_approve(&a, id, 8).await;
    env.claim_and_approve(&b, id, 2).await;
    let anyone = env.member("anyone", 0).await;
    // The job, on a bracket with no p=3 game.
    let no_third = |input: &str, rid: u64| {
        let mut rec = recorded_sleeper();
        for (u, v) in rec.iter_mut() {
            if u.ends_with("/winners_bracket") {
                v.as_array_mut().unwrap().retain(|g| g["p"] != 3);
            }
        }
        let mut fetch = outlayer_job::MapFetch(rec);
        outlayer_job::run_job(input, &mut fetch, Some(rid.to_string()))
    };
    check(&env.settle_with(&anyone, id, season(), Some(&no_third)).await, "settle");
    let s = env.settlement(id, season()).await;
    assert_eq!(s["placements"].as_array().unwrap().len(), 2);
    let amounts: Vec<String> = s["payouts"].as_array().unwrap().iter().map(|p| p["amount"].as_str().unwrap().to_string()).collect();
    // 500 base: 1st 60% + 15% = 375, 2nd 25% = 125.
    assert_eq!(amounts, vec![(375 * USDC).to_string(), (125 * USDC).to_string()]);
    assert_eq!(env.usdc_balance(&vault).await, 500 * USDC);
}

#[tokio::test]
async fn season_waits_for_every_weekly_payout() {
    let env = Env::new().await;
    let (id, _vault) = env.create_league(&ALL, json!({})).await;
    let anyone = env.member("anyone", 0).await;
    let r = anyone
        .call(env.commish.id(), "settle")
        .args_json(json!({ "league_id": id, "key": season() }))
        .deposit(NearToken::from_millinear(30))
        .gas(Gas::from_tgas(300))
        .transact()
        .await
        .unwrap();
    assert!(failure_text(&r).contains("Settle every week first: week 1"));
}

#[tokio::test]
async fn the_commissioner_has_no_method_that_moves_money() {
    // The commissioner-only methods are approve_claim, decline_claim and update_rules. Call each
    // on a league with money in the vault and check no token moves anywhere but registrations.
    let env = Env::new().await;
    let (id, vault, _members) = league_with_members(&env, 2, json!({})).await;
    let pot = env.usdc_balance(&vault).await;
    let c = &env.commissioner;
    let x = env.member("x", 0).await;
    check(&env.claim(&x, id, 5).await, "claim");
    check(&env.approve(c, id, 5).await, "approve");
    let _ = c.call(env.commish.id(), "decline_claim").args_json(json!({ "league_id": id, "roster_id": 6 })).transact().await.unwrap();
    let _ = c
        .call(env.commish.id(), "update_rules")
        .args_json(json!({ "league_id": id, "update": { "weekly_amount": (300 * USDC).to_string() } }))
        .transact()
        .await
        .unwrap();
    // reassign_team is the vault's, not the commissioner's.
    let r = c
        .call(env.commish.id(), "reassign_team")
        .args_json(json!({ "league_id": id, "roster_id": 1, "account": c.id() }))
        .deposit(NearToken::from_millinear(2))
        .transact()
        .await
        .unwrap();
    assert!(failure_text(&r).contains("Only the league's vault"));
    // The commissioner can't fake a settlement result either: callbacks are private.
    let r = c
        .call(env.commish.id(), "on_settle_result")
        .args_json(json!({ "league_id": id, "key": week(1) }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await
        .unwrap();
    assert!(r.is_failure());
    assert_eq!(env.usdc_balance(&vault).await, pot);
    assert_eq!(env.usdc_balance(c.id()).await, 0);
    assert_eq!(env.league(id).await["weekly_amount"], (5 * USDC).to_string(), "rules stayed locked");
}

#[tokio::test]
async fn a_league_vote_can_reassign_a_team() {
    use near_workspaces::types::Gas;
    let env = Env::new().await;
    let (id, vault) = env.create_league(&ALL, json!({})).await;
    let a = env.member("alice", 0).await;
    let b = env.member("bob", 0).await;
    let c = env.member("carol", 0).await;
    env.claim_and_approve(&a, id, 2).await;
    env.claim_and_approve(&b, id, 3).await;
    // League role: commissioner, alice, bob → 2 votes pass. Move roster 2 from alice to carol.
    let args = json!({ "league_id": id, "roster_id": 2, "account": c.id() }).to_string();
    use near_sdk::base64::Engine;
    let b64 = near_sdk::base64::engine::general_purpose::STANDARD.encode(args);
    let kind = json!({ "FunctionCall": { "receiver_id": env.commish.id(), "actions": [{
        "method_name": "reassign_team", "args": b64, "deposit": "1250000000000000000000", "gas": "200000000000000"
    }] } });
    let r = a
        .call(&vault, "add_proposal")
        .args_json(json!({ "proposal": { "description": "move roster 2 to carol", "kind": kind } }))
        .transact()
        .await
        .unwrap();
    check(&r, "add_proposal");
    let pid: u64 = r.json().unwrap();
    for m in [&a, &b] {
        check(
            &m.call(&vault, "act_proposal")
                .args_json(json!({ "id": pid, "action": "VoteApprove", "proposal": kind }))
                .gas(Gas::from_tgas(300))
                .transact()
                .await
                .unwrap(),
            "vote",
        );
    }
    assert_eq!(env.proposal(&vault, pid).await["status"], "Approved");
    // The membership proposals land a few blocks later.
    let mut group = json!([]);
    for _ in 0..20 {
        group = env.vault_policy(&vault).await["roles"][1]["kind"]["Group"].clone();
        if group.as_array().unwrap().contains(&json!(c.id())) && !group.as_array().unwrap().contains(&json!(a.id())) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }
    let team = &env.teams(id).await[1];
    assert_eq!(team["account"], json!(c.id()), "roster 2 now pays carol");
    assert!(group.as_array().unwrap().contains(&json!(c.id())), "carol joined the league role: {group}");
    assert!(!group.as_array().unwrap().contains(&json!(a.id())), "alice left the league role: {group}");
    let reg: Value = env.token.view("storage_balance_of").args_json(json!({ "account_id": c.id() })).await.unwrap().json().unwrap();
    assert!(!reg.is_null(), "carol is registered with the token");
}
