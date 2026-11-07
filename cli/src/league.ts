// Programmatic access to the commish contract, shared by the CLI commands, e2e and demo seeding.
import type { Account } from "near-api-js";
import { config } from "./config.js";
import { provider } from "./keys.js";
import { sleep } from "./util.js";

export const TGAS = 1_000_000_000_000n;
export const TOKEN_STORAGE = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR
export const SETTLE_DEPOSIT = 30_000_000_000_000_000_000_000n; // 0.03 NEAR
export const LEAGUE_STORAGE = 50_000_000_000_000_000_000_000n; // 0.05 NEAR
export const SLEEPER = "https://api.sleeper.app/v1";

export type Key = { Week: number } | "Season";
export const keyLabel = (k: Key) => (k === "Season" ? "Season" : `Week ${k.Week}`);

export async function view<T = unknown>(method: string, args: Record<string, unknown> = {}, contractId = config.contractId): Promise<T> {
  return (await provider().callFunction({ contractId, method, args })) as T;
}

export interface SleeperLeague {
  league_id: string;
  name: string;
  season: string;
  status: string;
  sport: string;
  total_rosters: number;
  settings: { playoff_week_start?: number };
}

export async function sleeperJson<T>(path: string): Promise<T> {
  const r = await fetch(`${SLEEPER}/${path}`);
  if (!r.ok) throw new Error(`Sleeper ${path}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

export interface CreateOptions {
  sleeperLeagueId: string;
  dues: bigint;
  weekly: bigint;
  split: number[]; // percent, e.g. [60, 25, 15]
  holdNs: bigint;
  withholdUnpaid?: boolean;
  isDemo?: boolean;
}

/** Reads the league from Sleeper and creates it on chain. Returns the new league id. */
export async function createLeague(commissioner: Account, o: CreateOptions): Promise<{ leagueId: number; txHash: string }> {
  const league = await sleeperJson<SleeperLeague | null>(`league/${o.sleeperLeagueId}`);
  if (!league) throw new Error(`Sleeper has no league ${o.sleeperLeagueId}`);
  if (league.sport !== "nfl") throwErr("not an NFL league");
  const rosters = await sleeperJson<{ roster_id: number; owner_id: string | null }[]>(`league/${o.sleeperLeagueId}/rosters`);
  const pws = league.settings.playoff_week_start ?? 15;
  const cfg = await view<{ vault_deposit: string; token_storage_deposit: string }>("get_config");
  const deposit = BigInt(cfg.vault_deposit) + BigInt(cfg.token_storage_deposit) + LEAGUE_STORAGE;
  const args = {
    sleeper_league_id: league.league_id,
    season: league.season,
    name: league.name,
    rosters: rosters.map((r) => ({ roster_id: r.roster_id, sleeper_owner_id: r.owner_id })),
    dues: o.dues.toString(),
    weekly_amount: o.weekly.toString(),
    regular_season_weeks: Math.max(1, pws - 1),
    season_split_bps: o.split.map((p) => Math.round(p * 100)),
    hold_window_ns: o.holdNs.toString(),
    withhold_unpaid: o.withholdUnpaid ?? true,
    is_demo: o.isDemo ?? false,
  };
  const res = await commissioner.callFunctionRaw({
    contractId: config.contractId, methodName: "create_league", args: { args },
    deposit, gas: 300n * TGAS, waitUntil: "FINAL",
  });
  const status = res.status as { SuccessValue?: string; Failure?: unknown };
  if (status.SuccessValue === undefined) throw new Error(`create_league failed: ${JSON.stringify(status.Failure)}`);
  const leagueId = Number(JSON.parse(Buffer.from(status.SuccessValue, "base64").toString()));
  // The vault is created in a later receipt of the same transaction; wait for it.
  for (let i = 0; i < 60; i++) {
    const l = await view<{ status: string } | null>("get_league", { league_id: leagueId });
    if (l?.status === "Active") return { leagueId, txHash: res.transaction.hash };
    if (l?.status === "Failed") throw new Error(`vault creation failed for league ${leagueId}; tx ${res.transaction.hash}`);
    await sleep(2000);
  }
  throw new Error(`league ${leagueId} didn't become active`);
}

function throwErr(m: string): never {
  throw new Error(m);
}

export async function call(who: Account, method: string, args: Record<string, unknown>, deposit = 0n, gas = 100n * TGAS, contractId = config.contractId) {
  const res = await who.callFunctionRaw({ contractId, methodName: method, args, deposit, gas, waitUntil: "FINAL" });
  const status = res.status as { SuccessValue?: string; Failure?: unknown };
  if (status.SuccessValue === undefined) throw new Error(`${method} failed: ${JSON.stringify(status.Failure)}`);
  const failures = res.receipts_outcome.filter((r) => "Failure" in (r.outcome.status as object));
  return { txHash: res.transaction.hash, failures, value: status.SuccessValue ? JSON.parse(Buffer.from(status.SuccessValue, "base64").toString() || "null") : null };
}

export const claim = (who: Account, leagueId: number, rosterId: number) => call(who, "claim_team", { league_id: leagueId, roster_id: rosterId });
export const approve = (commissioner: Account, leagueId: number, rosterId: number) =>
  call(commissioner, "approve_claim", { league_id: leagueId, roster_id: rosterId }, TOKEN_STORAGE, 200n * TGAS);

export async function mint(payer: Account, to: string, amount: bigint) {
  return call(payer, "mint", { account_id: to, amount: amount.toString() }, 10_000_000_000_000_000_000_000n, 30n * TGAS, config.usdcId);
}

export async function payDues(member: Account, leagueId: number, rosterId: number, amount: bigint) {
  return call(
    member, "ft_transfer_call",
    { receiver_id: config.contractId, amount: amount.toString(), msg: JSON.stringify({ league_id: leagueId, roster_id: rosterId }) },
    1n, 150n * TGAS, config.usdcId,
  );
}

export interface SettlementView {
  key: Key;
  status: "Requested" | "Computed" | "OnHold" | "Final" | "Failed";
  hold_ends_at_ns: string | null;
  attestation_ref: string | null;
  result_sha256: string | null;
  source_sha256: string | null;
  error: string | null;
  payouts: { roster_id: number; account: string | null; amount: string; status: string; withheld_reason: string | null; proposal_id: number | null; place: number | null }[];
  scores: { roster_id: number; points_x100: number; missing: boolean }[];
  placements: { place: number; roster_id: number }[];
}

export async function getSettlement(leagueId: number, key: Key) {
  return view<SettlementView | null>("get_settlement", { league_id: leagueId, key });
}

/** Sends `settle` and waits for the enclave's answer to land (yield/resume finishes later than the tx). */
export async function settle(caller: Account, leagueId: number, key: Key, timeoutMs = 300_000): Promise<{ txHash: string; settlement: SettlementView }> {
  const res = await caller.callFunctionRaw({
    contractId: config.contractId, methodName: "settle", args: { league_id: leagueId, key },
    deposit: SETTLE_DEPOSIT, gas: 300n * TGAS, waitUntil: "INCLUDED_FINAL",
  });
  const txHash = res.transaction.hash;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = await getSettlement(leagueId, key);
    if (s && !["Requested", "Computed"].includes(s.status) && !s.payouts.some((p) => p.status === "Pending")) {
      return { txHash, settlement: s };
    }
    await sleep(3000);
  }
  throw new Error(`settlement for ${keyLabel(key)} didn't finish in time; tx ${txHash}`);
}

export async function finalize(caller: Account, leagueId: number, key: Key) {
  const r = await call(caller, "finalize", { league_id: leagueId, key }, 0n, 300n * TGAS);
  // The payout votes run in later receipts; wait for the record to close.
  for (let i = 0; i < 30; i++) {
    const s = await getSettlement(leagueId, key);
    if (s && s.status !== "OnHold") return { ...r, settlement: s };
    await sleep(2000);
  }
  return { ...r, settlement: await getSettlement(leagueId, key) };
}

export async function ftBalance(accountId: string): Promise<bigint> {
  return BigInt(await view<string>("ft_balance_of", { account_id: accountId }, config.usdcId));
}
