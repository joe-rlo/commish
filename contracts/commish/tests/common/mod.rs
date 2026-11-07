//! Sandbox harness: the commish contract against the exact Sputnik factory/DAO and OutLayer
//! contract bytes deployed on testnet (fixtures/wasm/), and our own Test USDC.
//!
//! OutLayer's off-chain worker is played by `operator`: it reads the pending request from the
//! real OutLayer contract, runs the real job code (`outlayer_job::run_job`) against recorded
//! Sleeper responses, and resolves the yield exactly as the production worker does
//! (`submit_execution_output_and_resolve`).

#![allow(dead_code)]

use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};
use std::path::PathBuf;
use tokio::sync::OnceCell;

pub const USDC: u128 = 1_000_000;
pub const DEMO_LEAGUE: &str = "1197787383500648448";
pub const TGAS: u64 = 1_000_000_000_000;

pub fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

static COMMISH_WASM: OnceCell<Vec<u8>> = OnceCell::const_new();
static USDC_WASM: OnceCell<Vec<u8>> = OnceCell::const_new();

pub async fn commish_wasm() -> &'static [u8] {
    COMMISH_WASM
        .get_or_init(|| async { near_workspaces::compile_project(repo().join("contracts/commish").to_str().unwrap()).await.unwrap() })
        .await
}

pub async fn usdc_wasm() -> &'static [u8] {
    USDC_WASM
        .get_or_init(|| async { near_workspaces::compile_project(repo().join("contracts/mock-usdc").to_str().unwrap()).await.unwrap() })
        .await
}

pub fn fixture_wasm(name: &str) -> Vec<u8> {
    std::fs::read(repo().join("fixtures/wasm").join(name)).unwrap()
}

/// The job hash pinned in tests (any 64-hex value: the sandbox operator checks it matches).
pub const JOB_SHA256: &str = "27d04669b9c9017f39ca13a7ae2423db5e17b4746c525c03084253617568efbc";
pub const VAULT_DEPOSIT: u128 = 5_000_000_000_000_000_000_000_000; // 5 NEAR, as on testnet

pub struct Env {
    pub worker: Worker<Sandbox>,
    pub root: Account,
    pub token: Contract,
    pub factory: Contract,
    pub outlayer: Contract,
    pub operator: Account,
    pub commish: Contract,
    pub commissioner: Account,
}

pub fn check(r: &ExecutionFinalResult, what: &str) {
    if !r.is_success() {
        panic!("{what} failed: {:#?}", r.clone().into_result().err());
    }
}

/// The failure message of a transaction that was expected to fail.
pub fn failure_text(r: &ExecutionFinalResult) -> String {
    assert!(r.is_failure(), "expected a failure, got success: {:?}", r.logs());
    format!("{:?}", r.clone().into_result().err().unwrap())
}

