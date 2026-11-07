# Commish

The commissioner can't touch the money.

Commish holds a fantasy league's dues in the league's own vault on NEAR and pays winners automatically from the league's Sleeper results. Payouts are computed inside an attested enclave, and anyone can recheck the math.

> Work in progress for NEAR HACKATHON (Nov 1–14, 2026). NEAR testnet only. This is a demo, not a real-money product: paid fantasy is regulated differently by state and country. "Commish" is a working name.

## The problem

About 57 million adults in the US and Canada play fantasy sports ([FSGA, 2025](https://thefsga.org/new-fsga-research-highlights-industry-stability-and-next-generation-growth-in-fantasy-sports-and-sports-betting)). In leagues among friends, the commissioner usually holds the dues in a personal account, and has to be trusted with them for months. [LeagueSafe](https://www.leaguesafe.com/blog/what-if-commissioner-takes-the-money) built a business on that fear.

## Try it in 2 minutes

_To be written during the build. Target:_

1. Open the demo league. See a 12-team league with a $600 pot, all paid.
2. Press **Settle** on a week. See a receipt appear, on hold for 60 seconds.
3. Wait. See it flip to **Paid**, with a transaction link.
4. Open the receipt and press **Check the math**. See "Matches ✓".

## Run it locally

_To be written during the build._

## How the money moves

_Diagram and trust table go here. See SPEC.md sections 7 and 9._

## NEAR features used

- Sputnik DAO: each league's vault
- OutLayer: settlement computed in a TEE, with attestation
- NEAR Intents 1Click: pay dues from any chain (preview)
- NEP-141 tokens, named accounts

## Known limits

_See SPEC.md section 9.2._

## Built at NEAR HACKATHON

https://nearhackathon.com · Tracks: Social Money, Real-World Money
