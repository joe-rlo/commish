// Spikes S1, S2b and S4 on testnet, end to end:
//  - create a demo league (hold 60 s) → a real Sputnik vault via sputnik-v2.testnet
//  - three members claim (roster 8 = week 3 winner, roster 2 = week 1 winner, roster 1), get approved, pay $50
//  - settle week 3 and week 1 through OutLayer (our contract ⇄ outlayer.testnet yield/resume)
//  - a league majority rejects week 1 during the hold; week 3 is paid after it
// Usage: pnpm exec tsx cli/src/spikes/s1-testnet.ts
import { actions, KeyPair, nearToYocto } from "near-api-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "../config.js";
import { account, provider, rootAccount } from "../keys.js";
import * as L from "../league.js";
import { dollars, explorerTx, sleep } from "../util.js";

const root = rootAccount();
const tag = Date.now().toString(36).slice(-4);

async function newAccount(name: string) {
  const id = `${name}-${tag}.${root.accountId}`;
  const kp = KeyPair.fromRandom("ed25519");
  const dir = join(homedir(), ".near-credentials", "testnet");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
  await root.signAndSendTransaction({
    receiverId: id,
    actions: [actions.createAccount(), actions.transfer(nearToYocto("0.3")), actions.addFullAccessKey(kp.getPublicKey())],
    waitUntil: "FINAL",
  });
  return account(id);
}

console.log(`root ${root.accountId}, contract ${config.contractId}, token ${config.usdcId}`);
const { leagueId, txHash } = await L.createLeague(root, {
  sleeperLeagueId: "1197787383500648448", dues: 50_000_000n, weekly: 5_000_000n, split: [60, 25, 15],
  holdNs: 60_000_000_000n, isDemo: true,
});
const league = await L.view<{ vault: string }>("get_league", { league_id: leagueId });
console.log(`S1 league ${leagueId}, vault ${league.vault}: ${explorerTx(txHash)}`);
const policy = await provider().callFunction({ contractId: league.vault, method: "get_policy", args: {} });
console.log("vault policy roles:", JSON.stringify((policy as any).roles.map((r: any) => ({ name: r.name, kind: r.kind, perms: r.permissions }))));

const alice = await newAccount("alice"); // roster 8 (wins week 3)
const bob = await newAccount("bob"); // roster 2 (wins week 1)
const carol = await newAccount("carol"); // roster 1
for (const [m, roster] of [[alice, 8], [bob, 2], [carol, 1]] as const) {
  const c = await L.claim(m, leagueId, roster);
  const a = await L.approve(root, leagueId, roster);
  const mint = await L.mint(root, m.accountId, 100_000_000n);
  const pay = await L.payDues(m, leagueId, roster, 50_000_000n);
  console.log(`S4 ${m.accountId} roster ${roster}: claim ${explorerTx(c.txHash)} approve ${explorerTx(a.txHash)} mint ${explorerTx(mint.txHash)} pay ${explorerTx(pay.txHash)}`);
}
await sleep(3000);
console.log(`vault balance ${dollars(await L.ftBalance(league.vault))}, contract balance ${dollars(await L.ftBalance(config.contractId))}`);
const pol2 = (await provider().callFunction({ contractId: league.vault, method: "get_policy", args: {} })) as any;
console.log("league role members:", JSON.stringify(pol2.roles[1].kind.Group));

const t0 = Date.now();
const w3 = await L.settle(root, leagueId, { Week: 3 });
console.log(`S2b settle week 3 in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${explorerTx(w3.txHash)} → ${w3.settlement.status}, attestation ${w3.settlement.attestation_ref}, result sha256 ${w3.settlement.result_sha256}`);
const w1 = await L.settle(root, leagueId, { Week: 1 });
console.log(`S2b settle week 1: ${explorerTx(w1.txHash)} → ${w1.settlement.status}, payouts ${JSON.stringify(w1.settlement.payouts)}`);

// League majority (4 members: root, alice, bob, carol; quorum 2, majority 3) rejects week 1.
const pid = w1.settlement.payouts[0]!.proposal_id!;
const prop = (await provider().callFunction({ contractId: league.vault, method: "get_proposal", args: { id: pid } })) as any;
for (const m of [root, alice, carol]) {
  const r = await L.call(m, "act_proposal", { id: pid, action: "VoteReject", proposal: prop.kind, memo: "spike S1: league stops this payout" }, 0n, 150n * L.TGAS, league.vault);
  console.log(`S1 ${m.accountId} rejects proposal ${pid}: ${explorerTx(r.txHash)}`);
}
const after = (await provider().callFunction({ contractId: league.vault, method: "get_proposal", args: { id: pid } })) as any;
console.log(`proposal ${pid} status after 3 rejects: ${after.status}`);

const holdEnds = Number(BigInt(w3.settlement.hold_ends_at_ns!) / 1_000_000n);
while (Date.now() < holdEnds + 3000) await sleep(2000);
const aliceBefore = await L.ftBalance(alice.accountId);
const f3 = await L.finalize(bob, leagueId, { Week: 3 }); // anyone can finalize
const f1 = await L.finalize(bob, leagueId, { Week: 1 });
await sleep(4000);
console.log(`finalize week 3: ${explorerTx(f3.txHash)} → ${JSON.stringify(f3.settlement?.payouts.map((p) => p.status))}`);
console.log(`finalize week 1: ${explorerTx(f1.txHash)} → ${JSON.stringify(f1.settlement?.payouts.map((p) => p.status))}`);
console.log(`alice ${dollars(aliceBefore)} → ${dollars(await L.ftBalance(alice.accountId))}; vault ${dollars(await L.ftBalance(league.vault))}`);
