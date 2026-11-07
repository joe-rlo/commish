# Commish

The commissioner can't touch the money.

Commish holds a fantasy league's dues in the league's own vault on NEAR (a Sputnik DAO) and pays winners automatically from the league's Sleeper results. The payout math runs inside an attested OutLayer enclave, and anyone can recheck it, in the browser or from the command line.

> NEAR HACKATHON entry (Nov 1–14, 2026). Tracks: Social Money (`social`), Real-World Money (`realworld`). **NEAR testnet only, test money only.** This is a demo, not a real-money product: paid fantasy is regulated differently by state and country. "Commish" is a working name.

## The problem

About 57 million adults in the US and Canada play fantasy sports ([FSGA, 2025](https://thefsga.org/new-fsga-research-highlights-industry-stability-and-next-generation-growth-in-fantasy-sports-and-sports-betting)). In leagues among friends, the commissioner usually holds everyone's dues in a personal account for months and does the payout math by hand. [LeagueSafe](https://www.leaguesafe.com/blog/what-if-commissioner-takes-the-money) built a business on the fear that the commissioner takes the money.

## Try it in 2 minutes

**Hosted demo:** not deployed yet (the deploy waits for the owner's go-ahead). Until then, run the web app locally (below); the demo league and every receipt are live on testnet either way.

1. Open `/demo`. You see the Armchair Football League (a real, completed 2025 Sleeper league): 12 teams, 12 of 12 paid, the pot as a scoreboard, and a payouts feed of receipts.
2. Press **Settle week 3** (any open week works). Sign in with a quick account: type a name, press Create. No seed phrase; the key stays in your browser. A "Week 3 high score" receipt appears with a spinner while the enclave works, then **On hold 0:59**.
3. Wait. When the countdown ends the page releases the payout and the stamp flips to **Paid**. The winner's balance rises by $5.00 (open the receipt: the account is listed and linked).
4. Open the receipt and press **Check the math**. You see **Matches ✓**.

This exact flow runs headless against testnet in about 85 seconds: `node web/scripts/judge-flow.mjs http://localhost:5173 3` (needs the dev server and a local Worker, below).

## Run it locally

Prerequisites: Node 22+, pnpm 10, Rust stable with `wasm32-unknown-unknown` and `wasm32-wasip2` (`rust-toolchain.toml` installs them), and cargo-near for contract builds.

```sh
pnpm i
cargo test         # 64 Rust tests (~2 min; the contract tests start a local NEAR sandbox)
pnpm test          # 69 TypeScript tests
```

Recompute any week from public data, natively, with no keys:

```sh
pnpm commish verify --sleeper 1197787383500648448 --week 3
```

Expected (first lines):

```
Week 3 high score · sleeper:1197787383500648448 · season 2025
   1. Julia Rob Hurts              roster  8    166.44  ← $5.00
   2. cbreen                       roster  5    159.22
   3. Shayshawn Sparkley           roster  1    137.12
```

Check a real testnet settlement against the chain and OutLayer's attestation:

```sh
pnpm commish verify --settlement 0:w3
```

Expected (last lines):

```
On chain: commish-v2.commishhq.testnet league 0 {"Week":3}
  ✓ input sha256 393f09b10f4ee2defda56df9046b898bd9cb233fb6729b399fb07e21e321ee7e
  ✓ result sha256 ff07c273e49147ae35bae037550cb5de846ef7522024d7812be6171d7558590f (recomputed here: identical bytes)
  ✓ source sha256 ab52bb89a4f3fa20e27f929aa67ca3980d858c5087828307d0c84a35ad633abf
OutLayer attestation:
  code   ✓ executed_wasm_sha256 = pinned 71854dd1ea0d6eda4bfe2b09dce602eca10ffc2315064acc95208cc2bb0831ea
  input  ✓ input_hash = contract's input_sha256
  output ✓ output_hash = contract's result_sha256
  ...
Matches ✓
```

Rebuild the enclave job and check it's the exact binary the contract pins:

```sh
./scripts/build-job.sh
```

Expected last line: `71854dd1ea0d6eda4bfe2b09dce602eca10ffc2315064acc95208cc2bb0831ea`, the same as `job_wasm_sha256` in the contract's `get_config` and `executed_wasm_sha256` in every attestation. The build is reproducible: the toolchain is pinned (`rust-toolchain.toml`, rustc 1.98.1) and machine paths are remapped out of the binary.

Run the web app against the testnet deployment:

```sh
pnpm --filter @commish/web dev          # http://localhost:5173
```

Reading leagues, receipts and **Check the math** need nothing else. Signing (settle, join, pay) works with **Use a NEAR wallet** on testnet. Quick accounts and the Test USDC faucet need the Worker, which signs with the demo root key: `cd worker && cp .dev.vars.example .dev.vars` (fill in a testnet key you own), `pnpm exec wrangler dev`, and set `VITE_WORKER_URL=http://127.0.0.1:8787` in `web/.env.local`.

`pnpm e2e` runs the whole thing on testnet with the root key: create a league from the demo Sleeper league, seed 12 paid accounts, settle week 1 through OutLayer, check finalize fails during the hold, finalize after it, assert the winner got $5, and run `verify --settlement`. It passes in about 5 minutes and spends about 7.5 testnet NEAR.

## How the money moves

```
 members ──USDC (or any token via NEAR Intents, preview)──► commish contract ──same call──► league vault (Sputnik DAO)
                                                                                               │
 Sleeper (public scores) ──► OutLayer enclave (Intel TDX) ──result + attestation──► contract   │
                                  runs the pinned settle-core build                  │         │
                                                                                     ▼         │
                                                     one vault Transfer proposal per payout ◄──┘
                                                     hold window: a league majority can stop it
                                                     then the contract (vault "settler") approves ──► winner
```

1. **Dues.** A member calls `ft_transfer_call` on the token with `msg = {"league_id":7,"roster_id":3}`. The contract credits the team (not the payer), keeps nothing, forwards up to the dues amount to the vault in the same call chain, and returns the rest. If the forward fails, the whole payment goes back.
2. **Settle.** Anyone calls `settle` once a week's scores are final. The contract asks OutLayer to run the job pinned by its SHA-256. The job fetches Sleeper (its embedded manifest allows only `api.sleeper.app`), runs settle-core, and prints canonical JSON. NEAR's yield/resume brings the result back. The contract checks it (league, season, week, rules version, rosters, amounts), reads the pot, applies withholding, and creates one vault `Transfer` proposal per payout.
3. **Hold.** For the hold window (24 h by default, 60 s in demo leagues) a majority of the league's teams (7 in a 12-team league) can reject the proposal in the vault.
4. **Finalize.** After the window, anyone calls `finalize`. Proposals the league rejected are marked Stopped; the money stays. The rest the contract approves as the vault's `settler`, after re-reading the pot and registering the winner with the token, so the transfer can't fail.

### What you trust

| You trust | For | How it's checked |
| --- | --- | --- |
| Sleeper's API | The scores | Public; anyone can fetch the same URLs. Receipts list them with the SHA-256 of their data |
| OutLayer and Intel TDX | Running the pinned settle-core build honestly | Attestation per run (code, input and output hashes, TDX quote); the contract requests only the pinned wasm hash |
| The commish contract | Only paying what the rules compute | Open source, 22 sandbox tests against the real Sputnik and OutLayer contract bytes, invariants below |
| Your league's majority | Overrides | The vault policy; visible to everyone with `get_policy` on the vault |

Not trusted: the commissioner, the Commish team, the web app, the Worker. The web app could lie about scores; that's why "Check the math" and `commish verify` exist.

### The proof chain

For every settlement, the contract stores `input_sha256` (SHA-256 of what it sent the enclave), `result_sha256` (SHA-256 of what came back) and the OutLayer request id. The attestation at `https://testnet-api.outlayer.ai/attestations/by-request/<id>` has the same `input_hash` and `output_hash`, and an `executed_wasm_sha256` equal to the contract's pinned `job_wasm_sha256`. The job prints [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) canonical JSON, so settle-core compiled natively (CLI), to WASI (enclave) and to wasm (browser) produce identical bytes. The fixture suite checks the browser build against a real testnet result byte for byte.

## Rules (settle-core, `crates/settle-core`)

- A week is final when the Sleeper league is `complete`, or when the NFL has moved past it and 36 hours have passed since the Tuesday after it (stat corrections).
- Points: `custom_points` if set, else `points`, converted to integer hundredths. A roster missing from the week scores 0 and can't win.
- Weekly high score: highest points wins; ties split evenly, rounded down; dust stays in the pot. Only regular-season weeks pay.
- Season: 1st and 2nd from the bracket's `p = 1` game, 3rd from `p = 3`. Amounts come from the pot at settlement (minus payouts on hold); a place with no result adds its share to 1st. The season settles after every weekly prize has (so a late season payout can't eat a week's prize).
- Withheld (money stays in the pot): no approved account, dues unpaid (if the league withholds), or the pot is too small.

## On NEAR testnet

| What | Where |
| --- | --- |
| Commish contract | [`commish-v2.commishhq.testnet`](https://testnet.nearblocks.io/address/commish-v2.commishhq.testnet) (the Day-0 spikes ran on [`commish.commishhq.testnet`](https://testnet.nearblocks.io/address/commish.commishhq.testnet); v2 adds the security-review fixes and the reproducible job) |
| Test USDC (NEP-141, 6 decimals, mint capped at 500/account/day) | [`usdc.commishhq.testnet`](https://testnet.nearblocks.io/address/usdc.commishhq.testnet) |
| Vaults (one Sputnik DAO per league) | `cmsh2-<league id>-<random>.sputnik-v2.testnet`, created by the official factory `sputnik-v2.testnet` |
| Settlement job | `https://test.fastfs.io/commishhq.testnet/outlayer.testnet/71854dd1ea0d6eda4bfe2b09dce602eca10ffc2315064acc95208cc2bb0831ea.wasm`, run by `outlayer.testnet` |
| Demo league | the newest demo league (`latest_demo_league` view); `/demo` opens it |

Evidence from the Day-0 spikes, with transaction links: [docs/SPIKES.md](docs/SPIKES.md).

### Contract methods

| Method | Who | What it does |
| --- | --- | --- |
| `create_league(args)` | anyone (becomes commissioner); attach `vault_deposit + token_storage_deposit + 0.05 NEAR` | Creates the vault through the Sputnik factory with the settler/league policy, registers it with the token, stores the league |
| `claim_team(league_id, roster_id)` | any account (one team per account) | Marks the claim pending |
| `approve_claim(league_id, roster_id, account)` | commissioner; attach 0.00125 NEAR | Approves that account's claim (refuses if a different account's claim is pending), adds it to the vault's `league` role, registers it with the token |
| `decline_claim(league_id, roster_id)` | commissioner | Returns a pending claim to unclaimed |
| `update_rules(league_id, update)` | commissioner, before the first payment | Changes dues, weekly amount, split, hold window, withholding |
| `ft_on_transfer(sender_id, amount, msg)` | the league's token only | Takes a payment that covers what the team owes, forwards the dues to the vault, returns any excess (a smaller payment is returned whole). The first payment locks the rules |
| `settle(league_id, key)` | anyone; attach 0.03 NEAR, 300 Tgas | Requests the pinned OutLayer job; on resume records the result and proposes payouts |
| `finalize(league_id, key)` | anyone, after the hold window | Approves up to 3 payouts still in progress per call; marks rejected ones Stopped |
| `reassign_team(league_id, roster_id, account)` | the league's vault only (a league vote); attach 0.00125 NEAR | Moves a team to another account and updates the vault's `league` role |
| views | anyone | `get_config`, `get_league`, `list_leagues`, `league_count`, `latest_demo_league`, `get_teams`, `get_settlements`, `get_settlement`, `job_input` |

`key` is `{"Week": 9}` or `"Season"`. There are no admin methods; the pinned job and deploy-time config can't change.

**Invariants, each tested** (`contracts/commish/tests/`): the contract holds no league tokens once `ft_on_transfer` resolves; a key settles once; payouts go only to approved accounts of winning rosters, within the rules and the pot; rules can't change after the first payment; the commissioner has no method that moves money, and can't pass a vault transfer alone or with one account they control (league votes need a majority of the league's teams); `finalize` before the hold window ends fails.

## NEAR features used

- **Sputnik DAO**: each league's vault, created by the official testnet factory, with a two-role policy (`settler` = the contract, `league` = commissioner + approved teams; votes need a majority of the league's teams).
- **OutLayer**: the settlement runs in an Intel TDX enclave via `request_execution` and NEAR yield/resume, pinned by wasm SHA-256, with a public attestation per run.
- **NEAR Intents 1Click**: "pay with another token" shows a real mainnet dry-run quote (`dry: true`). Preview only; never executed.
- **NEP-141** (Test USDC), **NEP-145** storage, **NEP-297** events, named accounts and sub-accounts (`<name>.commishhq.testnet` quick accounts).

## Tests

| Command | What |
| --- | --- |
| `cargo test -p settle-core` | 35 tests: RFC 8785 numbers (incl. RFC Appendix B vectors), points rounding, finality, and 27 fixture cases built in JavaScript (ties, dust, custom_points, missing roster, past the regular season, not final, bracket with and without a 3rd-place game) |
| `cargo test -p commish` | 22 sandbox tests with the exact `sputnik-v2.testnet` and `outlayer.testnet` bytes; the test plays OutLayer's worker with the real job on recorded Sleeper data |
| `pnpm test` | settle-core in wasm on every fixture plus a real testnet result byte for byte; Worker rules; UI state logic |
| `pnpm e2e` | the full flow on testnet (above) |
| `node web/scripts/judge-flow.mjs`, `join-flow.mjs`, `create-flow.mjs`, `hold-flow.mjs` | the README flows in headless Chromium against testnet, including a member holding a payout and the wallet selector |

## Known limits

- Sleeper can apply stat corrections after a week settles. The 36-hour wait and the hold window reduce this but don't eliminate it.
- Team claims rely on the commissioner's approval. Sleeper's API can't prove who owns a team. Vault votes need a majority of the league's teams, so a commissioner would have to get accounts they control approved for most of the teams to move money; every claim and its account is on the league page.
- A season settling within a block or two of another payout being finalized can read a slightly stale pot; the last place's payout is then withheld as "pot too small" rather than overpaid.
- A league majority can move the vault's money. That's a feature, and it's disclosed.
- OutLayer is a third-party platform. Its guarantees are only as good as its attestation flow. OutLayer's own governance keys are described in its [NON_CUSTODIAL.md](https://github.com/out-layer/outlayer/blob/main/docs/NON_CUSTODIAL.md).
- The testnet Sputnik factory runs an old DAO version that marks a proposal Approved even if its transfer fails; `finalize` re-checks the pot and registers the receiver first so the transfer can't fail.
- The contract account still has its deploy key (testnet demo); a production deploy would remove it.

## Repo layout

```
crates/settle-core/     payout rules: Sleeper JSON + rules → result. Pure, no I/O
crates/outlayer-job/    WASI job for the enclave (and native, for the CLI)
crates/commish-verify/  `pnpm commish verify`: native recompute + on-chain + attestation checks
crates/settle-wasm/     settle-core for the browser (no imports)
contracts/commish/      the contract (near-sdk 5.29) and its sandbox tests
contracts/mock-usdc/    Test USDC
shared/                 TypeScript used by web, CLI and Worker (settle-core loader, Check the math, seeding)
web/                    Vite + React app
worker/                 Cloudflare Worker: quick accounts, faucet, 1Click quotes, demo reset
cli/                    `pnpm commish …` and `pnpm e2e`
fixtures/               recorded Sleeper data, fixture cases, deployed contract bytes, a testnet result
docs/                   SPIKES.md (evidence), DECISIONS.md (one line per decision)
```

## Built with

near-sdk-rs, near-contract-standards, near-workspaces, near-api-js, @hot-labs/near-connect, serde_json, ryu, sha2, ureq, wasi-http-client, Vite, React, TanStack Query, Tailwind, Cloudflare Workers, Playwright. Fonts: Big Shoulders Display, Atkinson Hyperlegible, Martian Mono. Code written with Claude Code during the hackathon window.

## Built at NEAR HACKATHON

https://nearhackathon.com, November 2026. Tracks: Social Money, Real-World Money. MIT licensed (see [LICENSE](LICENSE)).
