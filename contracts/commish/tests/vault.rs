//! Spike S1 and SPEC 10.2: the vault policy, membership, and who can move money.

mod common;
use common::*;
use near_workspaces::types::{Gas, NearToken};
use serde_json::json;

#[tokio::test]
async fn create_league_deploys_vault_with_the_policy() {
    let env = Env::new().await;
    let (id, vault) = env.create_league(&[1, 2, 3], json!({})).await;
    let name = vault.as_str().strip_suffix(&format!(".{}", env.factory.id())).unwrap();
    assert!(name.starts_with(&format!("cm-{id}-")) && name.len() == format!("cm-{id}-").len() + 6, "unpredictable suffix: {name}");

    let p = env.vault_policy(&vault).await;
    assert_eq!(p["proposal_bond"], "0");
    assert_eq!(p["proposal_period"], "15552000000000000", "180 days");
    let roles = p["roles"].as_array().unwrap();
    assert_eq!(roles.len(), 2);
    assert_eq!(roles[0]["name"], "settler");
    assert_eq!(roles[0]["kind"]["Group"], json!([env.commish.id()]));
    assert_eq!(roles[1]["name"], "league");
    assert_eq!(roles[1]["kind"]["Group"], json!([env.commissioner.id()]));
    assert_eq!(roles[1]["vote_policy"]["transfer"]["quorum"], "2", "3 teams: quorum max(2, 3/2+1)");

    // The vault is registered with the token and the league remembers it.
    let reg: serde_json::Value = env
        .token
        .view("storage_balance_of")
        .args_json(json!({ "account_id": vault }))
        .await
        .unwrap()
        .json()
        .unwrap();
    assert!(!reg.is_null(), "vault registered with the token");
    let league = env.league(id).await;
    assert_eq!(league["team_count"], 3);
    assert_eq!(league["rules_locked"], false);

    // How much of the vault deposit is locked for storage (decides VAULT_DEPOSIT on testnet).
    let acct = env.worker.view_account(&vault).await.unwrap();
    let locked = acct.storage_usage as u128 * 10_000_000_000_000_000_000;
    eprintln!("vault storage {} bytes = {} NEAR locked; balance {} NEAR",
        acct.storage_usage, locked as f64 / 1e24, acct.balance.as_yoctonear() as f64 / 1e24);
    assert!(acct.balance.as_yoctonear() > locked + 200_000_000_000_000_000_000_000, "at least 0.2 NEAR free for proposals");
}

#[tokio::test]
async fn league_votes_need_a_majority_and_at_least_two_votes() {
    // Directly against the DAO: league-role votes. (The settler approving alone after the hold,
    // and a league majority rejecting first, are covered through the contract in flow.rs.)
    let env = Env::new().await;
    let (id, vault) = env.create_league(&[1, 2, 3], json!({})).await;
    let a = env.member("alice", 100 * USDC).await;
    let b = env.member("bob", 100 * USDC).await;
    env.claim_and_approve(&a, id, 2).await;
    env.claim_and_approve(&b, id, 3).await;
    let p = env.vault_policy(&vault).await;
    let league_members = p["roles"][1]["kind"]["Group"].as_array().unwrap().len();
    assert_eq!(league_members, 3, "commissioner + 2 approved members: {p}");

    // Money in the vault.
    check(&env.pay(&a, id, 2, 50 * USDC).await, "pay a");

    // A league member proposes a transfer to themselves and the commissioner approves.
    // With quorum 2 and 3 members, 2 approvals are needed: one isn't enough.
    let kind = json!({ "Transfer": { "token_id": env.token.id(), "receiver_id": a.id(), "amount": (10 * USDC).to_string(), "msg": null } });
    let r = a
        .call(&vault, "add_proposal")
        .args_json(json!({ "proposal": { "description": "self-pay", "kind": kind } }))
        .transact()
        .await
        .unwrap();
    check(&r, "add_proposal by a member");
    let pid: u64 = r.json().unwrap();
    check(
        &env.commissioner
            .call(&vault, "act_proposal")
            .args_json(json!({ "id": pid, "action": "VoteApprove", "proposal": kind }))
            .gas(Gas::from_tgas(150))
            .transact()
            .await
            .unwrap(),
        "commissioner approves",
    );
    assert_eq!(env.proposal(&vault, pid).await["status"], "InProgress", "one league vote can't move money");
    check(
        &b.call(&vault, "act_proposal")
            .args_json(json!({ "id": pid, "action": "VoteReject", "proposal": kind }))
            .gas(Gas::from_tgas(150))
            .transact()
            .await
            .unwrap(),
        "bob rejects",
    );
    // 1 approve, 1 reject: still in progress. The proposer's vote decides it.
    check(
        &a.call(&vault, "act_proposal")
            .args_json(json!({ "id": pid, "action": "VoteApprove", "proposal": kind }))
            .gas(Gas::from_tgas(150))
            .transact()
            .await
            .unwrap(),
        "alice approves",
    );
    assert_eq!(env.proposal(&vault, pid).await["status"], "Approved", "a league majority can move money (disclosed)");
    assert_eq!(env.usdc_balance(&vault).await, 40 * USDC);
}

