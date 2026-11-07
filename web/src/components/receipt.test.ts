import { describe, expect, it } from "vitest";
import type { Payout, Settlement } from "@commish/shared";
import { failureWords, ordinal, payoutStamp } from "./Receipt";
import { pollInterval } from "../lib/queries";
import { rejectThreshold } from "../lib/near";

const base: Settlement = {
  key: { Week: 3 }, status: "OnHold", requested_by: "a.testnet", requested_at_ns: "0", input_sha256: "", result_sha256: "x",
  attestation_ref: "1", source_sha256: "y", source_urls: [], scores: [], placements: [], payouts: [], pot_balance: null,
  payout_base: null, created_at_ns: "0", hold_ends_at_ns: String(60_000n * 1_000_000n), finalized_at_ns: null, error: null,
};
const p = (over: Partial<Payout>): Payout => ({ roster_id: 8, place: null, account: "w.testnet", amount: "5000000", status: "OnHold", withheld_reason: null, proposal_id: 3, ...over });

describe("receipt stamps", () => {
  it("counts down, then says ready", () => {
    expect(payoutStamp(p({}), base, 18_000)).toEqual({ kind: "hold", label: "On hold 0:42" });
    expect(payoutStamp(p({}), base, 61_000).label).toBe("Ready to pay");
  });
  it("final states in plain words", () => {
    expect(payoutStamp(p({ status: "Paid" }), base, 0)).toEqual({ kind: "paid", label: "Paid" });
    expect(payoutStamp(p({ status: "Stopped" }), base, 0).kind).toBe("stop");
    expect(payoutStamp(p({ status: "Withheld", withheld_reason: "dues_unpaid" }), base, 0).note).toBe("Withheld: dues unpaid. The money stays in the pot.");
    expect(payoutStamp(p({ status: "Withheld", withheld_reason: "pot_too_small" }), base, 0).note).toContain("pot too small");
  });
  it("explains enclave errors without codes", () => {
    expect(failureWords("WEEK_NOT_FINAL: the NFL is in week 9")).toContain("Scores aren't final yet");
    expect(failureWords("The enclave run failed or timed out")).toContain("didn't answer in time");
    expect(failureWords("LEAGUE_MISMATCH: not an NFL league")).toBe("not an NFL league");
  });
  it("ordinals", () => expect([1, 2, 3, 4].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th"]));
});

describe("polling and votes", () => {
  it("polls fast while the enclave works and every 10 s during a hold (SPEC 7.8)", () => {
    expect(pollInterval([{ ...base, status: "Requested" }])).toBe(3000);
    expect(pollInterval([base])).toBe(10_000);
    expect(pollInterval([{ ...base, status: "Final" }])).toBe(false);
  });
  it("stopping a payout takes a majority of members and the team-majority quorum", () => {
    expect([1, 2, 3, 4].map((m) => rejectThreshold(m, 2))).toEqual([2, 2, 2, 3]);
    expect([2, 9, 13].map((m) => rejectThreshold(m, 7))).toEqual([7, 7, 7]);
  });
});
