// pnpm e2e: end to end on NEAR testnet (SPEC 10.3). Needs the root key (DEMO_ROOT_PRIVATE_KEY or
// ~/.near-credentials). Spends about 7.5 testnet NEAR (one vault and 12 team accounts).
//
// 1. create a league from the demo Sleeper league with a 60-second hold, 12 paid accounts
// 2. settle week 1 through OutLayer
// 3. wait out the hold, finalize, assert the winner got $5 and the pot went down by $5
// 4. recompute the settlement natively (`commish verify --settlement`) and require a match
import { spawnSync } from "node:child_process";
import { seedDemoLeague } from "@commish/shared/seed";
import { config, repoRoot } from "./config.js";
import { provider, rootAccount } from "./keys.js";
import * as L from "./league.js";
import { dollars, explorerTx, sleep } from "./util.js";

const t0 = Date.now();
const step = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
}

const sleeperId = process.env.DEMO_SLEEPER_LEAGUE_ID ?? "1197787383500648448";
step(`contract ${config.contractId}, Sleeper league ${sleeperId}`);
const seeded = await seedDemoLeague({
  root: rootAccount(), provider: provider(), contractId: config.contractId, usdcId: config.usdcId,
  sleeperLeagueId: sleeperId, preSettleWeeks: [], log: (l) => step(l),
});
const id = seeded.leagueId;
const league = await L.view<{ paid_count: number; team_count: number; vault: string }>("get_league", { league_id: id });
assert(league.paid_count === 12 && league.team_count === 12, `12 of 12 paid (got ${league.paid_count} of ${league.team_count})`);
const potBefore = await L.ftBalance(seeded.vault);
assert(potBefore === 600_000_000n, `pot is $600 (got ${dollars(potBefore)})`);
step(`✓ league ${id}: 12 of 12 paid, pot ${dollars(potBefore)}`);

const { txHash, settlement } = await L.settle(rootAccount(), id, { Week: 1 });
step(`settle week 1: ${explorerTx(txHash)} → ${settlement.status}`);
assert(settlement.status === "OnHold", `week 1 on hold (got ${settlement.status}: ${settlement.error})`);
const p = settlement.payouts[0]!;
assert(settlement.payouts.length === 1 && p.roster_id === 2 && p.amount === "5000000", "roster 2 wins $5 (real week 1: 170.02)");
const winner = seeded.teams.find((t) => t.roster_id === 2)!.account;
assert(p.account === winner, `paid to the approved account ${winner}`);
const winnerBefore = await L.ftBalance(winner);

const ends = Number(BigInt(settlement.hold_ends_at_ns!) / 1_000_000n);
const early = await L.call(rootAccount(), "finalize", { league_id: id, key: { Week: 1 } }, 0n, 300n * L.TGAS).then(() => "succeeded", (e) => String(e));
assert(early.includes("hold window ends"), `finalize before the hold window fails (got: ${early.slice(0, 120)})`);
step("✓ finalize before the hold window ends is refused");
while (Date.now() < ends + 3000) await sleep(2000);
const f = await L.finalize(rootAccount(), id, { Week: 1 });
step(`finalize: ${explorerTx(f.txHash)} → ${f.settlement?.payouts.map((x) => x.status).join(",")}`);
await sleep(4000);
const winnerAfter = await L.ftBalance(winner);
const potAfter = await L.ftBalance(seeded.vault);
assert(winnerAfter - winnerBefore === 5_000_000n, `winner +$5 (got ${dollars(winnerAfter - winnerBefore)})`);
assert(potBefore - potAfter === 5_000_000n, `pot −$5 (got ${dollars(potBefore - potAfter)})`);
step(`✓ winner ${winner}: ${dollars(winnerBefore)} → ${dollars(winnerAfter)}; pot ${dollars(potAfter)}`);

const v = spawnSync("cargo", ["run", "-q", "--release", "-p", "commish-verify", "--", "--settlement", `${id}:w1`, "--contract", config.contractId], {
  cwd: repoRoot, encoding: "utf8", env: { ...process.env, NEAR_RPC_URL: process.env.NEAR_RPC_URL ?? "" },
});
process.stdout.write(v.stdout.split("\n").slice(-12).join("\n"));
assert(v.status === 0 && v.stdout.includes("Matches ✓"), "commish verify --settlement matches");
step(`✓ e2e passed in ${((Date.now() - t0) / 1000).toFixed(0)} s (league ${id})`);
