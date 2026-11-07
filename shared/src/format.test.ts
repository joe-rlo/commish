import { describe, expect, it } from "vitest";
import { countdown, dollars, holdWords, money, parseDollars, points, splitWords } from "./format.js";
import { keyId, parseKeyId } from "./contract.js";
import { parseLeagueInput, standings, teamsFrom } from "./sleeper.js";

describe("format", () => {
  it("dollars", () => {
    expect(dollars(5_000_000n)).toBe("$5.00");
    expect(dollars("600000000")).toBe("$600.00");
    expect(dollars(1_234_567_890n)).toBe("$1,234.57");
    expect(dollars(1_666_666n)).toBe("$1.67");
    expect(dollars(0)).toBe("$0.00");
    expect(dollars(50_000_000n, { cents: false })).toBe("$50");
  });
  it("money drops whole cents", () => {
    expect(money(600_000_000n)).toBe("$600");
    expect(money(5_500_000n)).toBe("$5.50");
  });
  it("parseDollars", () => {
    expect(parseDollars("50")).toBe(50_000_000n);
    expect(parseDollars("$5.5")).toBe(5_500_000n);
    expect(parseDollars("1,000.25")).toBe(1_000_250_000n);
    expect(parseDollars("abc")).toBeNull();
    expect(parseDollars("1.234")).toBeNull();
    expect(parseDollars("-5")).toBeNull();
  });
  it("points", () => {
    expect(points(16238)).toBe("162.38");
    expect(points(900)).toBe("9.00");
    expect(points(5)).toBe("0.05");
    expect(points(-151)).toBe("−1.51");
  });
  it("countdown", () => {
    expect(countdown(42_000)).toBe("0:42");
    expect(countdown(65_000)).toBe("1m 05s");
    expect(countdown(66_120_000)).toBe("18h 22m");
    expect(countdown(-5)).toBe("0:00");
  });
  it("words", () => {
    expect(holdWords(60_000_000_000n)).toBe("60 seconds");
    expect(holdWords(86_400_000_000_000n)).toBe("24 hours");
    expect(splitWords([6000, 2500, 1500])).toBe("60/25/15");
    expect(splitWords([10000])).toBe("winner takes all");
  });
});

describe("keys and Sleeper input", () => {
  it("settlement ids round-trip", () => {
    expect(keyId({ Week: 9 })).toBe("w9");
    expect(keyId("Season")).toBe("season");
    expect(parseKeyId("w9")).toEqual({ Week: 9 });
    expect(parseKeyId("season")).toBe("Season");
    expect(parseKeyId("x")).toBeNull();
  });
  it("league links", () => {
    expect(parseLeagueInput("1197787383500648448")).toBe("1197787383500648448");
    expect(parseLeagueInput("https://sleeper.com/leagues/1197787383500648448/matchup")).toBe("1197787383500648448");
    expect(parseLeagueInput(" https://sleeper.app/leagues/1197787383500648448 ")).toBe("1197787383500648448");
    expect(parseLeagueInput("https://example.com/leagues/1")).toBeNull();
    expect(parseLeagueInput("12/../../x")).toBeNull();
  });
  it("team names fall back to display names, and standings sort by record", () => {
    const teams = teamsFrom(
      [
        { roster_id: 2, owner_id: "b", settings: { wins: 9, losses: 5, fpts: 1890, fpts_decimal: 96 } },
        { roster_id: 1, owner_id: "a", settings: { wins: 10, losses: 4, fpts: 1855, fpts_decimal: 86 } },
        { roster_id: 3, owner_id: null, settings: { wins: 10, losses: 4, fpts: 1900, fpts_decimal: 0 } },
      ],
      [
        { user_id: "a", display_name: "alice", avatar: "abc", metadata: { team_name: "Shayshawn Sparkley" } },
        { user_id: "b", display_name: "bob", avatar: null, metadata: { team_name: " " } },
      ],
    );
    expect(teams.map((t) => t.name)).toEqual(["Shayshawn Sparkley", "bob", "Team 3"]);
    expect(teams[0]!.avatar).toBe("https://sleepercdn.com/avatars/thumbs/abc");
    expect(standings(teams).map((t) => t.roster_id)).toEqual([3, 1, 2]);
  });
});