impl Env {
    pub async fn new() -> Env {
        let worker = near_workspaces::sandbox().await.unwrap();
        let root = worker.root_account().unwrap();
        let sub = |name: &str, near: u128| {
            let root = root.clone();
            let name = name.to_string();
            async move {
                root.create_subaccount(&name)
                    .initial_balance(NearToken::from_near(near))
                    .transact()
                    .await
                    .unwrap()
                    .into_result()
                    .unwrap()
            }
        };

        // Test USDC
        let token_acct = sub("usdc", 20).await;
        let token = token_acct.deploy(usdc_wasm().await).await.unwrap().into_result().unwrap();
        check(&token.call("new").transact().await.unwrap(), "usdc new");

        // Sputnik factory (testnet bytes)
        let factory_acct = sub("factory", 200).await;
        let factory = factory_acct.deploy(&fixture_wasm("sputnik-factory-testnet.wasm")).await.unwrap().into_result().unwrap();
        check(&factory.call("new").gas(Gas::from_tgas(100)).transact().await.unwrap(), "factory new");

        // OutLayer (testnet bytes), with our operator account as its worker
        let operator = sub("operator", 50).await;
        let outlayer_acct = sub("outlayer", 50).await;
        let outlayer = outlayer_acct.deploy(&fixture_wasm("outlayer-testnet.wasm")).await.unwrap().into_result().unwrap();
        check(
            &outlayer
                .call("new")
                .args_json(json!({ "owner_id": outlayer.id(), "operator_id": operator.id() }))
                .transact()
                .await
                .unwrap(),
            "outlayer new",
        );

        let commissioner = sub("commissioner", 100).await;

        // commish
        let commish_acct = sub("commish", 50).await;
        let commish = commish_acct.deploy(commish_wasm().await).await.unwrap().into_result().unwrap();
        let config = json!({
            "outlayer_id": outlayer.id(),
            "job_wasm_url": format!("https://test.fastfs.io/commishhq.testnet/outlayer.testnet/{JOB_SHA256}.wasm"),
            "job_wasm_sha256": JOB_SHA256,
            "job_build_target": "wasm32-wasip2",
            "core_version": settle_core::CORE_VERSION,
            "sputnik_factory_id": factory.id(),
            "default_token_id": token.id(),
            "vault_name_prefix": "cm-",
            "vault_deposit": VAULT_DEPOSIT.to_string(),
            "token_storage_deposit": "1250000000000000000000",
            "outlayer_deposit": "20000000000000000000000",
            "settle_storage_deposit": "10000000000000000000000",
            "demo_admin": commissioner.id(),
        });
        check(&commish.call("new").args_json(json!({ "config": config })).transact().await.unwrap(), "commish new");
        // commish must be registered with the token to receive dues.
        check(
            &commissioner
                .call(token.id(), "storage_deposit")
                .args_json(json!({ "account_id": commish.id(), "registration_only": true }))
                .deposit(NearToken::from_millinear(10))
                .transact()
                .await
                .unwrap(),
            "register commish",
        );

        Env { worker, root, token, factory, outlayer, operator, commish, commissioner }
    }

    /// A new account with NEAR and `usdc` Test USDC.
    pub async fn member(&self, name: &str, usdc: u128) -> Account {
        let a = self
            .root
            .create_subaccount(name)
            .initial_balance(NearToken::from_near(20))
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap();
        if usdc > 0 {
            check(
                &a.call(self.token.id(), "mint")
                    .args_json(json!({ "account_id": a.id(), "amount": usdc.to_string() }))
                    .deposit(NearToken::from_millinear(10))
                    .transact()
                    .await
                    .unwrap(),
                "mint",
            );
        }
        a
    }

    pub async fn usdc_balance(&self, who: &AccountId) -> u128 {
        let v: String = self.token.view("ft_balance_of").args_json(json!({ "account_id": who })).await.unwrap().json().unwrap();
        v.parse().unwrap()
    }

    pub async fn league(&self, id: u64) -> Value {
        self.commish.view("get_league").args_json(json!({ "league_id": id })).await.unwrap().json().unwrap()
    }

    pub async fn teams(&self, id: u64) -> Vec<Value> {
        self.commish.view("get_teams").args_json(json!({ "league_id": id })).await.unwrap().json().unwrap()
    }

    pub async fn settlement(&self, id: u64, key: Value) -> Value {
        self.commish.view("get_settlement").args_json(json!({ "league_id": id, "key": key })).await.unwrap().json().unwrap()
    }

    /// Creates a league from the demo Sleeper league's rosters (all 12) or a subset.
    pub async fn create_league(&self, rosters: &[u16], rules: Value) -> (u64, AccountId) {
        let mut args = json!({
            "sleeper_league_id": DEMO_LEAGUE,
            "season": "2025",
            "name": "Armchair Football League",
            "rosters": rosters.iter().map(|r| json!({ "roster_id": r, "sleeper_owner_id": null })).collect::<Vec<_>>(),
            "dues": (50 * USDC).to_string(),
            "weekly_amount": (5 * USDC).to_string(),
            "regular_season_weeks": 14,
            "season_split_bps": [6000, 2500, 1500],
            "hold_window_ns": "10000000000",
            "withhold_unpaid": true,
            "is_demo": true,
        });
        for (k, v) in rules.as_object().unwrap() {
            args[k] = v.clone();
        }
        let r = self
            .commissioner
            .call(self.commish.id(), "create_league")
            .args_json(json!({ "args": args }))
            .deposit(NearToken::from_yoctonear(VAULT_DEPOSIT + 1_250_000_000_000_000_000_000 + 50_000_000_000_000_000_000_000))
            .gas(Gas::from_tgas(300))
            .transact()
            .await
            .unwrap();
        check(&r, "create_league");
        let id: u64 = r.json().unwrap();
        let league = self.league(id).await;
        assert_eq!(league["status"], "Active", "league should be active: {league}");
        (id, league["vault"].as_str().unwrap().parse().unwrap())
    }

