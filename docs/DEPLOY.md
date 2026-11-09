# Deploy and launch runbook

Nothing here runs without Joe's go-ahead (CLAUDE.md: deploying the Worker or web app, pushing,
making the repo public, posting and submitting all need a yes first).

## 1. Worker (Cloudflare)

Wrangler is a dependency of the `worker` package only, so every command below runs from the
repo root through `pnpm --filter @commish/worker exec`, which runs it inside `worker/`.

```sh
W="pnpm --filter @commish/worker exec wrangler"
$W whoami                                     # already logged in? if not: $W login (Joe, interactive)
$W kv namespace create RATE                   # put the printed id in worker/wrangler.toml [[kv_namespaces]]
$W secret put DEMO_ROOT_PRIVATE_KEY           # private key of commishhq.testnet (prompted, never echoed)
$W secret put ADMIN_TOKEN                     # any long random string
$W secret put ONECLICK_JWT                    # optional
# set ALLOWED_ORIGINS in worker/wrangler.toml to the Pages URL from step 2, then:
$W deploy
curl -s https://commish-worker.<subdomain>.workers.dev/health   # {"ok":true}
```

Do not set `RATE_LIMIT_SCALE` in production.

## 2. Web app (Cloudflare Pages)

```sh
VITE_WORKER_URL=https://commish-worker.<subdomain>.workers.dev pnpm --filter @commish/web build
$W pages deploy ../web/dist --project-name commish   # path is relative to worker/
```

`web/public/_redirects` sends every path to `index.html`, so `/demo` and `/l/1/r/w1` load directly.

## 3. Fresh demo league before judging

```sh
pnpm commish demo-seed        # ~7.5 testnet NEAR; /demo switches to the new league
```

Then run the README flow against the hosted URL:

```sh
node web/scripts/judge-flow.mjs https://<pages-url> 3
```

Keep the root topped up: each quick account takes 0.5 NEAR, each sponsored league ~5.8.
`pnpm commish status --league <n>` and the explorer show balances.

## 4. Update the README

Replace "Hosted demo: not deployed yet" with the Pages URL, and run the four README steps on a phone.

## 5. Repo public, X post, submission (Joe)

- Make the repo public (Joe).
- X post (Joe posts). Draft:

  > Fantasy league dues usually sit in the commissioner's Venmo for five months. Commish puts them in the league's own vault on @NEARProtocol and pays the winners straight from your Sleeper scores.
  >
  > Each payout's math runs inside an attested TEE (OutLayer), waits out a hold window the league can veto, then pays from a Sputnik DAO. Anyone can press "Check the math".
  >
  > Built at NEAR HACKATHON. Try the demo league: <url> · code: <repo>
  > What would make you trust a league pot you can't see? #NEARHackathon

- Submission "What they built" draft (≤ 2000 chars):

  > Problem: in fantasy leagues among friends, the commissioner holds everyone's dues in a personal account for months and does the payout math by hand; "commissioner theft" is common enough that LeagueSafe built a business on it.
  >
  > Commish holds a league's dues in the league's own Sputnik DAO vault on NEAR and pays winners automatically from the league's public Sleeper results. A NEAR contract asks OutLayer to run a pinned build of our payout code (settle-core, Rust) inside an Intel TDX enclave; the result comes back through yield/resume with an attestation of the exact code, input and output. The contract turns it into vault Transfer proposals that wait out a hold window, during which a majority of the league can stop any payout; after it, the contract (the vault's only "settler") approves them. The commissioner can approve team claims but has no way to move money, and the vault's league votes need a majority and at least two people.
  >
  > Every receipt shows the scoreboard, the Sleeper URLs and data hash, the attestation and the vault payout, and "Check the math" reruns the same Rust code compiled to wasm in the browser against live Sleeper data. A CLI (`pnpm commish verify --settlement`) does the same natively and checks the attestation hashes. Members sign in with a quick testnet account (no seed phrase) or a NEAR wallet, pay in Test USDC, and see a live NEAR Intents 1Click quote for paying from other chains (preview, not executed).
  >
  > NEAR pieces: Sputnik DAO (one vault per league, official testnet factory), OutLayer TEE execution with yield/resume, NEAR Intents 1Click (dry-run quotes), NEP-141/145, named sub-accounts. Testnet only, test money only.
