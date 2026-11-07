# Commish: build spec

Version 1.0 · Nov 7, 2026 · Owner: Joe Spano · Builder: Claude Code

Commish holds a fantasy league's dues where nobody, the commissioner included, can take them, and pays winners automatically from the league's own Sleeper results.

This is an entry for NEAR HACKATHON. Development ends **2026-11-14T23:59Z**. We submit on **Nov 13**. Everything in this spec serves one goal: a judge opens the demo, watches a real fantasy week pay out on NEAR testnet, and checks the math themselves.

"Commish" is a working name.

---

## 1. Read this first

- **Section 12 lists spikes that must run before any feature work.** Four of the design's assumptions are unverified. Run the spikes, report results to Joe, and wait for his OK before building on them.
- **Never guess an address, method name or SDK version.** Look it up in https://docs.near.org/llms.txt, https://docs.near-intents.org/llms.txt, the Sputnik DAO repo, or the OutLayer docs. Where this spec names one, it says whether it's verified.
- **Install the NEAR agent skills** before starting: `npx skills add near/agent-skills`.
- **Read the live rules** at https://nearhackathon.com/HACKATHON.md before submitting. They change.

---

## 2. The problem

About 57 million adults in the US and Canada play fantasy sports (FSGA, 2025). Leagues among friends usually play for money, and the commissioner usually holds it, in a personal Venmo or bank account. LeagueSafe has run a business since 2008 on one fear: "Commissioner theft happens more than anyone wants to admit."

Even honest commissioners hate the job. They chase dues through August, hold everyone's money for five months, and do the payout math by hand in January.

Commish fixes both:

1. **The money sits in the league's own vault** (a Sputnik DAO), not with a person or a company. No single person can withdraw it.
2. **Payouts compute themselves** from the league's public Sleeper results, inside an attested enclave (OutLayer). Anyone can recheck the math.
3. **Members pay in whatever they hold.** NEAR Intents converts it to USDC.

### Who it's for

| Person | What they want | What Commish gives them |
| --- | --- | --- |
| Commissioner | Stop chasing dues, stop holding $600 of friends' money, stop doing payout math | One setup, one invite link, then nothing to do |
| League member | Proof the pot exists; get paid without asking | A live pot balance and automatic payouts with receipts |
| Judge | A clear, novel, working demo that uses NEAR well | A real week paying out on testnet, plus a "check the math" button |

---

## 3. Product principles

1. **No crypto words on the main path.** Say "pot", "dues", "payout", "vault", "receipt". Never "DAO", "proposal", "yoctoNEAR" or "gas" outside the details drawer. Every on-chain fact stays one tap away under **Details**.
2. **Mobile first.** Invite links get opened from group chats on phones. Design at 375px wide first.
3. **Trust is shown, not claimed.** Every payout has a receipt with the scores it came from, the data hash, the enclave attestation and the transaction. "Check the math" recomputes it in the browser from live Sleeper data.
4. **Nothing to do after setup.** The happy path never needs the commissioner again.
5. **Fun, but not a casino.** It should feel like a scoreboard in your group chat. No slot-machine visuals, no "bet" language.

---

## 4. Scope

### In v1 (must ship)

- Create a league from a Sleeper league link: preview, rules, vault creation, invite link
- Join: pick your team, sign in without a seed phrase, pay dues
- League page: pot balance, dues progress, payout feed with receipts
- Weekly high-score payouts, settled from Sleeper by an attested enclave job
- A hold window, during which a majority of the league can stop any payout
- Season-end payouts from the playoff bracket
- "Check the math": browser recompute from live Sleeper data
- A seeded demo league that judges can settle in under 2 minutes
- A CLI that verifies any settlement from public data

### Preview only (show it, don't execute it)

- Paying dues from another chain or token through NEAR Intents 1Click. Show a real mainnet dry-run quote ("You'd send 0.71 SOL"). Testnet demo payments use USDC on NEAR.

### Out of v1

- Mainnet and real money. Testnet only, see section 13.
- Yahoo, ESPN or other platforms. Sleeper only. Yahoo is a stretch goal after submission is safe.
- Side bets between two members, survivor pools, keeper fees
- Telegram or Discord bots (a "Share to group chat" text button is in v1)
- Yield on the idle pot
- Payouts to other chains

---

## 5. User flows and screens

All amounts display as dollars with two decimals. All times display in the viewer's local time.

### 5.1 Landing `/`

