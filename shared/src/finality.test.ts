// Mirrors crates/settle-core/src/finality.rs tests.
import { describe, expect, it } from "vitest";
import { tuesdayAfterWeekMs, weekFinality, type NflState } from "./finality.js";

const at = (date: string, hour = 0) => Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);
const state = (week: number, start = "2026-09-09"): NflState => ({ season: "2026", season_type: "regular", week, leg: week, season_start_date: start });

describe("finality (UI copy of settle-core)", () => {
  it("finds the Tuesday after a week", () => {
    expect(tuesdayAfterWeekMs("2026-09-09", 1)).toBe(at("2026-09-15"));
    expect(tuesdayAfterWeekMs("2026-09-09", 9)).toBe(at("2026-11-10"));
    expect(tuesdayAfterWeekMs("2025-09-04", 1)).toBe(at("2025-09-09"));
    expect(tuesdayAfterWeekMs("2026-09-08", 1)).toBe(at("2026-09-15"));
    expect(tuesdayAfterWeekMs("bad", 1)).toBeNull();
  });
  it("complete leagues are final", () => expect(weekFinality("complete", "2025", 3, null, 0).final).toBe(true));
  it("in-season rules", () => {
    const s = state(9);
    expect(weekFinality("in_season", "2026", 9, s, at("2026-11-20")).final).toBe(false);
    expect(weekFinality("in_season", "2026", 8, s, at("2026-11-04", 11)).final).toBe(false);
    expect(weekFinality("in_season", "2026", 8, s, at("2026-11-04", 12)).final).toBe(true);
    expect(weekFinality("in_season", "2025", 8, s, at("2026-11-20")).final).toBe(false);
    expect(weekFinality("in_season", "2026", 8, null, 0).final).toBe(false);
  });
  it("leg wins over week; postseason counts as past", () => {
    expect(weekFinality("in_season", "2026", 9, { ...state(1), leg: 10 }, at("2026-12-31")).final).toBe(true);
    expect(weekFinality("in_season", "2026", 17, { ...state(1), leg: null, season_type: "post" }, at("2027-01-20")).final).toBe(true);
  });
});
