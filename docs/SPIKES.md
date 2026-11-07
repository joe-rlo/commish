# Spike results

Day 0 spikes from SPEC.md section 12, run 2026-11-07. Each: what was tried, what happened, links, decision.

Testnet root for everything below: `commishhq.testnet` (new, created through the near-cli faucet service, 10 NEAR).
Explorer links use https://testnet.nearblocks.io.

## S1. Sputnik vault policy

**Question.** Can a contract create a Sputnik vault with the 7.5 policy, add a Transfer proposal, and approve it alone, while a 3-member `league` role can reject it first?

**Found first:**

- `sputnik-v2.testnet` runs an **old** factory, not the repo's main branch. The DAOs it creates report version "2.0.0". Both are ~470 KB wasm; each DAO gets its own copy (about 4.72 NEAR of storage). Main branch uses global contracts; testnet doesn't. Strings in the deployed wasm show 2.0.0 behavior: `act_proposal(id, action, memo)` has no `proposal` argument, `Finalize` only acts on expired proposals (`ERR_PROPOSAL_NOT_EXPIRED`), and there's no `on_proposal_callback`. So **a transfer that fails still leaves the proposal `Approved`.** Consequence for the design: `finalize` re-reads the pot and registers the receiver with the token before it approves, so a transfer can't fail. Extra JSON arguments are ignored by 2.0.0, so we always send `proposal` too, which newer DAOs require.
- A gap in the spec's policy. With plain majority (`threshold: [1, 2]`), a `league` role whose only member is the commissioner reaches its threshold with one vote. Dues can arrive before any claim is approved, so the commissioner could move the pot alone. Fix: every `league` vote policy has `quorum: "2"`. The `settler` role keeps the default policy (quorum 0, one member, one vote approves).

**Sandbox** (near-workspaces 0.23, with the exact `sputnik-v2.testnet` factory and DAO bytes from `fixtures/wasm/`): `cargo test -p commish --test vault --test flow`. 16 tests pass. They cover: the vault is created with the policy; the commissioner alone can't pass a transfer; league votes need a majority and at least 2; the contract (settler) approves alone after the hold; a league majority rejects first and `finalize` marks the payout stopped.

**Testnet:** run with `cli/src/spikes/s1-testnet.ts` on 2026-11-07.