- Headline: **The commissioner can't touch the money.**
- Subhead: Commish holds your league's dues and pays winners automatically from your Sleeper results.
- Two buttons: **Start a league** → `/new`. **See a demo league** → `/demo`.
- Below the fold: three short steps with icons (Pay in → Play → Get paid automatically) and a "How it works" link to `/how`.

### 5.2 Create a league `/new`

**Step 1. Find your league**

- One input: "Paste your Sleeper league link or ID". Accept `https://sleeper.com/leagues/<id>/...`, `https://sleeper.app/leagues/<id>`, or a bare ID.
- On submit, fetch `/league/<id>`, `/league/<id>/users` and `/league/<id>/rosters` from the Sleeper API, client side.
- Show a preview card: league avatar, name, season, team count, and a grid of team avatars with team names (`metadata.team_name`, falling back to `display_name`).
- Errors, each in plain words with a retry: league not found; not an NFL league; league has fewer than 2 rosters; the season is already complete (allowed only in demo mode); Sleeper unreachable.

**Step 2. Set the rules**

| Field | Default | Validation |
| --- | --- | --- |
| Dues per team | $50 | $1 to $10,000 |
| Weekly high score payout | On, $5 | 0 or more; total weekly payouts must fit in the pot |
| Season split | 60 / 25 / 15 | Presets: Winner takes all · 70/30 · 60/25/15 · Custom (1 to 3 places, must sum to 100) |
| Hold window | 24 hours | 1 to 72 hours. Demo leagues: 60 seconds |
| Withhold winnings until dues are paid | On | — |

- A live summary computed from the inputs: "12 teams × $50 = $600 pot · $70 in weekly payouts ($5 × 14 regular-season weeks) · $530 split 60/25/15 at season's end."
- The number of regular-season weeks comes from the league's settings (`playoff_week_start - 1`). Spike S3 confirms the field name.
- Copy under the form: "Rules lock once the first team pays."

**Step 3. Create**

- Sign in (section 5.7) if needed. The commissioner signs one transaction.
- Progress list with live checkmarks: "Creating your league's vault" → "Setting up USDC" → "Done". Each step links to its transaction under Details.
- Then show the invite screen: the link `/join/<leagueId>`, a **Copy** button, and a **Share** button using `navigator.share` with this text: "Dues for <league name> are on Commish. Pick your team and pay here: <link>. The money sits in a league vault. Nobody, not even me, can take it."

### 5.3 Join `/join/:leagueId`

1. League header (avatar, name, season) and "Dues: $50 · Pot so far: $350 · 7 of 12 paid".
2. **Which team is yours?** A grid of teams. Claimed teams are greyed out with "Claimed".
3. Sign in (section 5.7).
4. The claim goes to the commissioner for approval. Show "Waiting for <commissioner name> to confirm your team" with live status. Members can pay before approval; the payment is linked to the team either way.
5. **Pay $50 dues.**
   - **USDC on NEAR** (testnet: one tap). If the balance is short, show a **Get test USDC** button that calls the faucet (section 9.4).
   - **Another token or chain**: opens the 1Click preview. Pick a token, and see a live mainnet dry-run quote: "You'd send ≈0.71 SOL to a one-time deposit address. Your league receives $50.00 USDC." Label it clearly: "Preview: real mainnet quote, not executed in this demo."
6. Success state: "You're in. 8 of 12 paid." with the pot balance and a link to the league page.

### 5.4 League page `/l/:leagueId`

From top to bottom:

