// Types of the commish contract's views (contracts/commish/src/types.rs), and keys.

export type ClaimStatus = "Unclaimed" | "Approved" | { Pending: string };
export type Key = { Week: number } | "Season";
export type SettlementStatus = "Requested" | "Computed" | "OnHold" | "Final" | "Failed";
export type PayoutStatus = "Pending" | "OnHold" | "Paid" | "Stopped" | "Withheld" | "Failed";

export interface League {
  id: number;
  sleeper_league_id: string;
  season: string;
  name: string;
  commissioner: string;
  vault: string | null;
  token: string;
  dues: string;
  weekly_amount: string;
  regular_season_weeks: number;
  season_split_bps: number[];
  hold_window_ns: string;
  withhold_unpaid: boolean;
  rules_locked: boolean;
  is_demo: boolean;
  status: "CreatingVault" | "Active" | "Failed";
  created_at_ns: string;
  dues_total: string;
  on_hold_total: string;
  settlement_keys: Key[];
  team_count: number;
  paid_count: number;
  approved_count: number;
  pending_claims: number;
}

export interface Team {
  roster_id: number;
  sleeper_owner_id: string | null;
  account: string | null;
  claim: ClaimStatus;
  dues_paid: string;
}

export interface Payout {
  roster_id: number;
  place: number | null;
  account: string | null;
  amount: string;
  status: PayoutStatus;
  withheld_reason: "no_account" | "dues_unpaid" | "pot_too_small" | null;
  proposal_id: number | null;
}

export interface Settlement {
  league_id?: number;
  key: Key;
  status: SettlementStatus;
  requested_by: string;
  requested_at_ns: string;
  input_sha256: string;
  result_sha256: string | null;
  attestation_ref: string | null;
  source_sha256: string | null;
  source_urls: string[];
  scores: { roster_id: number; points_x100: number; missing: boolean }[];
  placements: { place: number; roster_id: number }[];
  payouts: Payout[];
  pot_balance: string | null;
  payout_base: string | null;
  created_at_ns: string | null;
  hold_ends_at_ns: string | null;
  finalized_at_ns: string | null;
  error: string | null;
}

export interface Config {
  outlayer_id: string;
  job_wasm_url: string;
  job_wasm_sha256: string;
  job_build_target: string;
  core_version: string;
  sputnik_factory_id: string;
  default_token_id: string;
  vault_name_prefix: string;
  vault_deposit: string;
  token_storage_deposit: string;
  outlayer_deposit: string;
  settle_storage_deposit: string;
  demo_admin: string | null;
}

/** URL-safe settlement id: `w3`, `season`. */
export const keyId = (k: Key): string => (k === "Season" ? "season" : `w${k.Week}`);
export function parseKeyId(id: string): Key | null {
  if (id === "season") return "Season";
  const m = id.match(/^w(\d{1,2})$/);
  return m ? { Week: Number(m[1]) } : null;
}
export const keyTitle = (k: Key): string => (k === "Season" ? "Season payout" : `Week ${k.Week} high score`);
export const sameKey = (a: Key, b: Key) => keyId(a) === keyId(b);

export const isPending = (c: ClaimStatus): c is { Pending: string } => typeof c === "object" && "Pending" in c;
export const claimant = (t: Team): string | null => (isPending(t.claim) ? t.claim.Pending : t.account);

/** Settlement deposit the contract requires (outlayer + storage), in yoctoNEAR. */
export const settleDeposit = (c: Config) => BigInt(c.outlayer_deposit) + BigInt(c.settle_storage_deposit);
export const LEAGUE_STORAGE = 50_000_000_000_000_000_000_000n;
export const createDeposit = (c: Config) => BigInt(c.vault_deposit) + BigInt(c.token_storage_deposit) + LEAGUE_STORAGE;
export const TGAS = 1_000_000_000_000n;
