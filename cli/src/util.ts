export const explorerTx = (hash: string) => `https://testnet.nearblocks.io/txns/${hash}`;
export const explorerAccount = (id: string) => `https://testnet.nearblocks.io/address/${id}`;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** USDC smallest units (6 decimals) → "$12.34" (rounded to cents). */
export function dollars(units: string | bigint): string {
  const v = BigInt(units);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const cents = (a + 5_000n) / 10_000n;
  return `${neg ? "-" : ""}$${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** "$50" / "50" / "50.25" → USDC smallest units. */
export function parseDollars(s: string): bigint {
  const m = s.trim().replace(/^\$/, "").match(/^(\d+)(?:\.(\d{1,6}))?$/);
  if (!m) throw new Error(`not an amount: ${s}`);
  const whole = BigInt(m[1]!);
  const frac = BigInt((m[2] ?? "").padEnd(6, "0") || "0");
  return whole * 1_000_000n + frac;
}

/** "24h" / "60s" / "90m" → nanoseconds. */
export function parseDuration(s: string): bigint {
  const m = s.trim().match(/^(\d+)\s*(s|m|h)$/);
  if (!m) throw new Error(`not a duration (try 24h, 60s, 90m): ${s}`);
  const mult = { s: 1n, m: 60n, h: 3600n }[m[2] as "s" | "m" | "h"];
  return BigInt(m[1]!) * mult * 1_000_000_000n;
}