1. **Header**: league avatar, name, season, and a "Commissioner" badge next to the commissioner's name.
2. **Pot card**: the big balance (the vault's live USDC balance), with "Held in your league's vault. Nobody can withdraw it alone." A **Details** drawer shows the vault account, its policy in plain words, and an explorer link.
3. **Dues**: a row of team avatars with a check on paid teams, and "9 of 12 paid · $450".
4. **Payouts feed**: newest first. Each item is a receipt card:
   - "Week 9 high score · The Waiver Wire Bandits · 162.38 pts · $5.00"
   - Status chip:
     - **On hold for 18h 22m**: countdown, plus a **Hold this payout** button for league members
     - **Paid**: with the receipt link
     - **Stopped by the league**: when a majority voted to hold it
     - **Withheld: dues unpaid**: the money stays in the pot
   - Tap → the receipt page (5.5).
5. **Next up**: "Week 10 settles once its scores are final" with a **Settle week 10** button. It's enabled when the week is final; anyone can press it.
6. **Season payout**: before the season ends, show the projected split by current standings, labeled "Projected". After the final, it shows real receipts.
7. **Commissioner panel**, visible only to the commissioner: pending team claims with Approve / Decline, and the invite link.

Empty states:

- No payouts yet: "No payouts yet. Week 1's high score settles after its scores are final."
- Nobody has paid: "Nobody has paid yet. Share the invite link to get started."

### 5.5 Receipt `/l/:leagueId/r/:settlementId`

- Title: "Week 9 high score".
- The full scoreboard for that week: every team's points, sorted, with the winner highlighted. Ties are noted and split.
- The payout line(s): team → account → amount → status.
- **Proof** section:
  - "Computed in a verified enclave": OutLayer attestation summary (code hash, input hash, output hash) and a link to it
  - Source: the exact Sleeper API URLs used and the SHA-256 of the response data
  - The vault payout and its transaction
- **Check the math** button: runs `settle-core` in the browser (section 7.2) against live Sleeper data, then shows "Matches ✓" or a diff of what changed (Sleeper sometimes applies stat corrections).
- **Share** button: "Week 9 high score: The Waiver Wire Bandits, 162.38. $5 paid automatically by Commish. Receipt: <link>"

### 5.6 How it works `/how`

One plain page: where the money sits, what the enclave does, what the hold window is for, and what the league can vote on. Include one diagram: members → Intents → vault; Sleeper → enclave → payout → vault → winner.

### 5.7 Sign-in

Two paths behind one **Sign in** button:

- **Quick account (testnet only)**: the user types a name. The Worker (section 9.4) creates `<name>.<demo-root>.testnet`, funds it with a small amount of NEAR, and returns it. The full-access key stays in the browser's local storage, with an **Export key** option in settings. A visible "Testnet" badge sits in the header. This is the no-seed-phrase path for the demo.
- **Use a NEAR wallet**: the wallet connector the near-dapp agent skill recommends.

> Constraint: paying dues needs a full-access key or a wallet. NEP-141 transfers require a 1 yoctoNEAR deposit, and function-call access keys cannot attach a deposit. Don't design a flow that pays dues with a function-call key.

### 5.8 Demo `/demo`

- Opens a seeded demo league built from a **completed** public Sleeper season (Joe supplies the league ID, see section 15). All 12 teams are claimed and paid by pre-created testnet accounts.
- Hold window: 60 seconds.
- A banner: "Demo league · NEAR testnet · Press Settle on any week to watch it pay out."
- Every week shows a **Settle** button until it's settled. A judge can watch a payout go from "On hold" to "Paid" in about a minute.
- A **Reset demo** action in the Worker clears demo settlements by deploying a fresh demo league. It is rate-limited and admin-only.

---

## 6. Rules engine (exact)

These rules live in `settle-core` (section 7.2) and are the single source of truth. Each rule has fixture tests.

### 6.1 Inputs

- League rules (from the contract): token, dues, weekly amount, regular-season weeks, season split, withhold flag
- Sleeper data for one week: `matchups/<week>` and `rosters`, or for the season: `winners_bracket` and `rosters`
- NFL state: `state/nfl`

### 6.2 When a week is final

A week `W` of season `S` is final when either:

- the league's `status` is `complete`, or
- `state.season == S` and the current NFL week (spike S3 confirms whether to use `week` or `leg`) is greater than `W`, **and** at least 36 hours have passed since the start of the Tuesday (UTC) after week `W`. This absorbs Sleeper's stat corrections.

If the week isn't final, the job returns `WEEK_NOT_FINAL` and nothing is paid.

Only regular-season weeks (`1 ..= regular_season_weeks`) pay a weekly high score.

### 6.3 Points

- Use `custom_points` when it is present and not null; otherwise `points`.
- Convert to integer hundredths (`round(points × 100)`) before any comparison. Never compare floats.
- A roster missing from the week's matchups scores 0 and can't win.

### 6.4 Weekly high score

- Winner = the roster(s) with the highest points.
- Ties split the weekly amount equally, rounded down to the token's smallest unit. Rounding dust stays in the pot.
- If the winner's team has no approved account, or has unpaid dues while the withhold flag is on, the payout is **withheld**. It is recorded with a reason and the money stays in the pot.

### 6.5 Season payout

- Placements come from `winners_bracket`:
  - the match with `p == 1`: `w` is 1st, `l` is 2nd
  - the match with `p == 3`: `w` is 3rd
  - Spike S3 confirms `p` and the bracket shape on a real completed league.
- settle-core returns the **placements** (which roster finished in each paid place). The **contract** turns them into amounts, because only the contract can read the vault's balance on chain.
- Payout base = the vault's USDC balance at settlement time (the contract reads it with `ft_balance_of`), minus any weekly payouts still on hold.
- Each place gets `base × split_bps / 10000`, rounded down.
- A place with no result (for example, no 3rd-place game) adds its share to 1st place.
- The same withhold rules apply as weekly.
- The season settles once, only when the league's `status` is `complete`.

### 6.5a Not enough in the pot

If the vault holds less than a weekly payout, that payout is withheld with the reason "pot too small" and nothing is sent. This can happen when dues are still coming in.

### 6.6 Output

```json
{
  "kind": "weekly_high_score",
  "league_ref": "sleeper:1048...",
  "season": "2025",
  "week": 9,
  "scores": [{"roster_id": 3, "points_x100": 16238}, ...],
  "payouts": [{"roster_id": 3, "amount": "5000000"}],
  "placements": null,
  "source": {
    "urls": ["https://api.sleeper.app/v1/league/.../matchups/9", "..."],
    "sha256": "..."
  },
  "core_version": "1.0.0"
}
```

For `kind: "season"`, `payouts` is empty and `placements` is `[{"place": 1, "roster_id": 7}, {"place": 2, "roster_id": 2}, {"place": 3, "roster_id": 11}]`.

`sha256` is computed over the canonical JSON of the fetched data (keys sorted, no whitespace), so any reimplementation can reproduce it.

---

## 7. Architecture

```
                    ┌────────────── NEAR testnet ──────────────┐
 Web app ──────────►│ commish contract ──create──► league vault │◄── members' USDC
 (Vite + React)     │      │    ▲                 (Sputnik DAO)  │
   │                │      │    │ resume(result)       │ pays    │
   │                │ request   │                      ▼         │
   │                │ execution │                   winners      │
   │                └──────┼────┼──────────────────────────────────┘
   │                       ▼    │
   │                 OutLayer TEE job  ──GET──►  Sleeper API (public)
   │                 (settle-core in WASI)
   │
   └──► Cloudflare Worker: quick accounts, test USDC faucet, 1Click quote proxy
```

### 7.1 Repo layout

```
commish/
  CLAUDE.md               rules for Claude Code
  SPEC.md                 this file
  README.md               for judges: what, why, "do X, see Y"
  docs/SPIKES.md          spike results (written during Day 0)
  docs/DECISIONS.md       one line per decision, newest first
  crates/settle-core/     Rust lib: Sleeper JSON + rules → result. Pure, no I/O.
  crates/outlayer-job/    WASI binary: fetch Sleeper, call settle-core, print result
  contracts/commish/      Rust near-sdk contract
  contracts/mock-usdc/    NEP-141 test token with a capped public mint (testnet only)
  web/                    Vite + React + TypeScript app
  worker/                 Cloudflare Worker (TypeScript)
  cli/                    TypeScript CLI: create, settle, finalize, verify
  fixtures/sleeper/       recorded Sleeper JSON used by tests
```

Package manager: pnpm workspaces for TypeScript. Cargo workspace for Rust.

### 7.2 settle-core (Rust)

- Pure functions, no network, no clock. Inputs are parsed Sleeper JSON plus rules plus `now`; output is the JSON in 6.6.
- Compiles to three targets from one source:
  1. native, for unit tests and the CLI's `verify`
  2. `wasm32-wasip1` or `wasip2`, inside `outlayer-job` (whichever OutLayer supports; spike S2)
  3. `wasm32-unknown-unknown` via `wasm-bindgen`, for "Check the math" in the browser
- If the browser build costs more than half a day, fall back to a TypeScript port in `web/src/settle/` that must pass the **same** fixture files. Record the decision in `docs/DECISIONS.md`.

### 7.3 outlayer-job (WASI)

- Input (from the contract): `{ sleeper_league_id, season, kind, week?, rules }`
- Fetches the Sleeper endpoints it needs over HTTPS, plus `/state/nfl`.
- Calls settle-core and prints the result JSON to stdout.
- No secrets needed: the Sleeper API is public. Yahoo would need an OAuth secret later; OutLayer supports encrypted secrets.
- Pin it: the contract stores the expected code hash and rejects results from any other build.

### 7.4 commish contract (Rust, near-sdk)

One contract serves all leagues. Account: `commish.<joe-root>.testnet` (Joe chooses the root).

**State**

```rust
pub struct League {
    id: u64,
    sleeper_league_id: String,
    season: String,
    name: String,
    commissioner: AccountId,
    vault: AccountId,            // the league's Sputnik DAO
    token: AccountId,            // USDC (mock on testnet)
    dues: U128,
    weekly_amount: U128,
    regular_season_weeks: u8,
    season_split_bps: Vec<u16>,  // e.g. [6000, 2500, 1500]
    hold_window_ns: u64,
    withhold_unpaid: bool,
    rules_locked: bool,
    is_demo: bool,
}

pub struct Team {
    roster_id: u16,
    sleeper_owner_id: Option<String>,
    account: Option<AccountId>,
    claim: ClaimStatus,          // Unclaimed | Pending(AccountId) | Approved
    dues_paid: U128,
}

pub enum SettlementKey { Week(u8), Season }

pub struct Settlement {
    status: SettlementStatus,    // Requested | OnHold | Paid | Stopped | Failed
    result_sha256: String,
    attestation_ref: String,
    payouts: Vec<Payout>,
    created_at_ns: u64,
}

pub struct Payout {
    roster_id: u16,
    account: Option<AccountId>,
    amount: U128,
    withheld_reason: Option<String>,
    proposal_id: Option<u64>,
}
```

**Methods** (exact names may change; keep this list current in the README)

| Method | Who | What it does |
| --- | --- | --- |
| `create_league(args)` | anyone (becomes commissioner); attaches NEAR for vault storage | Creates the vault through the Sputnik factory with the policy in 7.5, registers the vault and itself with the token, stores the league |
| `claim_team(league_id, roster_id)` | any account | Marks the claim pending |
| `approve_claim(league_id, roster_id)` / `decline_claim` | commissioner | Approves; adds the member to the vault's `league` role through a vault proposal the contract approves itself |
| `ft_on_transfer(sender_id, amount, msg)` | the league's token contract | `msg = {"league_id":7,"roster_id":3}`. Records dues up to the dues amount, forwards them to the vault, returns any excess. Payments credit the team, not the payer, so a payment made before claim approval still counts. The first payment locks the rules |
| `settle(league_id, key)` | anyone; attaches the OutLayer fee | Requests OutLayer execution; resumes with the result; verifies the code hash; records the settlement; creates one vault Transfer proposal per non-withheld payout; sets status OnHold |
| `finalize(league_id, key)` | anyone | Fails before the hold window ends. After it: votes approve on each proposal still in progress. Proposals the league rejected are marked Stopped |
| `reassign_team(league_id, roster_id, account)` | the vault account only | Lets the league change who owns a team by vote |
| views | anyone | `get_league`, `get_teams`, `get_settlements`, `get_settlement`, `list_leagues(from, limit)` |

**Invariants** (each one gets a test)

- The contract never holds league money after `ft_on_transfer` returns. It forwards to the vault.
- A key settles once. A second `settle` for the same key fails.
- Payouts go only to approved accounts mapped to the winning rosters, and never exceed the rules or the vault balance.
- Rules can't change after the first dues payment.
- The commissioner has no method that moves money.
- `finalize` before the hold window ends fails.

### 7.5 The vault: Sputnik DAO policy

Verified in `sputnik-dao-contract/sputnikdao2/src/policy.rs` (Nov 7): when a member votes, the DAO checks each of that voter's roles, and **the first role whose votes reach its threshold decides the outcome**. A role with a single member reaches its threshold with one vote. That is the property this design uses.

Each league's vault is created with this policy (field names to confirm in spike S1):

| Role | Members | Permissions | Vote policy |
| --- | --- | --- | --- |
| `settler` | the commish contract only | `transfer:AddProposal`, `transfer:VoteApprove`, `add_member_to_role:AddProposal`, `add_member_to_role:VoteApprove` | default (with 1 member, 1 vote approves) |
| `league` | commissioner + approved members | `*:AddProposal`, `*:VoteApprove`, `*:VoteReject`, `*:VoteRemove` | majority by role weight (`threshold: [1, 2]`) |

Plus: `proposal_bond: "0"` (the default is 1 NEAR, which would break the contract's proposals), and `proposal_period` = 14 days.

What this means in plain words, for `/how` and the README:

- The commish contract can only pay out what the rules compute, and it waits out the hold window before approving.
- During the window, a majority of the league can reject a payout. Once rejected, the contract can't approve it.
- A majority of the league can also vote to do anything with the vault, including firing Commish. It's their league. LeagueSafe offers the same majority vote.
- The commissioner alone can't move money.

Payout transfers: the vault's `Transfer` proposal kind sends NEP-141 tokens. The receiver must be registered with the token contract, so `approve_claim` registers the member's account with the token (storage deposit paid by the commissioner's attached NEAR, or by the Worker on testnet).

Sputnik testnet factory: the repo README uses `sputnik-v2.testnet`. Confirm in spike S1.

### 7.6 Token

- **Demo and default: `mock-usdc`**, a NEP-141 with 6 decimals and a public `mint` capped at 500 test USDC per account per day. Deployed by us on testnet. Name it clearly ("Test USDC").
- Real testnet USDC from Circle exists (listed in near-kit as `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af`; not verified by us). Use it only if spike S4 shows a reliable faucet. It's a nice-to-have, not a dependency.

### 7.7 NEAR Intents 1Click (preview only)

- The Worker proxies `quote` requests with `dry: true` to the 1Click API, so the browser avoids CORS and the optional API key stays server side.
- A JWT is optional. Without one, quotes carry an extra 0.25% platform fee (docs.near-intents.org, authentication page). For dry-run quotes that doesn't matter. Use `ONECLICK_JWT` if Joe provides one.
- The destination is USDC on NEAR mainnet with the member's account as recipient. Show the origin amount, the deposit address shape and the estimated time.
- Never execute a mainnet swap in this build.

### 7.8 Web app

- Vite, React, TypeScript, React Router. Data fetching with TanStack Query.
- NEAR access through the library the near-dapp and near-api-js agent skills recommend. Look it up; don't assume.
- Styling: Tailwind or CSS modules. Use the `frontend-design` skill for the visual direction (section 8).
- Polls the contract and the vault every 10 seconds on the league page while a payout is on hold.
- Deploy target: Cloudflare Pages (Joe already deploys to Cloudflare). Vercel is fine if Pages fights the build.

### 7.9 Worker (Cloudflare)

| Route | What it does | Limits |
| --- | --- | --- |
| `POST /accounts` | Creates a quick account under the demo root, funds it with 0.5 NEAR | 3 per IP per hour |
| `POST /faucet` | Mints test USDC to an account | 500 per account per day |
| `POST /quote` | Proxies a 1Click dry-run quote | 30 per IP per minute |
| `POST /demo/reset` | Deploys a fresh seeded demo league | admin token only |

Secrets (in Worker env, never in the repo): the demo root key, `ONECLICK_JWT`, `ADMIN_TOKEN`.

### 7.10 CLI

```
pnpm commish create   --sleeper <id> --dues 50 --weekly 5 --split 60,25,15 --hold 24h
pnpm commish settle   --league <n> --week 9 | --season
pnpm commish finalize --league <n> --week 9 | --season
pnpm commish verify   --sleeper <id> --week 9 [--settlement <league>:<key>]
```

`verify` fetches Sleeper itself, runs settle-core natively, prints the scoreboard, winners, amounts and data hash, and, with `--settlement`, compares against what's on chain. It needs no keys.

---

## 8. Visual design

Direction: **a scoreboard in your group chat.** Bold, sporty, readable at arm's length on a phone.

- Big tabular numbers for money and points. The pot balance is the hero.
- Team avatars everywhere. They make it feel like *your* league.
- Receipts look like ticket stubs: perforated edge, monospace data, a stamp-style status chip.
- One accent color for money and success. Status colors used sparingly: amber for on hold, red only for stopped.
- Dark and light themes; follow the system setting.
- Motion: a short count-up when the pot changes, and the status chip flipping from "On hold" to "Paid". Respect `prefers-reduced-motion`.
- Tap targets at least 44px. WCAG AA contrast.
- Copy tone: short, friendly, a little fantasy-football banter on empty states ("Your money's safer than your waiver claims"). Never mocking.

---

## 9. Data, security and trust

### 9.1 Trust model (put this in the README)

| You trust | For | How it's checked |
| --- | --- | --- |
| Sleeper's API | The scores | Public; anyone can fetch the same URLs |
| OutLayer and Intel TDX | Running the pinned settle-core build honestly | Attestation; code hash pinned in the contract |
| The commish contract | Only paying what the rules compute | Open source, tests, invariants above |
| Your league's majority | Overrides | The vault policy; visible to all |

What is **not** trusted: the commissioner, the Commish team, the web app, the Worker. The web app could lie about the scores, which is why "Check the math" and the CLI exist.

### 9.2 Known limits (put these in the README too)

- Sleeper can apply stat corrections after a week settles. The 36-hour wait and the hold window reduce this but don't eliminate it.
- Team claims rely on the commissioner's approval. Sleeper's API can't prove who owns a team.
- A league majority can move the vault's money. That's a feature, and it's disclosed.
- OutLayer is a third-party platform. Its guarantees are only as good as its attestation flow.

### 9.3 Security checklist

- [ ] No keys or JWTs in the repo. `.env` is gitignored; `.env.example` lists names only.
- [ ] Contract invariants from 7.4 have tests.
- [ ] `ft_on_transfer` accepts only the league's token contract as predecessor.
- [ ] `settle` rejects results whose code hash doesn't match the pinned hash.
- [ ] Settlement keys can't be replayed.
- [ ] The Worker rate-limits every route and never signs anything except account creation and faucet mints.
- [ ] Quick-account keys never leave the browser except through the explicit Export.

### 9.4 Privacy

Sleeper data is public. Commish stores only roster IDs, Sleeper user IDs, display names and NEAR accounts. No email collection.

---

## 10. Testing

### 10.1 settle-core (must have)

Fixtures in `fixtures/sleeper/`, recorded from the demo league plus hand-edited edge cases:

- [ ] single weekly winner
- [ ] two-way and three-way ties, with rounding dust
- [ ] `custom_points` overriding `points`
- [ ] a roster missing from the week
- [ ] a week past the regular season is rejected
- [ ] a week not final yet → `WEEK_NOT_FINAL`
- [ ] bracket with 1st, 2nd and 3rd
- [ ] bracket with no 3rd-place game → share goes to 1st
- [ ] withheld: no account; dues unpaid
- [ ] canonical JSON hash is stable across runs and key order

### 10.2 Contract (must have)

Use near-workspaces with the real `sputnikdao2` wasm from the Sputnik repo, and a `mock-oracle` feature flag that is compiled **only** into tests.

- [ ] `create_league` deploys a vault with the 7.5 policy
- [ ] approving a claim adds the member to the `league` role and registers them with the token
- [ ] dues are recorded, forwarded to the vault, excess refunded, rules locked
- [ ] `settle` creates proposals; a second `settle` fails
- [ ] `finalize` before the window fails; after it, winners get paid
- [ ] a league majority rejects a payout during the window → finalize marks it Stopped and the money stays
- [ ] unpaid winner → withheld, no proposal
- [ ] payout larger than the vault balance → withheld as "pot too small"
- [ ] season settlement turns placements into amounts from the vault balance, with a missing 3rd place going to 1st
- [ ] the commissioner can't move funds through any method

### 10.3 End to end (should have)

One script, `pnpm e2e`, against testnet: create a league from the demo Sleeper league, seed 12 paid accounts, settle week 1 with a 60-second window, finalize, and assert the winner's balance.

### 10.4 Before submitting

- [ ] A fresh clone on a clean machine follows the README and gets the same results
- [ ] Every README step is a command or a click with a stated expected result
- [ ] The hosted demo works in a private browser window on a phone

---

## 11. README for judges (outline)

The jury includes Claude Code and Codex. They check that the project runs and matches the README. Write for a machine reader: no marketing, every claim tied to something they can run or click.

1. **What it is**, in two sentences.
2. **The problem**, in three sentences, with the FSGA and LeagueSafe links.
3. **Try it in 2 minutes** (hosted):
   1. Open `<demo url>/demo`. You see a 12-team league with a $600 pot, all paid.
   2. Press **Settle** on week 3. A receipt appears, "On hold" with a 60-second countdown.
   3. Wait. The receipt flips to **Paid** with a transaction link. The winner's balance rises by $5.00.
   4. Open the receipt and press **Check the math**. You see "Matches ✓".
4. **Run it locally**: `pnpm i`, `cargo test`, `pnpm test`, `pnpm commish verify --sleeper <id> --week 3` (expected output shown).
5. **How the money moves**: the diagram and the trust table from 9.1.
6. **NEAR features used**: Sputnik DAO, OutLayer TEE execution with attestation, NEAR Intents 1Click (preview), NEP-141, named accounts, testnet.
7. **Known limits**: section 9.2.
8. **Built at NEAR HACKATHON**, Nov 2026. Tracks: Social Money, Real-World Money.

---

## 12. Day 0 spikes: run before feature work

Write results to `docs/SPIKES.md`: what was tried, what happened, links to transactions, and the decision. Stop after the spikes and report to Joe.

| # | Question | Pass when | If it fails |
| --- | --- | --- | --- |
| S1 | Can a contract create a Sputnik vault with the 7.5 policy, add a Transfer proposal, and approve it alone, while a 3-member `league` role can reject it first? | Shown in near-workspaces with the real sputnikdao2 wasm, and once on testnet | Fall back to a Commish-owned escrow with the same hold-and-reject logic. This weakens the Social Money fit, so tell Joe before choosing it |
| S2 | Can an OutLayer job make an outbound HTTPS GET to `api.sleeper.app`, and can our contract request it and get the result back (yield/resume)? What's the cost and the attestation format? | A testnet contract receives a Sleeper-derived result from OutLayer | **Fallback:** a keeper (the Worker) runs settle-core and submits the result signed with a keeper key; the contract accepts results only from that key; the README says plainly this is a trusted keeper, checkable by re-execution. Tell Joe |
| S3 | Sleeper field check on the demo league: `settings.playoff_week_start`, `status`, `matchups.custom_points`, bracket `p`, `/state/nfl` week vs leg | Each field confirmed or replaced in this spec | Adjust 6.2 and 6.5 |
| S4 | Token: deploy `mock-usdc`; check whether Circle's testnet USDC has a usable faucet | mock-usdc minted and transferred via `ft_transfer_call` | Use mock-usdc only (expected) |
| S5 | Wallet and quick account: which connector does the near-dapp skill recommend; can the Worker create and fund `<name>.<root>.testnet` | A new account signs a USDC `ft_transfer_call` from the browser | Wallet-only sign-in for the demo |

---

## 13. Hackathon constraints

- **Testnet only.** No mainnet transactions, except read-only 1Click dry-run quotes.
- No real-money gambling. The README says this is a testnet demo, and that paid fantasy is regulated differently by state and country.
- The repo must be public by the deadline. Joe makes it public; never do it without him.
- The demo post on X tags **@NEARProtocol** and **#NEARHackathon**, says it was built at NEAR HACKATHON, and attaches the video. Joe posts it.
- The submission goes through the form or the API **only after Joe confirms the exact payload**. Submit on Nov 13.
- Work done before Nov 1 counts as baseline; everything here is new work in the window.

---

## 14. Plan and gates

| Day | Work | Gate (must pass to move on) |
| --- | --- | --- |
| Nov 7–8 | Spikes S1–S5, fixtures recorded, settle-core with tests | Spike report reviewed by Joe |
| Nov 8–9 | Contract: create league, claims, dues, vault policy; mock-usdc; CLI `create` | **G1:** dues paid on testnet land in a league vault |
| Nov 10 | OutLayer job; `settle` and `finalize`; CLI `settle`/`verify` | **G2:** a real finished week from the demo league pays the winner on testnet, with an attestation |
| Nov 11 | Web: create, join, quick accounts, pay, league page, Worker | **G3:** someone who has never seen it joins from a link and pays without help |
| Nov 12 | Receipts, Check the math, hold button, season payout, `/demo`, `/how`, README, e2e | **G4:** a fresh clone runs the README steps in one go |
| Nov 13 | Demo video (Joe), X post (Joe), submission (Joe confirms) | Submitted |
| Nov 14 | Buffer only. No new features | — |

**Cut order if a gate slips:** (1) Yahoo, never started. (2) Season payout UI (keep the logic and tests). (3) 1Click preview. (4) Browser "Check the math" (keep the CLI `verify`). **Never cut:** the vault, the attested settlement (or its disclosed keeper fallback), the hold window, the demo league.

---

## 15. Open questions for Joe

1. **A completed 2025 Sleeper league ID** for the demo and fixtures. Any friend's league works; the data is public. Needed before spike S3.
2. The testnet root account for `commish.<root>.testnet` and the quick-account root.
3. An optional 1Click partner JWT (`ONECLICK_JWT`). Not required.
4. Keep the name "Commish"?

---

## Sources

- NEAR HACKATHON: https://nearhackathon.com and https://nearhackathon.com/HACKATHON.md
- FSGA 2025 research (≈57M players, US and Canada): https://thefsga.org/new-fsga-research-highlights-industry-stability-and-next-generation-growth-in-fantasy-sports-and-sports-betting
- LeagueSafe on commissioner theft: https://www.leaguesafe.com/blog/what-if-commissioner-takes-the-money
- Sleeper API (read-only, no key): https://docs.sleeper.com
- Sputnik DAO contract: https://github.com/near-daos/sputnik-dao-contract
- OutLayer overview: https://docs.near.org/primitives/off-chain-compute/outlayer
- 1Click API authentication (JWT optional, +0.25% without): https://docs.near-intents.org/integration/distribution-channels/1click-api/authentication
- NEAR access keys: https://docs.near.org/protocol/accounts-contracts/access-keys
