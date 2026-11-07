// Loads settle-core (crates/settle-wasm, wasm32-unknown-unknown, no imports) and calls it.
// The same Rust source runs in the OutLayer enclave and in `commish verify`.

export interface JobInput {
  sleeper_league_id: string;
  season: string;
  kind: "weekly_high_score" | "season";
  week?: number;
  rules: { weekly_amount: string; regular_season_weeks: number; season_split_bps: number[] };
  now_ns: string;
}

export interface JobOutput {
  core_version: string;
  kind: "weekly_high_score" | "season";
  league_ref: string;
  season: string;
  week: number | null;
  error?: { code: string; message: string };
  scores: { roster_id: number; points_x100: number; missing?: boolean }[];
  payouts: { roster_id: number; amount: string }[];
  placements: { place: number; roster_id: number }[] | null;
  source?: { urls: string[]; sha256: string };
  outlayer_request_id?: string;
}

interface Exports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  commish_call(ptr: number, len: number): bigint;
}

export class SettleCore {
  private constructor(private readonly x: Exports) {}

  static async load(source: BufferSource | WebAssembly.Module): Promise<SettleCore> {
    const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
    const instance = await WebAssembly.instantiate(module, {});
    return new SettleCore(instance.exports as unknown as Exports);
  }

  /** Low-level JSON call; throws on `{"err": …}`. */
  call<T>(req: object): T {
    const bytes = new TextEncoder().encode(JSON.stringify(req));
    const ptr = this.x.alloc(bytes.length);
    new Uint8Array(this.x.memory.buffer, ptr, bytes.length).set(bytes);
    const ret = this.x.commish_call(ptr, bytes.length);
    this.x.dealloc(ptr, bytes.length);
    const outPtr = Number(ret >> 32n);
    const outLen = Number(ret & 0xffffffffn);
    const text = new TextDecoder().decode(new Uint8Array(this.x.memory.buffer, outPtr, outLen));
    this.x.dealloc(outPtr, outLen);
    const v = JSON.parse(text) as { ok?: T; err?: string };
    if (v.err !== undefined) throw new Error(v.err);
    return v.ok as T;
  }

  version(): string {
    return this.call<string>({ op: "version" });
  }
  initialUrls(input: JobInput): string[] {
    return this.call<string[]>({ op: "initial_urls", input });
  }
  followupUrls(input: JobInput, league: unknown): string[] {
    return this.call<string[]>({ op: "followup_urls", input, league });
  }
  /** Returns the canonical JSON text the enclave would print. */
  run(input: JobInput, fetched: [string, unknown][], requestId: string | null): string {
    return this.call<string>({ op: "run", input, fetched, request_id: requestId });
  }
  canonical(value: unknown): string {
    return this.call<string>({ op: "canonical", value });
  }
}

export type Fetcher = (url: string) => Promise<unknown>;

/** Sleeper fetcher: 404 with a `null` body becomes null (a missing league), like the job. */
export const sleeperFetch: Fetcher = async (url) => {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  const text = await r.text();
  if (r.status === 404 && text.trim() === "null") return null;
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return JSON.parse(text);
};

/** Runs the whole job: plan, fetch, compute. Same steps as crates/outlayer-job. */
export async function runJob(core: SettleCore, input: JobInput, fetcher: Fetcher, requestId: string | null) {
  const fetched: [string, unknown][] = [];
  for (const url of core.initialUrls(input)) fetched.push([url, await fetcher(url)]);
  for (const url of core.followupUrls(input, fetched[0]![1])) fetched.push([url, await fetcher(url)]);
  const text = core.run(input, fetched, requestId);
  return { text, output: JSON.parse(text) as JobOutput, fetched };
}

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
