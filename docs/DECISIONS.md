# Decisions

One line each, newest first: date · decision · why.

- 2026-11-07 · Season settles only after every regular-season week has settled (when weekly payouts are on) · the spec's base (vault balance minus payouts on hold) would otherwise let an early season payout eat unsettled weekly prizes; ordering keeps the "$70 weekly · $530 split" promise. Flagged to Joe
- 2026-11-07 · `league` role votes need quorum 2 on top of majority · without it a league whose only member is the commissioner lets the commissioner pass a transfer alone (dues can arrive before claims are approved)
- 2026-11-07 · `finalize` re-reads the pot and registers the winner with the token before approving · testnet's Sputnik DAO (v2.0.0 era) marks a proposal Approved even when its transfer fails, so the contract makes failure impossible instead of detecting it
- 2026-11-07 · Vault deposit 5.3 NEAR · measured: a DAO from sputnik-v2.testnet locks 4.72 NEAR (471,686 bytes); 0.58 NEAR left for ~50 proposals
- 2026-11-07 · Sandbox tests use the exact testnet bytes of sputnik-v2.testnet (factory + DAO) and outlayer.testnet (fixtures/wasm/) · the testnet factory is older than the repo; testing anything else would test the wrong code
- 2026-11-07 · near-workspaces 0.23 for sandbox tests, with rustls pinned to 0.23.40 in dev-deps · near-sdk 5.29's unit-testing feature pins aws-lc-rs 1.16.2; rustls 0.23.46 needs ^1.18
- 2026-11-07 · near-sdk 5.29.1, not 5.30.1 · 5.30.1 was two days old
- 2026-11-07 · OutLayer source = WasmUrl on FastFS, pinned by SHA-256; contract stores sha256(output) and the OutLayer request id · verified: equals the attestation's output_hash; receipts link /attestations/by-request/{id}
- 2026-11-07 · The job embeds an `outlayer.manifest` allowlist (api.sleeper.app only) · the worker enforces it and it's covered by the pinned hash
- 2026-11-07 · Canonical JSON = RFC 8785 (JCS) with ECMAScript number formatting via Ryū · Sleeper sends 9.0; Rust and JS print it differently; Rust's {:e} also misses one RFC vector. Fuzzed against Node: 0 mismatches in 299,938 doubles
- 2026-11-07 · Points → hundredths by rounding the decimal value half away from zero · binary float × 100 turns 162.385 into 16238; same result on all real (2-decimal) data
- 2026-11-07 · Finality uses `leg` (fallback `week`), `season_type == "post"` counts as past, "Tuesday after week W" from `season_start_date` · S3
- 2026-11-07 · Demo league: Armchair Football League (Sleeper 1197787383500648448, 2025) · public, complete, 12 teams, bracket with a 3rd-place game, clean team names
- 2026-11-07 · Testnet root `commishhq.testnet` (new, faucet-funded); contract `commish.commishhq.testnet`, token `usdc.commishhq.testnet`, vaults `cmsh1-<id>.sputnik-v2.testnet` · Joe asked for a fresh root
- 2026-11-07 · Browser "Check the math" runs settle-core compiled to wasm32-unknown-unknown with plain exports (no wasm-bindgen) · same source as the enclave, no extra tool to install
- 2026-11-07 · Wallet: @hot-labs/near-connect + near-connect-hooks + near-api-js 7, per the near-dapp agent skill · `npx skills add` was blocked here, so the skill files were read from github.com/near/agent-skills
- 2026-11-07 · Sleeper first, Yahoo later · Sleeper's API is public and read-only with no key; Yahoo needs OAuth
- 2026-11-07 · League money sits in a Sputnik DAO per league · Social Money track asks to build on Sputnik DAO; no single person can withdraw
- 2026-11-07 · Testnet only; 1Click shown as dry-run preview · hackathon allows testnet; avoids real-money gambling questions
