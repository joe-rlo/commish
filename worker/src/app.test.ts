import { describe, expect, it, vi } from "vitest";
import { ACCOUNTS_RESERVE, cors, FAUCET_UNITS, handle, LOW_FUNDS, QUICK_ACCOUNT_NEAR, quoteRequest, SPONSOR_RESERVE, type Deps } from "./app";

const PK = "ed25519:" + "1".repeat(44);

function fakeDeps(over: Partial<Deps> = {}): Deps & { calls: string[] } {
  const counters = new Map<string, number>();
  const calls: string[] = [];
  let t = Date.parse("2026-11-07T12:00:00Z");
  return {
    calls,
    rootAccountId: "commishhq.testnet",
    createAccount: vi.fn(async (id, pk, y) => (calls.push(`create ${id} ${pk} ${y}`), "TX1")),
    accountExists: vi.fn(async (id) => id === "taken.commishhq.testnet"),
    mint: vi.fn(async (id, u) => (calls.push(`mint ${id} ${u}`), "TX2")),
    transfer: vi.fn(async (id, y) => (calls.push(`transfer ${id} ${y}`), "TX3")),
    hasLeague: vi.fn(async (id) => id === "boss.commishhq.testnet"),
    sponsorAmount: vi.fn(async () => 5_780_000_000_000_000_000_000_000n),
    rootBalance: vi.fn(async () => 60_000_000_000_000_000_000_000_000n),
    quote: vi.fn(async () => ({ status: 200, body: { quote: { amountInFormatted: "0.56" } } })),
    rate: { incr: async (k) => { const n = (counters.get(k) ?? 0) + 1; counters.set(k, n); return n; } },
    adminToken: "secret",
    now: () => t,
    ...over,
  };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://w.example${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });

describe("POST /accounts", () => {
  it("creates <name>.<root> with the browser's public key and 0.5 NEAR", async () => {
    const d = fakeDeps();
    const r = await handle(post("/accounts", { name: "WaiverWire", public_key: PK }), d, "1.1.1.1");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ account_id: "waiverwire.commishhq.testnet", tx: "TX1" });
    expect(d.calls).toEqual([`create waiverwire.commishhq.testnet ${PK} ${QUICK_ACCOUNT_NEAR}`]);
  });
  it("rejects bad names, reserved names, bad keys and taken names", async () => {
    const d = fakeDeps();
    const cases: [unknown, number][] = [
      [{ name: "a", public_key: PK }, 400],
      [{ name: "has space", public_key: PK }, 400],
      [{ name: "x".repeat(21), public_key: PK }, 400],
      [{ name: "commish", public_key: PK }, 400],
      [{ name: "t3", public_key: PK }, 400],
      [{ name: "cmsh1", public_key: PK }, 400],
      [{ name: "alice", public_key: "ed25519:notbase58!" }, 400],
      [{ name: "alice", private_key: "ed25519:..." }, 400],
    ];
    let ip = 0;
    for (const [b, status] of cases) expect((await handle(post("/accounts", b), d, `10.0.0.${ip++}`)).status).toBe(status);
    expect((await handle(post("/accounts", { name: "taken", public_key: PK }), d, "9.9.9.9")).status).toBe(409);
    expect(d.calls).toEqual([]);
  });
  it("a local rate scale raises every limit", async () => {
    const d = fakeDeps({ rateScale: 2 });
    for (let i = 0; i < 6; i++) expect((await handle(post("/accounts", { name: `ok${i}`, public_key: PK }), d, "4.4.4.4")).status).toBe(200);
    expect((await handle(post("/accounts", { name: "ok9", public_key: PK }), d, "4.4.4.4")).status).toBe(429);
  });
  it("allows 3 per IP per hour", async () => {
    const d = fakeDeps();
    for (let i = 0; i < 3; i++) expect((await handle(post("/accounts", { name: `ok${i}`, public_key: PK }), d, "2.2.2.2")).status).toBe(200);
    expect((await handle(post("/accounts", { name: "ok9", public_key: PK }), d, "2.2.2.2")).status).toBe(429);
    expect((await handle(post("/accounts", { name: "ok9", public_key: PK }), d, "3.3.3.3")).status).toBe(200);
  });
});

describe("POST /faucet", () => {
  it("mints 100 Test USDC to a testnet account", async () => {
    const d = fakeDeps();
    const r = await handle(post("/faucet", { account_id: "alice.commishhq.testnet" }), d, "1.1.1.1");
    expect(await r.json()).toEqual({ minted: FAUCET_UNITS.toString(), tx: "TX2" });
  });
  it("rejects non-testnet accounts and reports the token's daily cap", async () => {
    const d = fakeDeps({ mint: async () => { throw new Error("Smart contract panicked: Test USDC mint is capped at 500 per account per day"); } });
    expect((await handle(post("/faucet", { account_id: "alice.near" }), d, "1")).status).toBe(400);
    expect((await handle(post("/faucet", { account_id: "Bad Id" }), d, "1")).status).toBe(400);
    const r = await handle(post("/faucet", { account_id: "alice.testnet" }), d, "1");
    expect(r.status).toBe(429);
    expect(((await r.json()) as { error: string }).error).toContain("500 test USDC today");
  });
});

