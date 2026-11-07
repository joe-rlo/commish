# Commish

Commish holds a fantasy league's dues in the league's own Sputnik DAO vault and pays winners automatically from the league's Sleeper results, settled inside an attested OutLayer enclave. It is Joe Spano's entry for NEAR HACKATHON (https://nearhackathon.com). Tracks: Social Money (`social`), Real-World Money (`realworld`).

**SPEC.md is the source of truth.** Read it in full before doing anything. If the spec and the code disagree, stop and ask Joe which one changes.

## Hard rules

- **Testnet only.** Never sign a mainnet transaction or point a write at mainnet RPC. The one exception is read-only 1Click dry-run quotes (`dry: true`).
- **No secrets in the repo.** Keys and JWTs go in `.env` (gitignored) or Worker secrets. Never print, log or commit them. `.env.example` holds names only.
- **Ask Joe first, every time,** before you: make the repo public, push, post anything anywhere, submit to the hackathon, deploy the Worker or web app to production, or spend more than 5 testnet NEAR in one step. Print the exact command or payload and wait for a yes.
- **Never guess an address, method name or SDK version.** Look it up in https://docs.near.org/llms.txt, https://docs.near-intents.org/llms.txt, the Sputnik DAO repo, or the OutLayer docs. Record what you found in `docs/DECISIONS.md`.
- **Development ends 2026-11-14T23:59Z. We submit on Nov 13.** Before submitting, re-read the live https://nearhackathon.com/HACKATHON.md.

## How to work

1. **Day 0: run the spikes in SPEC.md section 12 first.** Write the results to `docs/SPIKES.md`, then stop and report to Joe. Don't build features on an unverified assumption.
2. Work gate by gate (SPEC.md section 14). A gate passes only with evidence: a passing test, or a testnet explorer link. Tell Joe when a gate passes or slips.
3. If a gate slips, follow the cut order in section 14. Never cut what it says never to cut.
4. Keep `README.md` true at every commit. Every claim in it maps to a command or a click a judge can run.
5. Log each real decision as one line in `docs/DECISIONS.md`, newest first: date, decision, why.

## Product rules that are easy to break

- No crypto words on the main path ("DAO", "proposal", "gas", "yocto"). Use pot, dues, vault, payout, receipt. On-chain facts go under **Details**.
- Mobile first: design at 375px wide, then scale up.
- `settle-core` is the only place payout math lives. The OutLayer job, the CLI and the browser all call it, or a port that passes the same fixtures.
- Compare points as integer hundredths, never floats.
- Paying dues needs a full-access key or a wallet: NEP-141 transfers need 1 yoctoNEAR, and function-call keys can't attach a deposit.
- The commissioner must never have a way to move money.

## Skills to use

- NEAR agent skills: `npx skills add near/agent-skills` (near-smart-contracts, near-api-js, near-dapp, near-intents, near-kit)
- `frontend-design` for the visual direction in SPEC.md section 8

## Commands

Fill these in as they come to exist. Keep this section current.

```
pnpm i                 # install
cargo test             # settle-core + contract tests
pnpm test              # TypeScript tests
pnpm commish verify    # recompute a settlement from public data
pnpm e2e               # end-to-end on testnet
```

## Conventions

- Rust: near-sdk for contracts, cargo-near to build. TypeScript: strict mode, pnpm workspaces.
- Small commits on branches; `main` stays runnable.
- Plain, direct prose in docs and UI copy. No buzzwords.
