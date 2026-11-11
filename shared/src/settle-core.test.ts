// The browser build of settle-core (crates/settle-wasm) against the same fixtures as the
// Rust tests, and against a real enclave result from testnet.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { checkMath } from "./check-math.js";
import type { Settlement } from "./contract.js";
import { runJob, SettleCore, sha256Hex, type JobInput } from "./settle-core.js";

const repo = join(import.meta.dirname, "..", "..");
// Honors CARGO_TARGET_DIR, as cargo does.
const wasmPath = resolve(repo, process.env.CARGO_TARGET_DIR ?? "target", "wasm32-unknown-unknown/release/settle_wasm.wasm");
let core: SettleCore;

beforeAll(async () => {
  if (!existsSync(wasmPath) || process.env.REBUILD_WASM) {
    execFileSync("cargo", ["build", "-q", "--release", "--target", "wasm32-unknown-unknown", "-p", "settle-wasm"], { cwd: repo, stdio: "inherit" });
  }
  core = await SettleCore.load(readFileSync(wasmPath));
}, 300_000);

interface Case {
  name: string;
  input: JobInput;
  fetched: [string, unknown][];
  expect: Record<string, any>;
}
const cases: Case[] = readdirSync(join(repo, "fixtures/cases"))
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(repo, "fixtures/cases", f), "utf8")));

describe("settle-core in wasm", () => {
  it("reports its version", () => expect(core.version()).toBe("1.0.0"));

  it("has the full case set", () => expect(cases.length).toBeGreaterThanOrEqual(20));

  for (const c of cases) {
    it(c.name, () => {
      const out = JSON.parse(core.run(c.input, c.fetched, null));
      if (c.expect.error) {
        expect(out.error.code).toBe(c.expect.error);
        expect(out.payouts).toEqual([]);
        return;
      }
      expect(out.error).toBeUndefined();
      expect(out.source.sha256).toBe(c.expect.source_sha256);
      expect(out.source.urls).toEqual(c.expect.source_urls);
      if (out.kind === "weekly_high_score") {
        expect(out.payouts).toEqual(c.expect.payouts);
        expect(out.scores).toHaveLength(c.expect.score_count);
        c.expect.top_scores.forEach((t: any, i: number) => expect(out.scores[i]).toMatchObject(t));
      } else {
        expect(out.placements).toEqual(c.expect.placements);
      }
    });
  }

  it("plans the same URLs as the cases", () => {
    for (const c of cases.filter((x) => !x.expect.error)) {
      const plan = [...core.initialUrls(c.input), ...core.followupUrls(c.input, c.fetched[0]![1])];
      expect(plan).toEqual(c.expect.source_urls);
    }
  });

  it("reproduces a real enclave result from testnet byte for byte", async () => {
    const t = JSON.parse(readFileSync(join(repo, "fixtures/testnet/league0-week3.json"), "utf8"));
    expect(await sha256Hex(t.input_text)).toBe(t.input_sha256);
    const rec = join(repo, "fixtures/sleeper/armchair-2025");
    const api = "https://api.sleeper.app/v1/league/1197787383500648448";
    const recorded: Record<string, unknown> = {
      [api]: JSON.parse(readFileSync(join(rec, "league.json"), "utf8")),
      [`${api}/rosters`]: JSON.parse(readFileSync(join(rec, "rosters.json"), "utf8")),
      [`${api}/matchups/3`]: JSON.parse(readFileSync(join(rec, "matchups/3.json"), "utf8")),
    };
    const { text } = await runJob(core, JSON.parse(t.input_text), async (u) => recorded[u], t.request_id);
    expect(await sha256Hex(text)).toBe(t.result_sha256);

    // And checkMath says so.
    const settlement = {
      input_sha256: t.input_sha256, result_sha256: t.result_sha256, attestation_ref: t.request_id, source_sha256: t.source_sha256,
      scores: JSON.parse(text).scores.map((s: any) => ({ ...s, missing: !!s.missing })),
      payouts: [{ roster_id: 8, amount: "5000000" }], placements: [],
    } as unknown as Settlement;
    const r = await checkMath(core, settlement, t.input_text, async (u) => recorded[u]);
    expect(r).toMatchObject({ matches: true, inputOk: true, resultOk: true, sourceOk: true, diffs: [] });

    // A stat correction shows up as a diff, not a silent pass.
    const corrected = structuredClone(recorded);
    const week = corrected[`${api}/matchups/3`] as { roster_id: number; points: number }[];
    week.find((m) => m.roster_id === 5)!.points = 170.0;
    const r2 = await checkMath(core, settlement, t.input_text, async (u) => corrected[u]);
    expect(r2.matches).toBe(false);
    expect(r2.sourceOk).toBe(false);
    expect(r2.diffs.join("\n")).toContain("Team 5: 159.22 on the receipt, 170.00 on Sleeper now");
    expect(r2.diffs.join("\n")).toContain("Winners: 8:5000000 on the receipt, 5:5000000 now");
  });

  it("canonicalizes like JSON.stringify with sorted keys", () => {
    expect(core.canonical({ b: 9.0, a: [0.5, 1e21, "é"] })).toBe('{"a":[0.5,1e+21,"é"],"b":9}');
  });
});
