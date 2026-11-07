// Display helpers. Amounts are 6-decimal token units; points are integer hundredths.

/** 5000000 → "$5.00". Rounds half up to the cent. */
export function dollars(units: string | bigint | number, opts: { cents?: boolean } = {}): string {
  const v = BigInt(units);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const cents = (a + 5_000n) / 10_000n;
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (cents % 100n).toString().padStart(2, "0");
  return `${neg ? "−" : ""}$${whole}${opts.cents === false ? "" : `.${frac}`}`;
}

/** "$50" / "50.25" → units. Returns null for anything that isn't a plain amount. */
export function parseDollars(s: string): bigint | null {
  const m = s.trim().replace(/^\$/, "").replace(/,/g, "").match(/^(\d{1,9})(?:\.(\d{0,2}))?$/);
  if (!m) return null;
  return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(2, "0") || "0") * 10_000n;
}

/** 16238 → "162.38". */
export function points(x100: number): string {
  const neg = x100 < 0;
  const a = Math.abs(x100);
  return `${neg ? "−" : ""}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

/** Remaining time as "18h 22m", "4m 05s" or "0:42". */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m >= 10) return `${m}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `0:${String(sec).padStart(2, "0")}`;
}

/** Nanoseconds since epoch (string) → ms. */
export const nsToMs = (ns: string | null | undefined): number => (ns ? Number(BigInt(ns) / 1_000_000n) : 0);

/** Hold window in plain words: 60 s → "60 seconds", 24 h → "24 hours". */
export function holdWords(ns: string | bigint): string {
  const s = Number(BigInt(ns) / 1_000_000_000n);
  if (s < 120) return `${s} seconds`;
  if (s < 7200) return `${Math.round(s / 60)} minutes`;
  return `${Math.round(s / 3600)} hours`;
}

/** Basis points → "60/25/15". */
export const splitWords = (bps: number[]) => (bps.length === 1 ? "winner takes all" : bps.map((b) => b / 100).join("/"));

export const shortHash = (h: string | null | undefined) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "—");
