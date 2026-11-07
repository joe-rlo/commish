// Data hooks. The contract is the source of truth for money; Sleeper for names and avatars.
import { useQuery } from "@tanstack/react-query";
import { loadLeague, sleeperGet, SettleCore, type League, type NflState, type Settlement, type TeamInfo } from "@commish/shared";
import { commish, leagueMembers, nearBalance, usdcBalance, vault } from "./near";

/** How often to poll: fast while the enclave works, every 10 s while a payout is on hold. */
export function pollInterval(settlements: Settlement[] | undefined): number | false {
  if (!settlements) return false;
  if (settlements.some((s) => s.status === "Requested" || s.status === "Computed" || s.payouts.some((p) => p.status === "Pending"))) return 3000;
  if (settlements.some((s) => s.status === "OnHold")) return 10_000;
  return false;
}

export function useLeague(id: number | null) {
  return useQuery({
    queryKey: ["league", id],
    queryFn: () => commish.league(id!),
    enabled: id !== null && Number.isInteger(id),
    refetchInterval: (q) => ((q.state.data as League | null | undefined)?.status === "CreatingVault" ? 2000 : 15_000),
  });
}

export function useTeams(id: number | null) {
  return useQuery({ queryKey: ["teams", id], queryFn: () => commish.teams(id!), enabled: id !== null, refetchInterval: 15_000 });
}

export function useSettlements(id: number | null) {
  return useQuery({
    queryKey: ["settlements", id],
    queryFn: () => commish.settlements(id!),
    enabled: id !== null,
    refetchInterval: (q) => pollInterval(q.state.data as Settlement[] | undefined) || 30_000,
  });
}

export function usePot(vaultId: string | null | undefined, fast: boolean) {
  return useQuery({
    queryKey: ["pot", vaultId],
    queryFn: () => usdcBalance(vaultId!),
    enabled: !!vaultId,
    refetchInterval: fast ? 5000 : 15_000,
  });
}

export function useUsdc(accountId: string | null | undefined) {
  return useQuery({ queryKey: ["usdc", accountId], queryFn: () => usdcBalance(accountId!), enabled: !!accountId, refetchInterval: 15_000 });
}

export function useNear(accountId: string | null | undefined) {
  return useQuery({ queryKey: ["near", accountId], queryFn: () => nearBalance(accountId!), enabled: !!accountId });
}

export function useVaultMembers(vaultId: string | null | undefined) {
  return useQuery({
    queryKey: ["vault-members", vaultId],
    queryFn: async () => leagueMembers(await vault.policy(vaultId!)),
    enabled: !!vaultId,
    refetchInterval: 30_000,
  });
}

export function useProposal(vaultId: string | null | undefined, id: number | null | undefined, live: boolean) {
  return useQuery({
    queryKey: ["proposal", vaultId, id],
    queryFn: () => vault.proposal(vaultId!, id!),
    enabled: !!vaultId && id !== null && id !== undefined,
    refetchInterval: live ? 5000 : false,
  });
}

export function useConfig() {
  return useQuery({ queryKey: ["config"], queryFn: commish.config, staleTime: Infinity });
}

/** Sleeper league, users, rosters and team names (cached; public data). */
export function useSleeper(sleeperId: string | null | undefined) {
  return useQuery({ queryKey: ["sleeper", sleeperId], queryFn: () => loadLeague(sleeperId!), enabled: !!sleeperId, staleTime: 5 * 60_000 });
}

export function useNflState() {
  return useQuery({ queryKey: ["nfl-state"], queryFn: () => sleeperGet<NflState>("state/nfl"), staleTime: 10 * 60_000 });
}

export function teamName(teams: TeamInfo[] | undefined, rosterId: number): string {
  return teams?.find((t) => t.roster_id === rosterId)?.name ?? `Team ${rosterId}`;
}
export function teamAvatar(teams: TeamInfo[] | undefined, rosterId: number): string | null {
  return teams?.find((t) => t.roster_id === rosterId)?.avatar ?? null;
}

let corePromise: Promise<SettleCore> | null = null;
/** settle-core compiled to wasm, the same Rust code the enclave runs. */
export function loadCore(): Promise<SettleCore> {
  corePromise ??= fetch("/settle-core.wasm")
    .then((r) => {
      if (!r.ok) throw new Error("Couldn't load the settlement code.");
      return r.arrayBuffer();
    })
    .then((b) => SettleCore.load(b));
  return corePromise;
}
