import { describe, expect, it } from "vitest";
import { dollars, parseDollars, parseDuration } from "./util.js";

describe("cli units", () => {
  it("dollars", () => {
    expect(dollars(5_000_000n)).toBe("$5.00");
    expect(dollars("145000000")).toBe("$145.00");
  });
  it("parseDollars", () => {
    expect(parseDollars("50")).toBe(50_000_000n);
    expect(parseDollars("$5.25")).toBe(5_250_000n);
    expect(parseDollars("0.000001")).toBe(1n);
    expect(() => parseDollars("five")).toThrow();
  });
  it("parseDuration", () => {
    expect(parseDuration("24h")).toBe(86_400_000_000_000n);
    expect(parseDuration("60s")).toBe(60_000_000_000n);
    expect(parseDuration("90m")).toBe(5_400_000_000_000n);
    expect(() => parseDuration("1d")).toThrow();
  });
});
