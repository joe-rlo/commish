// Writes. Every one goes through the signer (quick account or wallet).
import { createDeposit, settleDeposit, TGAS, type Config, type Key, type Settlement } from "@commish/shared";
import type { Signer } from "./auth";
import { config } from "./config";
import { commish, vault } from "./near";

const TOKEN_STORAGE = 1_250_000_000_000_000_000_000n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Asks the enclave to settle a week or the season. Returns once the request is on chain; the
 *  result lands a few seconds later (the page polls). */
export async function settle(signer: Signer, cfg: Config, leagueId: number, key: Key) {
  return signer.call({ contractId: config.contractId, method: "settle", args: { league_id: leagueId, key }, deposit: settleDeposit(cfg), gas: 300n * TGAS });
}

export async function finalize(signer: Signer, leagueId: number, key: Key) {
  return signer.call({ contractId: config.contractId, method: "finalize", args: { league_id: leagueId, key }, gas: 300n * TGAS });
}

/** A league member votes to stop a payout during its hold window. */
export async function holdPayout(signer: Signer, vaultId: string, proposalId: number) {
  const p = await vault.proposal(vaultId, proposalId);
  return signer.call({
    contractId: vaultId,
    method: "act_proposal",
    args: { id: proposalId, action: "VoteReject", proposal: p.kind, memo: "Hold this payout (Commish)" },
    gas: 150n * TGAS,
  });
}

export const claim = (signer: Signer, leagueId: number, rosterId: number) =>
  signer.call({ contractId: config.contractId, method: "claim_team", args: { league_id: leagueId, roster_id: rosterId } });

export const approve = (signer: Signer, leagueId: number, rosterId: number) =>
  signer.call({ contractId: config.contractId, method: "approve_claim", args: { league_id: leagueId, roster_id: rosterId }, deposit: TOKEN_STORAGE, gas: 200n * TGAS });

export const decline = (signer: Signer, leagueId: number, rosterId: number) =>
  signer.call({ contractId: config.contractId, method: "decline_claim", args: { league_id: leagueId, roster_id: rosterId } });

/** Pays dues with ft_transfer_call. The payment credits the team, whoever pays. */
export const payDues = (signer: Signer, leagueId: number, rosterId: number, amount: bigint) =>
  signer.call({
    contractId: config.usdcId,
    method: "ft_transfer_call",
    args: { receiver_id: config.contractId, amount: amount.toString(), msg: JSON.stringify({ league_id: leagueId, roster_id: rosterId }) },
    deposit: 1n,
    gas: 150n * TGAS,
  });

export interface CreateArgs {
  sleeper_league_id: string;
  season: string;
  name: string;
  rosters: { roster_id: number; sleeper_owner_id: string | null }[];
  dues: string;
  weekly_amount: string;
  regular_season_weeks: number;
  season_split_bps: number[];
  hold_window_ns: string;
  withhold_unpaid: boolean;
  is_demo: boolean;
}

export async function createLeague(signer: Signer, cfg: Config, args: CreateArgs): Promise<{ leagueId: number; txHash: string }> {
  const r = await signer.call({ contractId: config.contractId, method: "create_league", args: { args }, deposit: createDeposit(cfg), gas: 300n * TGAS });
  return { leagueId: Number(r.value), txHash: r.txHash };
}

/** Waits until a settlement leaves Requested/Computed (the yield resumes after the tx is final). */
export async function waitForSettlement(leagueId: number, key: Key, timeoutMs = 180_000): Promise<Settlement | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = await commish.settlement(leagueId, key);
    if (s && !["Requested", "Computed"].includes(s.status) && !s.payouts.some((p) => p.status === "Pending")) return s;
    await sleep(2500);
  }
  return null;
}
