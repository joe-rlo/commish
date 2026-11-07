// Sleeper's public API (read-only, no key, CORS open). Display data only; settlement data
// goes through settle-core.

export const SLEEPER_API = "https://api.sleeper.app/v1";

export interface SleeperLeague {
  league_id: string;
  name: string;
  season: string;
  status: "pre_draft" | "drafting" | "in_season" | "complete" | string;
  sport: string;
  avatar: string | null;
  total_rosters: number;
  settings: { playoff_week_start?: number; [k: string]: unknown };
}
export interface SleeperUser {
  user_id: string;
  display_name: string;
  avatar: string | null;
  metadata?: { team_name?: string; avatar?: string; [k: string]: unknown };
}
export interface SleeperRoster {
  roster_id: number;
  owner_id: string | null;
  settings?: { wins?: number; losses?: number; ties?: number; fpts?: number; fpts_decimal?: number };
}

export interface TeamInfo {
  roster_id: number;
  name: string;
  owner: string | null;
  avatar: string | null;
  wins: number;
  losses: number;
  ties: number;
  points_for_x100: number;
}

/** Accepts `https://sleeper.com/leagues/<id>/...`, `https://sleeper.app/leagues/<id>` or a bare id. */
export function parseLeagueInput(s: string): string | null {
  const t = s.trim();
  if (/^\d{6,32}$/.test(t)) return t;
  const m = t.match(/sleeper\.(?:com|app)\/leagues\/(\d{6,32})/i);
  return m ? m[1]! : null;
}

export const avatarUrl = (id: string | null | undefined, thumb = true): string | null =>
  id ? (id.startsWith("http") ? id : `https://sleepercdn.com/avatars/${thumb ? "thumbs/" : ""}${id}`) : null;

export async function sleeperGet<T>(path: string): Promise<T> {
  const r = await fetch(`${SLEEPER_API}/${path}`);
  const text = await r.text();
  if (r.status === 404 && text.trim() === "null") return null as T;
  if (!r.ok) throw new Error(`Sleeper answered HTTP ${r.status}`);
  return JSON.parse(text) as T;
}

/** Team names: `metadata.team_name`, falling back to the owner's `display_name`. */
export function teamsFrom(rosters: SleeperRoster[], users: SleeperUser[]): TeamInfo[] {
  return rosters
    .map((r) => {
      const u = users.find((x) => x.user_id === r.owner_id);
      const name = (u?.metadata?.team_name ?? "").trim() || u?.display_name || `Team ${r.roster_id}`;
      return {
        roster_id: r.roster_id,
        name,
        owner: u?.display_name ?? null,
        avatar: avatarUrl(u?.metadata?.avatar ?? u?.avatar ?? null),
        wins: r.settings?.wins ?? 0,
        losses: r.settings?.losses ?? 0,
        ties: r.settings?.ties ?? 0,
        points_for_x100: (r.settings?.fpts ?? 0) * 100 + (r.settings?.fpts_decimal ?? 0),
      };
    })
    .sort((a, b) => a.roster_id - b.roster_id);
}

export async function loadLeague(id: string) {
  const [league, users, rosters] = await Promise.all([
    sleeperGet<SleeperLeague | null>(`league/${id}`),
    sleeperGet<SleeperUser[] | null>(`league/${id}/users`),
    sleeperGet<SleeperRoster[] | null>(`league/${id}/rosters`),
  ]);
  if (!league) return null;
  return { league, users: users ?? [], rosters: rosters ?? [], teams: teamsFrom(rosters ?? [], users ?? []) };
}

/** Projected season places by current standings: wins, then points for. */
export function standings(teams: TeamInfo[]): TeamInfo[] {
  return [...teams].sort((a, b) => b.wins - a.wins || a.losses - b.losses || b.points_for_x100 - a.points_for_x100);
}
