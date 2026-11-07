// When can a week be settled? A UI-side copy of crates/settle-core/src/finality.rs, used only to
// enable the Settle button. The enclave decides for real (WEEK_NOT_FINAL), so a disagreement
// can't pay anything; tests keep the two in step.

export interface NflState {
  season: string;
  season_type?: string;
  week?: number | null;
  leg?: number | null;
  season_start_date?: string | null;
}

const DAY_MS = 86_400_000;
export const CORRECTION_BUFFER_MS = 36 * 3_600_000;

/** Ms since epoch of 00:00 UTC on the Tuesday after week `week`. */
export function tuesdayAfterWeekMs(seasonStartDate: string, week: number): number | null {
  const m = seasonStartDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(start)) return null;
  let first = start + DAY_MS;
  while (new Date(first).getUTCDay() !== 2) first += DAY_MS;
  return first + 7 * (week - 1) * DAY_MS;
}

export type Finality = { final: true } | { final: false; reason: string; finalAtMs?: number };

export function weekFinality(leagueStatus: string, season: string, week: number, state: NflState | null, nowMs: number): Finality {
  if (leagueStatus === "complete") return { final: true };
  if (!state) return { final: false, reason: "Waiting for the NFL schedule." };
  if (state.season !== season) return { final: false, reason: `The NFL is in the ${state.season} season.` };
  if (state.season_type !== "post") {
    const current = state.leg ?? state.week;
    if (current == null) return { final: false, reason: "Waiting for the NFL schedule." };
    if (current <= week) return { final: false, reason: `Week ${week} is still being played.` };
  }
  const tue = state.season_start_date ? tuesdayAfterWeekMs(state.season_start_date, week) : null;
  if (tue === null) return { final: false, reason: "Waiting for the NFL schedule." };
  const finalAtMs = tue + CORRECTION_BUFFER_MS;
  if (nowMs < finalAtMs) return { final: false, reason: "Waiting out stat corrections.", finalAtMs };
  return { final: true };
}