- League 0, vault [`cmsh1-0.sputnik-v2.testnet`](https://testnet.nearblocks.io/address/cmsh1-0.sputnik-v2.testnet), created through the factory: [6NRKXhXV…](https://testnet.nearblocks.io/txns/6NRKXhXV3E1Wr6L2PnL2fFABV9WYxWaHq2S8NpqJACyG). Policy as designed: `settler` = the contract, `league` = commissioner.
- 3 members claimed, were approved (each joined the `league` role), and paid $50. Vault $150, contract $0.
- Week 3 settled through OutLayer and was paid after the 60 s hold. Roster 8 (alice) got $5.00, approved by the contract alone: [finalize 5YppDPNW…](https://testnet.nearblocks.io/txns/5YppDPNWDEuEPmcZQdcjxEPVFJz1dtciZxuEwo9DAWDn).
- Week 1 settled, and 3 of the 4 league members rejected its proposal during the hold: [CcFLqZzL…](https://testnet.nearblocks.io/txns/CcFLqZzLKd47s4dkSwpTW9oMgbCbZGT5HLjD5tk39itG), [NsJGF2cr…](https://testnet.nearblocks.io/txns/NsJGF2crzeUy9VnqCJTiDrEjMKoWRcx4X4QaAFZBqSh), [BkGJVW88…](https://testnet.nearblocks.io/txns/BkGJVW88QMosRKjdeo31ebYBdA5fWPnnprTp9ms7FcLz). `finalize` marked it Stopped: [DRK2gARH…](https://testnet.nearblocks.io/txns/DRK2gARHTWSGPx3isoHK3huoaYSMBhhTdCajrVLqudsW). The pot kept the $5 ($145).

**Decision.** **Pass.** Use the Sputnik vault as specified, plus `quorum: 2` on `league` votes. Vault deposit: 5.3 NEAR (4.72 locked plus room for ~50 proposals). No escrow fallback needed.

## S2. OutLayer job with Sleeper fetch

**Question.** Can an OutLayer job make an outbound HTTPS GET to `api.sleeper.app`? Can our contract request it and get the result back (yield/resume)? What does it cost, and what does the attestation look like?

**What I read** (source, not just docs), github.com/out-layer/outlayer at `8d27679` (2026-11-07):

- `contract/src/execution.rs`: `request_execution(source, resource_limits, input_data, secrets_ref, response_format, payer_account_id, params)`. It creates a yield and resumes into `on_execution_response`. That function `value_return`s the job's stdout: raw JSON for `response_format: "Json"`, or the literal `null` on failure. Some docs describe a `{success, result, error}` wrapper; the deployed contract doesn't use one. Outputs over 1024 bytes go through `submit_execution_output_and_resolve` and still come back the same way.
- `contract/src/lib.rs`: `ExecutionSource::{GitHub, WasmUrl{url, hash, build_target}, Project}`. GitHub builds are off by default on the coordinator, so we use `WasmUrl`. The worker refuses to run bytes whose SHA-256 isn't `hash`.
- `worker/src/connector_manifest.rs`: a wasm custom section `outlayer.manifest` with `capabilities.network` is an enforced outbound allowlist. The section is covered by the wasm hash. Our job embeds `{"capabilities":{"network":["api.sleeper.app"]}}`.
- Attestations are public: `GET https://testnet-api.outlayer.ai/attestations/by-request/{request_id}` returns `wasm_hash`, `executed_wasm_sha256`, `input_hash`, `output_hash`, `worker_measurement` and the TDX quote. The job reads `NEAR_REQUEST_ID` from its environment and puts it in its output, so a receipt can link straight to its attestation.
- Testnet pricing (`get_pricing` on `outlayer.testnet`): base fee 0.001 NEAR, 1e14 yocto per million instructions, 1e17 yocto per ms.

**What I ran.**

1. Built `crates/outlayer-job` for `wasm32-wasip2` (661 KB, SHA-256 `27d04669b9c9017f39ca13a7ae2423db5e17b4746c525c03084253617568efbc`). Uploaded it to FastFS with one `__fastdata_fastfs` call: tx [38RD1YAS…](https://testnet.nearblocks.io/txns/38RD1YASg6qNBP1xnbfuAodhpnm9ThMPeWtNpgdTvVvA). FastFS serves it at https://test.fastfs.io/commishhq.testnet/outlayer.testnet/27d04669b9c9017f39ca13a7ae2423db5e17b4746c525c03084253617568efbc.wasm, with matching hash.
2. Called `outlayer.testnet.request_execution` from `commishhq.testnet` for week 3 of the demo league: tx [Edqdwgd6…](https://testnet.nearblocks.io/txns/Edqdwgd69mzzAeAwVk28pXkjYupu73b4mhqSWbY7Z8sW).

**What happened.** **Pass** for the outbound fetch and the result format.

- The enclave fetched three Sleeper URLs and returned the settlement. Roster 8 won week 3 with 166.44. The data hash `ab52bb89…` matches the hash computed in JavaScript from the recorded fixtures.
- 11.2 s from send to final result. 15.6 M instructions, 1.34 s run time. Charged 0.0012 NEAR; the rest of the 0.05 NEAR attached was refunded.
- Attestation for request 12264: `executed_wasm_sha256` = our pinned hash. `output_hash` `2b2e0cfd…` = SHA-256 of the exact bytes the callback receives. This holds because the job prints RFC 8785 canonical JSON with only integers and strings, which serde_json re-serializes unchanged. So the hash the contract stores equals the attested output hash.

**S2b: contract round trip.** `commish.commishhq.testnet.settle` → `outlayer.testnet.request_execution` (pinned `WasmUrl` + SHA-256) → yield … resume → our callbacks → vault proposal. Week 3: [5NkP6Wev…](https://testnet.nearblocks.io/txns/5NkP6WevkPBxUHd4kbVmWA4EauPfP4DwHdYE5J6w7DEc). The result was on chain 13.0 s after sending. What the contract stored matches [attestation 12278](https://testnet-api.outlayer.ai/attestations/by-request/12278) exactly:

| | Contract (`get_settlement`) | OutLayer attestation |
| --- | --- | --- |
| input | `input_sha256` 565a1b57… | `input_hash` 565a1b57… |
| output | `result_sha256` e3965d0f… | `output_hash` e3965d0f… |
| code | pinned `job_wasm_sha256` 27d04669… | `executed_wasm_sha256` 27d04669… |

Gotcha: NEAR's RPC reports the `settle` transaction final before the yield resumes. Clients wait on the contract's own record (`get_settlement`), not on the transaction status.

**Decision.** Use OutLayer with `WasmUrl` on FastFS. The contract pins the wasm SHA-256 and passes it as `hash`. It stores `sha256(callback bytes)` and the OutLayer request id from the output. The receipt links `/attestations/by-request/{id}`. No keeper fallback needed so far.

## S3. Sleeper fields

**League used:** "Armchair Football League", `1197787383500648448`, season 2025, 12 teams, status `complete`, 1.0 PPR, league avatar set. Found by walking public users' 2025 leagues (Sleeper's own `sleeper` account → a 12-team league → its members' leagues). Team names are clean for a demo. Recorded to `fixtures/sleeper/armchair-2025/`.

| Field | Spec assumption | Found |
| --- | --- | --- |
| `settings.playoff_week_start` | exists | `15`, so the regular season is weeks 1–14 |
| `status` | `complete` when done | `complete`. Sleeper docs list `pre_draft`, `drafting`, `in_season`, `complete` |
| `matchups[].custom_points` | present, nullable | present on every entry, `null` here |
| `winners_bracket[].p` | `p == 1` final, `p == 3` third | present: `p=1` (w 8, l 2), `p=3` (w 1), `p=5` (5th place) |
| `/state/nfl` week vs leg | one of them | both present and equal in season (`week: 9, leg: 9` today). Sleeper's docs: `leg` = "week of regular season". Also `season_type` and `season_start_date` |
| unknown league | — | HTTP 404 with body `null` |
| CORS | browser fetch allowed | `access-control-allow-origin: *` |

**Two things the spec didn't anticipate:**

1. **Float formatting.** Sleeper writes `9.0` and `0.0`. Rust's serde_json writes them back as `9.0`; JavaScript writes `9`. A plain "sorted keys, no whitespace" hash would differ between the enclave and the browser. settle-core implements RFC 8785 (JCS) with ECMAScript number formatting, using Ryū digits. Rust's built-in `{:e}` isn't always the closest shortest form: it fails RFC 8785 vector `0x43143ff3c1cb0959`. Checked against Node on 299,938 random doubles: 0 mismatches.
2. **Points rounding.** `round(points × 100)` in binary floating point turns 162.385 into 16238. settle-core rounds the decimal value half away from zero (16239). Real Sleeper points have two decimals, so both agree on real data.

**Decision (finality, SPEC 6.2):** current week = `leg`, falling back to `week`. `season_type == "post"` counts as past every regular week. "The Tuesday after week W" = the first Tuesday strictly after `season_start_date`, plus 7·(W−1) days. Final at that Tuesday 00:00 UTC + 36 h. Implemented in `crates/settle-core/src/finality.rs` with tests.

## S4. Token

**Ran:** deployed `contracts/mock-usdc` ("Test USDC", symbol tUSDC, 6 decimals, public `mint` capped at 500 per account per UTC day) to [`usdc.commishhq.testnet`](https://testnet.nearblocks.io/address/usdc.commishhq.testnet): [83u9Apy4…](https://testnet.nearblocks.io/txns/83u9Apy4FggQsk8r2bKfrYoEvMRFnPYeQHTmyqDA7crM). Minted to three accounts, and each paid dues with `ft_transfer_call` to the commish contract: [DZ1vBSSq…](https://testnet.nearblocks.io/txns/DZ1vBSSqHTCbWa1CrbR37PLXkCXt5YN5kG2aT8A9FVwD), [FLhGYDfp…](https://testnet.nearblocks.io/txns/FLhGYDfpwBznaabfQ2LbHh1CnpEeK9AMq2DWrUtCFXSH), [2pYAqvaf…](https://testnet.nearblocks.io/txns/2pYAqvafgvAtQbKbxv5YbrB1pbXm9hW6jVDQpLnU2iKY). All three were forwarded to the vault in the same call chain.

Circle testnet USDC: not tried. The spec calls it a nice-to-have, and depending on an outside faucet adds risk to the demo.

**Decision.** **Pass.** Test USDC only (expected outcome).

**Cost note:** 300 Tgas of prepaid gas reserves about 0.3 NEAR on testnet (pessimistic gas price), even though it burns far less. An account with 0.3 NEAR can't send `finalize`. Quick accounts get 0.5 NEAR, as specced.

## S5. Wallet and quick accounts

_Filled in below._