describe("POST /quote", () => {
  it("proxies a dry-run EXACT_OUTPUT quote to USDC on NEAR", async () => {
    const d = fakeDeps();
    const r = await handle(post("/quote", { origin_asset: "nep141:sol.omft.near", amount: "50000000" }), d, "1");
    expect(r.status).toBe(200);
    const body = (d.quote as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(body).toMatchObject({ dry: true, swapType: "EXACT_OUTPUT", originAsset: "nep141:sol.omft.near", amount: "50000000" });
    expect(body.destinationAsset).toBe("nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1");
  });
  it("never asks for a real deposit address", () => {
    expect(quoteRequest("nep141:eth.omft.near", "1", new Date(0)).dry).toBe(true);
  });
  it("validates input and limits 30 per minute", async () => {
    const d = fakeDeps();
    expect((await handle(post("/quote", { origin_asset: "sol", amount: "1" }), d, "1")).status).toBe(400);
    expect((await handle(post("/quote", { origin_asset: "nep141:sol.omft.near", amount: "0" }), d, "1")).status).toBe(400);
    for (let i = 0; i < 28; i++) await handle(post("/quote", { origin_asset: "nep141:sol.omft.near", amount: "1" }), d, "1");
    expect((await handle(post("/quote", { origin_asset: "nep141:sol.omft.near", amount: "1" }), d, "1")).status).toBe(429);
  });
});

describe("POST /sponsor", () => {
  it("sends one league's vault deposit to a quick account", async () => {
    const d = fakeDeps();
    const r = await handle(post("/sponsor", { account_id: "alice.commishhq.testnet" }), d, "1");
    expect(r.status).toBe(200);
    expect(d.calls).toEqual(["transfer alice.commishhq.testnet 5780000000000000000000000"]);
  });
  it("only quick accounts, once per IP per day, three a day in total, and not twice", async () => {
    const d = fakeDeps();
    expect((await handle(post("/sponsor", { account_id: "alice.testnet" }), d, "a")).status).toBe(400);
    expect((await handle(post("/sponsor", { account_id: "x.alice.commishhq.testnet" }), d, "a")).status).toBe(400);
    expect((await handle(post("/sponsor", { account_id: "boss.commishhq.testnet" }), d, "b")).status).toBe(409);
    expect((await handle(post("/sponsor", { account_id: "a1.commishhq.testnet" }), d, "c")).status).toBe(200);
    expect((await handle(post("/sponsor", { account_id: "a2.commishhq.testnet" }), d, "c")).status).toBe(429);
    expect((await handle(post("/sponsor", { account_id: "a3.commishhq.testnet" }), d, "d")).status).toBe(200);
    expect((await handle(post("/sponsor", { account_id: "a4.commishhq.testnet" }), d, "e")).status).toBe(429);
  });
});

describe("root reserve", () => {
  const SPONSOR = 5_780_000_000_000_000_000_000_000n;
  it("stops sponsoring before the root drops below the reserve, without using up the IP's daily sponsor", async () => {
    let balance = SPONSOR + SPONSOR_RESERVE - 1n;
    const d = fakeDeps({ rootBalance: vi.fn(async () => balance) });
    const r = await handle(post("/sponsor", { account_id: "alice.commishhq.testnet" }), d, "1");
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: LOW_FUNDS });
    expect(d.calls).toEqual([]);
    balance += 1n;
    expect((await handle(post("/sponsor", { account_id: "alice.commishhq.testnet" }), d, "1")).status).toBe(200);
  });
  it("keeps quick accounts working until the root can't cover one plus fees", async () => {
    let balance = SPONSOR_RESERVE; // below the sponsor floor, well above the accounts floor
    const d = fakeDeps({ rootBalance: vi.fn(async () => balance) });
    expect((await handle(post("/accounts", { name: "judge1", public_key: PK }), d, "1")).status).toBe(200);
    balance = QUICK_ACCOUNT_NEAR + ACCOUNTS_RESERVE - 1n;
    const r = await handle(post("/accounts", { name: "judge2", public_key: PK }), d, "1");
    expect(r.status).toBe(503);
    expect(d.calls).toHaveLength(1);
  });
});

describe("POST /demo/reset", () => {
  it("needs the admin token", async () => {
    const d = fakeDeps({ seedDemo: async () => ({ leagueId: 7 }) });
    expect((await handle(post("/demo/reset", {}), d, "1")).status).toBe(401);
    expect((await handle(post("/demo/reset", {}, { authorization: "Bearer nope" }), d, "1")).status).toBe(401);
    const r = await handle(post("/demo/reset", {}, { authorization: "Bearer secret" }), d, "1");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("done: demo league 7");
  });
  it("is off without a token configured", async () => {
    const d = fakeDeps({ adminToken: undefined });
    expect((await handle(post("/demo/reset", {}, { authorization: "Bearer undefined" }), d, "1")).status).toBe(401);
  });
});

describe("plumbing", () => {
  it("health, methods, unknown routes", async () => {
    const d = fakeDeps();
    expect((await handle(new Request("https://w/health"), d, "1")).status).toBe(200);
    expect((await handle(new Request("https://w/accounts"), d, "1")).status).toBe(405);
    expect((await handle(post("/nope", {}), d, "1")).status).toBe(404);
    expect((await handle(new Request("https://w/accounts", { method: "POST", body: "not json" }), d, "1")).status).toBe(400);
  });
  it("CORS follows ALLOWED_ORIGINS", () => {
    const res = new Response("x");
    expect(cors(res, "https://a.dev", "*").headers.get("access-control-allow-origin")).toBe("*");
    expect(cors(res, "https://a.dev", "https://a.dev,https://b.dev").headers.get("access-control-allow-origin")).toBe("https://a.dev");
    expect(cors(res, "https://evil.dev", "https://a.dev").headers.get("access-control-allow-origin")).toBeNull();
  });
});
