// Seeds a demo league (SPEC 5.8): a completed Sleeper season, 12 teams claimed, approved and paid
// by fresh testnet accounts, 60-second hold window. Used by `pnpm commish demo-seed` and the
// Worker's admin-only /demo/reset.
//
// The team accounts' keys are generated here and thrown away after seeding: they only sign
// their own claim and dues payment.
import { Account, actions, KeyPair, type JsonRpcProvider, type KeyPairString } from "near-api-js";
import { createDeposit, settleDeposit, TGAS, type Config, type Settlement } from "./contract.js";
import { sleeperGet, type SleeperLeague, type SleeperRoster } from "./sleeper.js";

export interface SeedOptions {
  root: Account;
  provider: JsonRpcProvider;
  contractId: string;
  usdcId: string;
  sleeperLeagueId: string;
  /** Weeks to settle and pay right away so the feed isn't empty. */
  preSettleWeeks?: number[];
  log?: (line: string) => void;
}

const TEAM_NEAR = 150_000_000_000_000_000_000_000n; // 0.15: one claim and one payment
const TOKEN_STORAGE = 1_250_000_000_000_000_000_000n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(a: Account, contractId: string, methodName: string, args: Record<string, unknown>, deposit = 0n, gas = 100n * TGAS) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await a.callFunctionRaw({ contractId, methodName, args, deposit, gas, waitUntil: "EXECUTED_OPTIMISTIC" });
      const st = res.status as { SuccessValue?: string; Failure?: unknown };
      if (st.SuccessValue === undefined) throw new Error(`${methodName}: ${JSON.stringify(st.Failure).slice(0, 300)}`);
      return { tx: res.transaction.hash, value: st.SuccessValue ? JSON.parse(atob(st.SuccessValue) || "null") : null };
    } catch (e) {
      const msg = String(e);
      if (attempt < 4 && /nonce|Timeout|timed out|503|502|fetch failed/i.test(msg)) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
}

export async function seedDemoLeague(o: SeedOptions): Promise<{ leagueId: number; vault: string; teams: { roster_id: number; account: string }[] }> {
  const log = o.log ?? (() => {});
  const view = <T>(method: string, args: Record<string, unknown> = {}, contractId = o.contractId) =>
    o.provider.callFunction({ contractId, method, args }) as Promise<T>;
  const cfg = await view<Config>("get_config");
  const league = await sleeperGet<SleeperLeague | null>(`league/${o.sleeperLeagueId}`);
  if (!league) throw new Error(`Sleeper has no league ${o.sleeperLeagueId}`);
  const rosters = await sleeperGet<SleeperRoster[]>(`league/${o.sleeperLeagueId}/rosters`);

  // 1. The league and its vault (60-second hold; only the demo admin may do this).
  const created = await call(o.root, o.contractId, "create_league", {
    args: {
      sleeper_league_id: league.league_id,
      season: league.season,
      name: league.name,
      rosters: rosters.map((r) => ({ roster_id: r.roster_id, sleeper_owner_id: r.owner_id })),
      dues: "50000000",
      weekly_amount: "5000000",
      regular_season_weeks: Math.max(1, (league.settings.playoff_week_start ?? 15) - 1),
      season_split_bps: [6000, 2500, 1500],
      hold_window_ns: "60000000000",
      withhold_unpaid: true,
      is_demo: true,
    },
  }, createDeposit(cfg), 300n * TGAS);
  const leagueId = Number(created.value);
  log(`league ${leagueId} created (tx ${created.tx})`);
  let vault = "";
  for (let i = 0; i < 60 && !vault; i++) {
    const l = await view<{ status: string; vault: string | null } | null>("get_league", { league_id: leagueId });
    if (l?.status === "Active") vault = l.vault!;
    else if (l?.status === "Failed") throw new Error("vault creation failed");
    else await sleep(2000);
  }
  if (!vault) throw new Error("vault didn't become active");
  log(`vault ${vault} is active`);

  // 2. One fresh account per team: created, funded, minted $50, claims its team.
  const tag = Date.now().toString(36).slice(-5);
  const teams: { roster_id: number; account: Account }[] = [];
  for (const r of rosters) {
    const id = `t${r.roster_id}-${tag}.${o.root.accountId}`;
    const kp = KeyPair.fromRandom("ed25519");
    await o.root.signAndSendTransaction({
      receiverId: id,
      actions: [actions.createAccount(), actions.transfer(TEAM_NEAR), actions.addFullAccessKey(kp.getPublicKey())],
      waitUntil: "EXECUTED_OPTIMISTIC",
    });
    const acct = new Account(id, o.provider, kp.toString() as KeyPairString);
    await call(o.root, o.usdcId, "mint", { account_id: id, amount: "50000000" }, 10_000_000_000_000_000_000_000n, 30n * TGAS);
    await call(acct, o.contractId, "claim_team", { league_id: leagueId, roster_id: r.roster_id }, 0n, 30n * TGAS);
    teams.push({ roster_id: r.roster_id, account: acct });
    log(`team ${r.roster_id}: ${id} claimed`);
  }

  // 3. The commissioner (root) approves every claim; each team pays its dues.
  for (const t of teams) {
    await call(o.root, o.contractId, "approve_claim", { league_id: leagueId, roster_id: t.roster_id, account: t.account.accountId }, TOKEN_STORAGE, 200n * TGAS);
    await call(t.account, o.usdcId, "ft_transfer_call", {
      receiver_id: o.contractId, amount: "50000000", msg: JSON.stringify({ league_id: leagueId, roster_id: t.roster_id }),
    }, 1n, 100n * TGAS);
    log(`team ${t.roster_id}: approved and paid`);
  }

  // 4. Settle a couple of weeks so the feed has receipts, then pay them out after the hold.
  for (const w of o.preSettleWeeks ?? []) {
    await call(o.root, o.contractId, "settle", { league_id: leagueId, key: { Week: w } }, settleDeposit(cfg), 300n * TGAS);
    let s: Settlement | null = null;
    for (let i = 0; i < 60; i++) {
      s = await view<Settlement | null>("get_settlement", { league_id: leagueId, key: { Week: w } });
      if (s && !["Requested", "Computed"].includes(s.status) && !s.payouts.some((p) => p.status === "Pending")) break;
      await sleep(3000);
    }
    log(`week ${w}: ${s?.status}${s?.error ? ` (${s.error})` : ""}`);
  }
  if ((o.preSettleWeeks ?? []).length) {
    await sleep(62_000);
    for (const w of o.preSettleWeeks!) {
      await call(o.root, o.contractId, "finalize", { league_id: leagueId, key: { Week: w } }, 0n, 300n * TGAS).catch((e) => log(`finalize week ${w}: ${e}`));
      log(`week ${w}: finalized`);
    }
  }
  return { leagueId, vault, teams: teams.map((t) => ({ roster_id: t.roster_id, account: t.account.accountId })) };
}
