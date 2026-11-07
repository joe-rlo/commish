#!/usr/bin/env node
// Builds fixtures/cases/*.json from the recorded Sleeper responses in fixtures/sleeper/.
//
// Each case is { name, description, input, fetched: [[url, json], ...], expect }.
// `expect` holds hand-checked facts (winners, amounts, error codes) and the source hash.
// The hash is computed HERE, in JavaScript, with RFC 8785 canonical JSON. settle-core
// (Rust) must reproduce it byte for byte, so this is a cross-implementation check.
//
// Run: node fixtures/build-cases.mjs
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rec = join(here, "sleeper", "armchair-2025");
const out = join(here, "cases");
mkdirSync(out, { recursive: true });

const API = "https://api.sleeper.app/v1";
const ID = "1197787383500648448";
const load = (p) => JSON.parse(readFileSync(join(rec, p), "utf8"));
const clone = (v) => structuredClone(v);

// RFC 8785: sorted keys (UTF-16 order, which is JS's default sort), no whitespace,
// numbers and strings exactly as JSON.stringify prints them.
function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
}
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const sourceHash = (fetched) => sha256(canonical(Object.fromEntries(fetched)));

const league = load("league.json");
const rosters = load("rosters.json");
const bracket = load("winners_bracket.json");
const week = (w) => load(`matchups/${w}.json`);

// Rules used by every case unless overridden: $5 weekly (6-decimal USDC), 14 weeks, 60/25/15.
const RULES = { weekly_amount: "5000000", regular_season_weeks: 14, season_split_bps: [6000, 2500, 1500] };
// 2026-01-15T00:00:00Z, well after the 2025 season.
const NOW = "1768435200000000000";

const urls = {
  league: `${API}/league/${ID}`,
  rosters: `${API}/league/${ID}/rosters`,
  matchups: (w) => `${API}/league/${ID}/matchups/${w}`,
  bracket: `${API}/league/${ID}/winners_bracket`,
  state: `${API}/state/nfl`,
};

const cases = [];
function add(name, description, input, fetched, expect) {
  // Only URLs the plan reads count toward the hash; extras would be ignored by settle-core.
  const planned = fetched.filter(([u]) => expect.planned_urls.includes(u));
  const e = { ...expect };
  if (!e.error) e.source_sha256 = sourceHash(planned);
  delete e.planned_urls;
  e.source_urls = expect.error ? undefined : expect.planned_urls;
  cases.push({ name, description, input, fetched, expect: JSON.parse(JSON.stringify(e)) });
}

const weekly = (w, rules = RULES, now = NOW) => ({
  sleeper_league_id: ID, season: "2025", kind: "weekly_high_score", week: w, rules, now_ns: now,
});
const season = (rules = RULES) => ({ sleeper_league_id: ID, season: "2025", kind: "season", rules, now_ns: NOW });
const weeklyFetch = (w, m = week(w), l = league) => [[urls.league, l], [urls.rosters, rosters], [urls.matchups(w), m]];
const weeklyPlan = (w) => [urls.league, urls.rosters, urls.matchups(w)];

// 1. Single winner, real data: week 1, roster 2 scored 170.02.
add("weekly-single-winner", "Real week 1 of the demo league: roster 2 wins alone with 170.02.",
  weekly(1), weeklyFetch(1),
  { planned_urls: weeklyPlan(1), payouts: [{ roster_id: 2, amount: "5000000" }],
    top_scores: [{ roster_id: 2, points_x100: 17002 }], score_count: 12 });

// 2. Two-way tie: roster 9 set to roster 2's 170.02.
{
  const m = clone(week(1));
  m.find((x) => x.roster_id === 9).points = 170.02;
  add("weekly-two-way-tie", "Rosters 2 and 9 tie at 170.02 and split $5 evenly.",
    weekly(1), weeklyFetch(1, m),
    { planned_urls: weeklyPlan(1),
      payouts: [{ roster_id: 2, amount: "2500000" }, { roster_id: 9, amount: "2500000" }],
      top_scores: [{ roster_id: 2, points_x100: 17002 }, { roster_id: 9, points_x100: 17002 }], score_count: 12 });
}

// 3. Three-way tie with rounding dust: 5000000 / 3 = 1666666, dust 2 stays in the pot.
{
  const m = clone(week(1));
  for (const r of [9, 11]) m.find((x) => x.roster_id === r).points = 170.02;
  add("weekly-three-way-tie-dust", "Rosters 2, 9 and 11 tie; each gets 1666666, 2 units of dust stay in the pot.",
    weekly(1), weeklyFetch(1, m),
    { planned_urls: weeklyPlan(1),
      payouts: [2, 9, 11].map((r) => ({ roster_id: r, amount: "1666666" })),
      top_scores: [2, 9, 11].map((r) => ({ roster_id: r, points_x100: 17002 })), score_count: 12 });
}

// 4. custom_points overrides points: the commissioner sets roster 5 to 199.99.
{
  const m = clone(week(1));
  m.find((x) => x.roster_id === 5).custom_points = 199.99;
  add("weekly-custom-points", "Roster 5 has custom_points 199.99 (a commissioner override) and wins over its 103.12 points.",
    weekly(1), weeklyFetch(1, m),
    { planned_urls: weeklyPlan(1), payouts: [{ roster_id: 5, amount: "5000000" }],
      top_scores: [{ roster_id: 5, points_x100: 19999 }], score_count: 12 });
}

