# Spike results

Day 0 spikes from SPEC.md section 12, run 2026-11-07. Each: what was tried, what happened, links, decision.

Testnet root for everything below: `commishhq.testnet` (new, created through the near-cli faucet service, 10 NEAR).
Explorer links use https://testnet.nearblocks.io.

## S1. Sputnik vault policy

_See below (filled in after the sandbox and testnet runs)._

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

**Contract round-trip (yield/resume through our own contract):** _see "S2b" below, after the contract exists._

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

_Filled in below._

## S5. Wallet and quick accounts

_Filled in below._
