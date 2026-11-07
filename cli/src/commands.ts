// CLI commands that act on leagues: create, settle, finalize, status and helpers.
import type { Command } from "commander";
import { config } from "./config.js";
import { account, rootAccount } from "./keys.js";
import * as L from "./league.js";
import { dollars, explorerAccount, explorerTx, parseDollars, parseDuration } from "./util.js";

const signer = (as?: string) => (as ? account(as) : rootAccount());

function keyFrom(o: { week?: string; season?: boolean }): L.Key {
  if (o.season && o.week) throw new Error("pass --week <n> or --season, not both");
  if (o.season) return "Season";
  if (!o.week) throw new Error("pass --week <n> or --season");
  const w = Number(o.week);
  if (!Number.isInteger(w) || w < 1 || w > 18) throw new Error(`bad week: ${o.week}`);
  return { Week: w };
}

function printSettlement(s: L.SettlementView | null) {
  if (!s) return console.log("  not settled");
  console.log(`  status: ${s.status}${s.error ? `  (${s.error})` : ""}`);
  if (s.hold_ends_at_ns) console.log(`  hold ends: ${new Date(Number(BigInt(s.hold_ends_at_ns) / 1_000_000n)).toISOString()}`);
  for (const p of s.payouts) {
    console.log(`  ${p.place ? `place ${p.place} ` : ""}roster ${p.roster_id} → ${p.account ?? "(no account)"} ${dollars(p.amount)} ${p.status}${p.withheld_reason ? ` (${p.withheld_reason})` : ""}${p.proposal_id !== null ? ` proposal #${p.proposal_id}` : ""}`);
  }
  if (s.result_sha256) console.log(`  result sha256: ${s.result_sha256}`);
  if (s.source_sha256) console.log(`  source sha256: ${s.source_sha256}`);
  if (s.attestation_ref) console.log(`  attestation: ${config.outlayerApi}/attestations/by-request/${s.attestation_ref}`);
}

export function registerLeagueCommands(program: Command) {
  program
    .command("demo-seed")
    .description("Create and seed a fresh demo league (root = demo admin): 12 paid teams, 60 s hold")
    .option("--sleeper <id>", "completed Sleeper league", process.env.DEMO_SLEEPER_LEAGUE_ID ?? "1197787383500648448")
    .option("--pre-settle <weeks>", "weeks to settle and pay right away", "1,2")
    .action(async (o) => {
      const { seedDemoLeague } = await import("@commish/shared/seed");
      const { provider } = await import("./keys.js");
      const weeks = String(o.preSettle).split(",").filter(Boolean).map(Number);
      const r = await seedDemoLeague({
        root: rootAccount(), provider: provider(), contractId: config.contractId, usdcId: config.usdcId,
        sleeperLeagueId: o.sleeper, preSettleWeeks: weeks, log: (l) => console.log(`  ${l}`),
      });
      console.log(`✓ demo league ${r.leagueId}, vault ${r.vault}`);
    });

  program
    .command("create")
    .description("Create a league from a Sleeper league (the signer becomes commissioner)")
    .requiredOption("--sleeper <id>", "Sleeper league id")
    .option("--dues <usd>", "dues per team", "50")
    .option("--weekly <usd>", "weekly high-score payout", "5")
    .option("--split <pcts>", "season split in percent", "60,25,15")
    .option("--hold <duration>", "hold window (1h-72h; demo leagues from 10s)", "24h")
    .option("--no-withhold", "pay winners even if their dues are unpaid")
    .option("--demo", "demo league (only the demo admin; allows short holds)")
    .option("--as <account>", "signer (default: the root account)")
    .action(async (o) => {
      const split = String(o.split).split(",").map(Number);
      const { leagueId, txHash } = await L.createLeague(signer(o.as), {
        sleeperLeagueId: o.sleeper, dues: parseDollars(o.dues), weekly: parseDollars(o.weekly), split,
        holdNs: parseDuration(o.hold), withholdUnpaid: o.withhold, isDemo: !!o.demo,
      });
      const l = await L.view<{ vault: string; name: string }>("get_league", { league_id: leagueId });
      console.log(`✓ league ${leagueId} "${l.name}" created  ${explorerTx(txHash)}`);
      console.log(`  vault: ${l.vault}  ${explorerAccount(l.vault)}`);
    });

  program
    .command("settle")
    .description("Settle a final week or the season (anyone can)")
    .requiredOption("--league <n>", "league id")
    .option("--week <n>")
    .option("--season")
    .option("--as <account>")
    .action(async (o) => {
      const key = keyFrom(o);
      console.log(`Settling ${L.keyLabel(key)} of league ${o.league}: asking the OutLayer enclave…`);
      const { txHash, settlement } = await L.settle(signer(o.as), Number(o.league), key);
      console.log(`✓ ${explorerTx(txHash)}`);
      printSettlement(settlement);
    });

  program
    .command("finalize")
    .description("Pay what's on hold once the hold window is over (anyone can)")
    .requiredOption("--league <n>", "league id")
    .option("--week <n>")
    .option("--season")
    .option("--as <account>")
    .action(async (o) => {
      const key = keyFrom(o);
      const r = await L.finalize(signer(o.as), Number(o.league), key);
      console.log(`✓ ${explorerTx(r.txHash)}`);
      printSettlement(r.settlement);
    });

  program
    .command("status")
    .description("Show a league: pot, teams and settlements")
    .requiredOption("--league <n>", "league id")
    .action(async (o) => {
      const id = Number(o.league);
      const l = await L.view<Record<string, any>>("get_league", { league_id: id });
      if (!l) throw new Error(`no league ${id}`);
      const pot = l.vault ? await L.ftBalance(l.vault) : 0n;
      console.log(`League ${id}: ${l.name} (Sleeper ${l.sleeper_league_id}, ${l.season}) ${l.status}${l.is_demo ? " demo" : ""}`);
      console.log(`  commissioner ${l.commissioner}  vault ${l.vault}`);
      console.log(`  pot ${dollars(pot)} · ${l.paid_count} of ${l.team_count} paid · dues ${dollars(l.dues)} · weekly ${dollars(l.weekly_amount)} · on hold ${dollars(l.on_hold_total)}`);
      const teams = await L.view<any[]>("get_teams", { league_id: id });
      for (const t of teams) {
        const claim = typeof t.claim === "string" ? t.claim : `Pending(${t.claim.Pending})`;
        console.log(`  roster ${String(t.roster_id).padStart(2)} ${claim.padEnd(10)} ${t.account ?? ""} paid ${dollars(t.dues_paid)}`);
      }
      const ss = await L.view<any[]>("get_settlements", { league_id: id });
      for (const s of ss) {
        console.log(`  ${L.keyLabel(s.key)}:`);
        printSettlement(s);
      }
    });

  program
    .command("claim")
    .description("Claim a team")
    .requiredOption("--league <n>").requiredOption("--roster <n>").requiredOption("--as <account>")
    .action(async (o) => console.log(`✓ ${explorerTx((await L.claim(signer(o.as), Number(o.league), Number(o.roster))).txHash)}`));

  program
    .command("approve")
    .description("Approve a team claim (commissioner)")
    .requiredOption("--league <n>").requiredOption("--roster <n>").option("--as <account>")
    .action(async (o) => console.log(`✓ ${explorerTx((await L.approve(signer(o.as), Number(o.league), Number(o.roster))).txHash)}`));

  program
    .command("pay")
    .description("Pay dues for a team (ft_transfer_call)")
    .requiredOption("--league <n>").requiredOption("--roster <n>").requiredOption("--amount <usd>").requiredOption("--as <account>")
    .action(async (o) => console.log(`✓ ${explorerTx((await L.payDues(signer(o.as), Number(o.league), Number(o.roster), parseDollars(o.amount))).txHash)}`));

  program
    .command("mint")
    .description("Mint Test USDC (max 500 per account per day)")
    .requiredOption("--to <account>").requiredOption("--amount <usd>").option("--as <account>")
    .action(async (o) => console.log(`✓ ${explorerTx((await L.mint(signer(o.as), o.to, parseDollars(o.amount))).txHash)}`));
}