    pub async fn claim(&self, who: &Account, league: u64, roster: u16) -> ExecutionFinalResult {
        who.call(self.commish.id(), "claim_team")
            .args_json(json!({ "league_id": league, "roster_id": roster }))
            .transact()
            .await
            .unwrap()
    }

    pub async fn approve(&self, by: &Account, league: u64, roster: u16) -> ExecutionFinalResult {
        by.call(self.commish.id(), "approve_claim")
            .args_json(json!({ "league_id": league, "roster_id": roster }))
            .deposit(NearToken::from_yoctonear(1_250_000_000_000_000_000_000))
            .gas(Gas::from_tgas(200))
            .transact()
            .await
            .unwrap()
    }

    pub async fn claim_and_approve(&self, who: &Account, league: u64, roster: u16) {
        check(&self.claim(who, league, roster).await, "claim");
        check(&self.approve(&self.commissioner, league, roster).await, "approve");
    }

    pub async fn pay(&self, who: &Account, league: u64, roster: u16, amount: u128) -> ExecutionFinalResult {
        who.call(self.token.id(), "ft_transfer_call")
            .args_json(json!({
                "receiver_id": self.commish.id(),
                "amount": amount.to_string(),
                "msg": json!({ "league_id": league, "roster_id": roster }).to_string(),
            }))
            .deposit(NearToken::from_yoctonear(1))
            .gas(Gas::from_tgas(150))
            .transact()
            .await
            .unwrap()
    }

    pub async fn vault_policy(&self, vault: &AccountId) -> Value {
        self.worker.view(vault, "get_policy").await.unwrap().json().unwrap()
    }

    pub async fn proposal(&self, vault: &AccountId, id: u64) -> Value {
        self.worker.view(vault, "get_proposal").args_json(json!({ "id": id })).await.unwrap().json().unwrap()
    }

    pub async fn now_ns(&self) -> u64 {
        self.worker.view_block().await.unwrap().timestamp()
    }

    /// Advances sandbox time past `until_ns`.
    pub async fn wait_until(&self, until_ns: u64) {
        for _ in 0..30 {
            if self.now_ns().await > until_ns {
                return;
            }
            self.worker.fast_forward(20).await.unwrap();
        }
        panic!("sandbox time didn't pass {until_ns}");
    }