#[tokio::test]
async fn a_commissioner_alone_cannot_move_money() {
    let env = Env::new().await;
    let (id, vault) = env.create_league(&[1, 2, 3], json!({})).await;
    let a = env.member("alice", 100 * USDC).await;
    // Dues arrive before any claim is approved: the commissioner is the league's only member.
    check(&env.pay(&a, id, 2, 50 * USDC).await, "pay");
    assert_eq!(env.usdc_balance(&vault).await, 50 * USDC);

    let kind = json!({ "Transfer": { "token_id": env.token.id(), "receiver_id": env.commissioner.id(), "amount": (50 * USDC).to_string(), "msg": null } });
    let r = env
        .commissioner
        .call(&vault, "add_proposal")
        .args_json(json!({ "proposal": { "description": "mine now", "kind": kind } }))
        .transact()
        .await
        .unwrap();
    check(&r, "commissioner can propose");
    let pid: u64 = r.json().unwrap();
    check(
        &env.commissioner
            .call(&vault, "act_proposal")
            .args_json(json!({ "id": pid, "action": "VoteApprove", "proposal": kind }))
            .gas(Gas::from_tgas(150))
            .transact()
            .await
            .unwrap(),
        "commissioner votes",
    );
    assert_eq!(env.proposal(&vault, pid).await["status"], "InProgress", "quorum 2: one vote never passes");
    assert_eq!(env.usdc_balance(&vault).await, 50 * USDC, "the pot is untouched");

    // Nor can the commissioner finalize a proposal they made, or call the vault as settler.
    let r = env
        .commissioner
        .call(&vault, "act_proposal")
        .args_json(json!({ "id": pid, "action": "Finalize", "proposal": kind }))
        .gas(Gas::from_tgas(150))
        .transact()
        .await
        .unwrap();
    assert!(r.is_failure(), "no Finalize permission for the league");
    // And the commish contract has no method that moves money for the commissioner: the only
    // commissioner methods are approve_claim, decline_claim and update_rules (see tests in flow.rs).
    let _ = NearToken::from_near(0);
}

#[tokio::test]
async fn a_commissioner_with_a_sock_puppet_cannot_move_money() {
    // 12 teams: league votes need 7. The commissioner approves one account they control and
    // the two of them try to pay the pot to the commissioner.
    let env = Env::new().await;
    let (id, vault) = env.create_league(&[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], json!({})).await;
    let payer = env.member("payer", 200 * USDC).await;
    for r in [3u16, 4] {
        check(&env.pay(&payer, id, r, 50 * USDC).await, "honest dues");
    }
    let sock = env.member("sock", 0).await;
    env.claim_and_approve(&sock, id, 7).await;
    let p = env.vault_policy(&vault).await;
    assert_eq!(p["roles"][1]["vote_policy"]["transfer"]["quorum"], "7");
    let kind = json!({ "Transfer": { "token_id": env.token.id(), "receiver_id": env.commissioner.id(), "amount": (100 * USDC).to_string(), "msg": null } });
    let r = sock
        .call(&vault, "add_proposal")
        .args_json(json!({ "proposal": { "description": "ours now", "kind": kind } }))
        .transact()
        .await
        .unwrap();
    check(&r, "add_proposal");
    let pid: u64 = r.json().unwrap();
    for who in [&sock, &env.commissioner] {
        check(
            &who.call(&vault, "act_proposal")
                .args_json(json!({ "id": pid, "action": "VoteApprove", "proposal": kind }))
                .gas(Gas::from_tgas(150))
                .transact()
                .await
                .unwrap(),
            "vote",
        );
    }
    assert_eq!(env.proposal(&vault, pid).await["status"], "InProgress", "2 of the 7 votes needed");
    assert_eq!(env.usdc_balance(&vault).await, 100 * USDC, "the pot is untouched");
}