// 5. Missing roster: roster 2 (the real winner) has no matchup entry, so it scores 0 and can't win.
{
  const m = clone(week(1)).filter((x) => x.roster_id !== 2);
  add("weekly-missing-roster", "Roster 2 is missing from week 1's matchups: it scores 0, can't win, and roster 9 (163.56) wins.",
    weekly(1), weeklyFetch(1, m),
    { planned_urls: weeklyPlan(1), payouts: [{ roster_id: 9, amount: "5000000" }],
      top_scores: [{ roster_id: 9, points_x100: 16356 }], score_count: 12,
      missing: [2] });
}

// 6. Past the regular season: week 15 is a playoff week (playoff_week_start = 15).
add("weekly-past-regular-season", "Week 15 is a playoff week, so it pays no weekly high score.",
  weekly(15), weeklyFetch(15), { planned_urls: [], error: "WEEK_OUT_OF_RANGE" });

// 7. Not final: the league is in season and the NFL is still in week 9.
{
  const l = { ...clone(league), status: "in_season" };
  const state = { week: 9, leg: 9, season: "2025", season_type: "regular", season_start_date: "2025-09-04",
    previous_season: "2024", display_week: 9, league_season: "2025", league_create_season: "2025", season_has_scores: true };
  add("weekly-not-final", "The league is in season and the NFL is in week 9, so week 9 isn't over.",
    weekly(9, RULES, "1762300800000000000"), [...weeklyFetch(9, week(9), l), [urls.state, state]],
    { planned_urls: [], error: "WEEK_NOT_FINAL" });

  // 8. Inside the 36-hour stat-correction buffer: week 8's Tuesday is 2025-10-28; final at 2025-10-29T12:00Z.
  add("weekly-inside-correction-window", "The NFL is past week 8, but it's 2025-10-29T11:59Z, inside the 36-hour buffer.",
    weekly(8, RULES, String(BigInt(Date.UTC(2025, 9, 29, 11, 59)) * 1000000n)),
    [...weeklyFetch(8, week(8), l), [urls.state, state]],
    { planned_urls: [], error: "WEEK_NOT_FINAL" });

  // 9. Final by the clock rule: one minute after the buffer ends.
  add("weekly-final-by-clock", "The NFL is in week 9 and it's 2025-10-29T12:01Z, so week 8 is final: roster 8 wins with 183.72.",
    weekly(8, RULES, String(BigInt(Date.UTC(2025, 9, 29, 12, 1)) * 1000000n)),
    [...weeklyFetch(8, week(8), l), [urls.state, state]],
    { planned_urls: [...weeklyPlan(8), urls.state], payouts: [{ roster_id: 8, amount: "5000000" }],
      top_scores: [{ roster_id: 8, points_x100: 18372 }], score_count: 12 });
}

// 10. Season with 1st, 2nd and 3rd from the real bracket: p=1 w=8 l=2, p=3 w=1.
const seasonFetch = (b = bracket, l = league) => [[urls.league, l], [urls.rosters, rosters], [urls.bracket, b]];
const seasonPlan = [urls.league, urls.rosters, urls.bracket];
add("season-three-places", "Real bracket: roster 8 is champion, roster 2 runner-up, roster 1 third.",
  season(), seasonFetch(),
  { planned_urls: seasonPlan, placements: [{ place: 1, roster_id: 8 }, { place: 2, roster_id: 2 }, { place: 3, roster_id: 1 }] });

// 11. No 3rd-place game: placements stop at 2nd (the contract moves 3rd's share to 1st).
add("season-no-third-place-game", "The bracket has no p=3 game, so only 1st and 2nd are placed.",
  season(), seasonFetch(clone(bracket).filter((g) => g.p !== 3)),
  { planned_urls: seasonPlan, placements: [{ place: 1, roster_id: 8 }, { place: 2, roster_id: 2 }] });

// 12. Winner takes all: only 1st is paid.
add("season-winner-takes-all", "A 100% split pays only the champion.",
  season({ ...RULES, season_split_bps: [10000] }), seasonFetch(),
  { planned_urls: seasonPlan, placements: [{ place: 1, roster_id: 8 }] });

// 13. Season not complete.
add("season-not-complete", "The league is still in season, so the season can't settle.",
  season(), seasonFetch(bracket, { ...clone(league), status: "in_season" }),
  { planned_urls: [], error: "SEASON_NOT_COMPLETE" });

// 14. Every real regular-season week of the demo league (weeks 1..14), for the CLI and the demo.
const realWinners = { 1: [2, 17002], 2: [2, 15808], 3: [8, 16644], 4: [7, 15172], 5: [10, 17406], 6: [11, 21054], 7: [11, 18854],
  8: [8, 18372], 9: [11, 21650], 10: [5, 19230], 11: [8, 14570], 12: [5, 18602], 13: [11, 18154], 14: [9, 15656] };
for (const [w, [r, p]] of Object.entries(realWinners)) {
  add(`demo-week-${String(w).padStart(2, "0")}`, `Real week ${w}: roster ${r} wins with ${(p / 100).toFixed(2)}.`,
    weekly(Number(w)), weeklyFetch(Number(w)),
    { planned_urls: weeklyPlan(Number(w)), payouts: [{ roster_id: r, amount: "5000000" }],
      top_scores: [{ roster_id: r, points_x100: p }], score_count: 12 });
}

// One top-level field per line; data stays compact so diffs stay readable.
const render = (c) => "{\n" + Object.entries(c).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n") + "\n}\n";
for (const c of cases) writeFileSync(join(out, `${c.name}.json`), render(c));
console.log(`wrote ${cases.length} cases to ${out}`);