    /// Runs `settle` and plays the OutLayer worker. `respond` turns the request's input into the
    /// job's stdout; `None` means "use the real job on recorded Sleeper data".
    pub async fn settle_with(
        &self,
        caller: &Account,
        league: u64,
        key: Value,
        respond: Option<&dyn Fn(&str, u64) -> String>,
    ) -> ExecutionFinalResult {
        let status = caller
            .call(self.commish.id(), "settle")
            .args_json(json!({ "league_id": league, "key": key }))
            .deposit(NearToken::from_millinear(30))
            .gas(Gas::from_tgas(300))
            .transact_async()
            .await
            .unwrap();

        // Wait for the request to show up in OutLayer.
        let mut request: Option<(u64, Value)> = None;
        for _ in 0..60 {
            let ids: Vec<u64> = self
                .outlayer
                .view("get_pending_request_ids")
                .args_json(json!({ "from_index": 0, "limit": 50 }))
                .await
                .unwrap()
                .json()
                .unwrap();
            if let Some(id) = ids.last() {
                let req: Value = self.outlayer.view("get_request").args_json(json!({ "request_id": id })).await.unwrap().json().unwrap();
                request = Some((*id, req));
                break;
            }
            if let std::task::Poll::Ready(r) = status.status().await.unwrap() {
                return r; // settle failed before reaching OutLayer
            }
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        }
        let (request_id, req) = request.expect("settle reached OutLayer");
        // The contract must have pinned our job.
        assert_eq!(req["resolved_source"]["WasmUrl"]["hash"], JOB_SHA256, "pinned wasm hash");
        assert_eq!(req["response_format"], "Json");
        let input = req["input_data"].as_str().unwrap().to_string();

        let stdout = match respond {
            Some(f) => f(&input, request_id),
            None => run_real_job(&input, request_id),
        };
        let output: Value = serde_json::from_str(&stdout).unwrap();
        let r = self
            .operator
            .call(self.outlayer.id(), "submit_execution_output_and_resolve")
            .args_json(json!({
                "request_id": request_id,
                "output": { "Json": output },
                "success": true,
                "error": null,
                "resources_used": { "instructions": 15597440u64, "time_ms": 1343u64, "compile_time_ms": null },
                "compilation_note": null,
            }))
            .gas(Gas::from_tgas(300))
            .transact()
            .await
            .unwrap();
        check(&r, "operator resolve");
        // The settle transaction's status can come back before the yield resumes, so wait for
        // the contract's own record to leave Requested/Computed and every payout to have a
        // proposal (or a final status).
        let key_for_view = key.clone();
        for _ in 0..100 {
            let s = self.settlement(league, key_for_view.clone()).await;
            let busy = matches!(s["status"].as_str(), Some("Requested") | Some("Computed"))
                || s["payouts"].as_array().map_or(false, |p| p.iter().any(|x| x["status"] == "Pending"));
            if !busy {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        let out = status.await.unwrap();
        if std::env::var("COMMISH_DEBUG").is_ok() {
            for f in out.receipt_failures() {
                eprintln!("RECEIPT FAILURE: {:?}", f);
            }
            for o in out.receipt_outcomes() {
                eprintln!("receipt {} gas {:.1} Tgas logs {:?}", o.executor_id, o.gas_burnt.as_gas() as f64 / 1e12, o.logs);
            }
        }
        out
    }

    pub async fn settle(&self, caller: &Account, league: u64, key: Value) -> ExecutionFinalResult {
        self.settle_with(caller, league, key, None).await
    }

    pub async fn finalize(&self, caller: &Account, league: u64, key: Value) -> ExecutionFinalResult {
        caller
            .call(self.commish.id(), "finalize")
            .args_json(json!({ "league_id": league, "key": key }))
            .gas(Gas::from_tgas(300))
            .transact()
            .await
            .unwrap()
    }
}

/// Recorded Sleeper responses for the demo league, keyed by URL.
pub fn recorded_sleeper() -> Vec<(String, Value)> {
    let base = format!("https://api.sleeper.app/v1/league/{DEMO_LEAGUE}");
    let dir = repo().join("fixtures/sleeper/armchair-2025");
    let read = |p: &str| -> Value { serde_json::from_str(&std::fs::read_to_string(dir.join(p)).unwrap()).unwrap() };
    let mut v = vec![
        (base.clone(), read("league.json")),
        (format!("{base}/rosters"), read("rosters.json")),
        (format!("{base}/users"), read("users.json")),
        (format!("{base}/winners_bracket"), read("winners_bracket.json")),
    ];
    for w in 1..=17 {
        v.push((format!("{base}/matchups/{w}"), read(&format!("matchups/{w}.json"))));
    }
    v
}

/// What the enclave would print for this input, using the real job code.
pub fn run_real_job(input: &str, request_id: u64) -> String {
    let mut fetch = outlayer_job::MapFetch(recorded_sleeper());
    outlayer_job::run_job(input, &mut fetch, Some(request_id.to_string()))
}

pub fn week(w: u8) -> Value {
    json!({ "Week": w })
}

pub fn season() -> Value {
    json!("Season")
}

pub fn sha256_hex(b: &[u8]) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(b))
}
