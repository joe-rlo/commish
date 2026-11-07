// Reads from NEAR testnet (no wallet needed).
import { JsonRpcProvider } from "near-api-js";
import type { Config, Key, League, Settlement, Team } from "@commish/shared";
import { config } from "./config";

export const provider = new JsonRpcProvider({ url: config.rpcUrl });

export async function view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await provider.callFunction({ contractId, method, args })) as T;
}

export const commish = {
  config: () => view<Config>(config.contractId, "get_config"),
  league: (id: number) => view<League | null>(config.contractId, "get_league", { league_id: id }),
  teams: (id: number) => view<Team[]>(config.contractId, "get_teams", { league_id: id }),
  settlements: (id: number) => view<Settlement[]>(config.contractId, "get_settlements", { league_id: id }),
  settlement: (id: number, key: Key) => view<Settlement | null>(config.contractId, "get_settlement", { league_id: id, key }),
  latestDemo: () => view<League | null>(config.contractId, "latest_demo_league"),
  jobInput: (id: number, key: Key, nowNs: string) => view<string>(config.contractId, "job_input", { league_id: id, key, now_ns: nowNs }),
};

export async function usdcBalance(accountId: string): Promise<bigint> {
  try {
    return BigInt(await view<string>(config.usdcId, "ft_balance_of", { account_id: accountId }));
  } catch {
    return 0n;
  }
}

export async function nearBalance(accountId: string): Promise<bigint> {
  try {
    const a = (await provider.viewAccount({ accountId })) as unknown as { amount: string };
    return BigInt(a.amount);
  } catch {
    return 0n;
  }
}

export async function accountExists(accountId: string): Promise<boolean> {
  try {
    await provider.viewAccount({ accountId });
    return true;
  } catch {
    return false;
  }
}

export interface VaultPolicy {
  roles: { name: string; kind: { Group?: string[] } | string; permissions: string[] }[];
}
export interface VaultProposal {
  id: number;
  status: string;
  kind: unknown;
  votes: Record<string, "Approve" | "Reject" | "Remove">;
  vote_counts: Record<string, [string, string, string]>;
  submission_time: string;
}

export const vault = {
  policy: (vaultId: string) => view<VaultPolicy>(vaultId, "get_policy"),
  proposal: (vaultId: string, id: number) => view<VaultProposal>(vaultId, "get_proposal", { id }),
};

/** Members of the vault's `league` role (they can vote to stop a payout). */
export function leagueMembers(p: VaultPolicy): string[] {
  const role = p.roles.find((r) => r.name === "league");
  return role && typeof role.kind === "object" && role.kind.Group ? role.kind.Group : [];
}

/** Votes needed to stop a payout: a majority, and at least 2 (the vault's quorum). */
export function rejectThreshold(members: number): number {
  return Math.max(2, Math.min(Math.floor(members / 2) + 1, members));
}
