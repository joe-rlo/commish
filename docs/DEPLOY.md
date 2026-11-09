# Deploy and launch runbook

Nothing here runs without Joe's go-ahead (CLAUDE.md: deploying the Worker or web app, pushing,
making the repo public, posting and submitting all need a yes first).

## Live (deployed 2026-11-09)

- Web app (Cloudflare Pages, project `commish`): https://commish-2o8.pages.dev
- Worker: https://commish-worker.joe-253.workers.dev (`/health` → `{"ok":true}`)
- KV namespace `RATE`: id in `worker/wrangler.toml`. Secrets set: `DEMO_ROOT_PRIVATE_KEY`, `ADMIN_TOKEN`
  (its value is `ADMIN_TOKEN_PROD` in the gitignored `.env`). `ONECLICK_JWT` is not set; quotes work without it.
- `ALLOWED_ORIGINS` is the Pages URL only; local `wrangler dev` overrides it with `*` from `.dev.vars`.

## 1. Redeploy the Worker

Wrangler is a dependency of the `worker` package only. Run Worker commands from `worker/`
(or the repo root with `pnpm --filter @commish/worker exec wrangler …`).

```sh
cd worker
pnpm exec wrangler whoami                     # logged in? if not: pnpm exec wrangler login (Joe, interactive)
pnpm exec wrangler deploy                     # secrets persist across deploys
curl -s https://commish-worker.joe-253.workers.dev/health
```

To set a secret without it touching the shell history, pipe it: `… | pnpm exec wrangler secret put NAME`.
Never set `RATE_LIMIT_SCALE` in production.

## 2. Redeploy the web app

Run Pages commands from `web/`, which has no `wrangler.toml`. From `worker/`, wrangler reads the
Worker's config and tries to deploy the Worker under the Pages project's name.

```sh
VITE_WORKER_URL=https://commish-worker.joe-253.workers.dev pnpm --filter @commish/web build
cd web && ../worker/node_modules/.bin/wrangler pages deploy dist --project-name commish --branch main
```

`--branch main` makes it the production deployment; without it wrangler uses the current git
branch and publishes a preview URL. Wrangler 4.152 routes `pages project create` to the new
Workers-based Pages and fails without a config; the project was created once with `--force`
(classic Pages). Don't pass `--force` again.

## 3. Fresh demo league before judging

```sh
pnpm commish demo-seed        # ~7.5 testnet NEAR; /demo switches to the new league
```

Then run the README flow against the hosted URL:

```sh
node web/scripts/judge-flow.mjs https://commish-2o8.pages.dev 3   # 3 = an open week
```

Keep the root topped up: each quick account takes 0.5 NEAR, each sponsored league ~5.8.
`pnpm commish status --league <n>` and the explorer show balances.

## 4. Check on a phone

Run the four README steps on a real phone against https://commish-2o8.pages.dev/demo.

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
