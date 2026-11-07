// The Commish Worker's logic, separated from Cloudflare and NEAR so it can be tested in Node.
//
// | Route              | What it does                                              | Limit                      |
// |--------------------|-----------------------------------------------------------|----------------------------|
// | POST /accounts     | Creates <name>.<root> with the caller's public key, 0.5 NEAR | 3 per IP per hour        |
// | POST /faucet       | Mints 100 Test USDC to an account                          | 500 per account per day (token), 10 per IP per hour |
// | POST /quote        | 1Click dry-run quote (mainnet, never executed)             | 30 per IP per minute       |
// | POST /sponsor      | NEAR for one league's vault storage, for a quick account   | 1 per IP and 3 total per day |
// | POST /demo/reset   | Seeds a fresh demo league                                  | admin token                |
//
// The Worker signs only account creation, faucet mints and sponsor transfers (and, for the admin,
// the demo league). It never receives a private key: quick-account keys are made in the browser.

export interface Deps {
  rootAccountId: string;
  /** Creates `accountId` with `publicKey` as a full-access key and `yocto` NEAR. */
  createAccount(accountId: string, publicKey: string, yocto: bigint): Promise<string>;
  accountExists(accountId: string): Promise<boolean>;
  /** Calls Test USDC `mint` (the token enforces its own daily cap). */
  mint(accountId: string, units: bigint): Promise<string>;
  transfer(accountId: string, yocto: bigint): Promise<string>;
  /** True if `accountId` already created a league as commissioner. */
  hasLeague(accountId: string): Promise<boolean>;
  sponsorAmount(): Promise<bigint>;
  quote(body: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
  seedDemo?(log: (l: string) => void): Promise<{ leagueId: number }>;
  rate: RateStore;
  adminToken?: string;
  now(): number;
}

export interface RateStore {
  /** Increments a counter that expires after `ttlSeconds`; returns the new count. */
  incr(key: string, ttlSeconds: number): Promise<number>;
}

export const QUICK_ACCOUNT_NEAR = 500_000_000_000_000_000_000_000n; // 0.5 NEAR (SPEC 7.9)
export const FAUCET_UNITS = 100_000_000n; // 100 Test USDC
const RESERVED = new Set(["commish", "usdc", "admin", "root", "demo", "worker", "keeper", "operator", "vault", "test", "faucet"]);
const NAME_RE = /^[a-z0-9]{2,20}$/;
const PUBKEY_RE = /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/;

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const fail = (status: number, error: string) => json({ error }, status);

async function limit(d: Deps, bucket: string, who: string, max: number, windowSeconds: number): Promise<Response | null> {
  const window = Math.floor(d.now() / 1000 / windowSeconds);
  const n = await d.rate.incr(`rl:${bucket}:${who}:${window}`, windowSeconds + 60);
  return n > max ? fail(429, "Too many requests. Try again later.") : null;
}

async function body(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = (await req.json()) as unknown;
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isAccountId(s: unknown): s is string {
  return typeof s === "string" && s.length >= 2 && s.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(s);
}

export async function handle(req: Request, d: Deps, ip: string): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/health") return json({ ok: true });
  if (req.method !== "POST") return fail(405, "Use POST.");

  switch (url.pathname) {
    case "/accounts": {
      const limited = await limit(d, "accounts", ip, 3, 3600);
      if (limited) return limited;
      const b = await body(req);
      const name = typeof b?.name === "string" ? b.name.trim().toLowerCase() : "";
      const publicKey = typeof b?.public_key === "string" ? b.public_key : "";
      if (!NAME_RE.test(name)) return fail(400, "Names are 2 to 20 lowercase letters or numbers.");
      if (RESERVED.has(name) || /^t\d+$/.test(name) || name.startsWith("cmsh")) return fail(400, "That name is reserved. Pick another.");
      if (!PUBKEY_RE.test(publicKey)) return fail(400, "public_key must be an ed25519 public key.");
      const accountId = `${name}.${d.rootAccountId}`;
      if (await d.accountExists(accountId)) return fail(409, "That name is taken. Pick another.");
      const tx = await d.createAccount(accountId, publicKey, QUICK_ACCOUNT_NEAR);
      return json({ account_id: accountId, tx });
    }

    case "/faucet": {
      const b = await body(req);
      const accountId = b?.account_id;
      if (!isAccountId(accountId) || !accountId.endsWith(".testnet")) return fail(400, "account_id must be a testnet account.");
      const limited = await limit(d, "faucet", ip, 10, 3600);
      if (limited) return limited;
      try {
        const tx = await d.mint(accountId, FAUCET_UNITS);
        return json({ minted: FAUCET_UNITS.toString(), tx });
      } catch (e) {
        const msg = String(e);
        if (msg.includes("capped at 500")) return fail(429, "This account already got 500 test USDC today.");
        throw e;
      }
    }

    case "/quote": {
      const limited = await limit(d, "quote", ip, 30, 60);
      if (limited) return limited;
      const b = await body(req);
      const origin = b?.origin_asset;
      const amount = b?.amount;
      if (typeof origin !== "string" || !/^nep141:[a-z0-9._-]{3,100}$/.test(origin)) return fail(400, "origin_asset must be a 1Click asset id.");
      if (typeof amount !== "string" || !/^\d{1,13}$/.test(amount) || BigInt(amount) === 0n) return fail(400, "amount must be USDC units.");
      const r = await d.quote(quoteRequest(origin, amount, new Date(d.now() + 15 * 60_000)));
      return json(r.body, r.status);
    }

    case "/sponsor": {
      const b = await body(req);
      const accountId = b?.account_id;
      if (!isAccountId(accountId) || !accountId.endsWith(`.${d.rootAccountId}`) || accountId.split(".").length !== d.rootAccountId.split(".").length + 1) {
        return fail(400, "Only quick accounts can get league sponsorship.");
      }
      const day = 86_400;
      const ipLimited = await limit(d, "sponsor", ip, 1, day);
      if (ipLimited) return ipLimited;
      const total = await limit(d, "sponsor-total", "all", 3, day);
      if (total) return fail(429, "Today's free leagues are used up. Use a NEAR wallet with testnet NEAR, or try tomorrow.");
      if (await d.hasLeague(accountId)) return fail(409, "This account already created a league.");
      const amount = await d.sponsorAmount();
      const tx = await d.transfer(accountId, amount);
      return json({ sent: amount.toString(), tx });
    }

    case "/demo/reset": {
      const auth = req.headers.get("authorization") ?? "";
      if (!d.adminToken || auth !== `Bearer ${d.adminToken}`) return fail(401, "Admin only.");
      if (!d.seedDemo) return fail(501, "Demo seeding isn't configured.");
      const limited = await limit(d, "demo-reset", "admin", 2, 3600);
      if (limited) return limited;
      // Stream progress; seeding takes a few minutes.
      const stream = new TransformStream<Uint8Array, Uint8Array>();
      const writer = stream.writable.getWriter();
      const enc = new TextEncoder();
      const write = (l: string) => writer.write(enc.encode(`${l}\n`)).catch(() => {});
      (async () => {
        try {
          const { leagueId } = await d.seedDemo!(write);
          await write(`done: demo league ${leagueId}`);
        } catch (e) {
          await write(`error: ${String(e)}`);
        } finally {
          await writer.close().catch(() => {});
        }
      })();
      return new Response(stream.readable, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
  }
  return fail(404, "Not found.");
}

/** A dry-run 1Click quote: exactly `amount` USDC on NEAR mainnet out, paid from `origin`. */
export function quoteRequest(originAsset: string, amount: string, deadline: Date): Record<string, unknown> {
  return {
    dry: true,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: 100,
    originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", // USDC on NEAR mainnet
    amount,
    // Preview only: testnet accounts don't exist on mainnet, so the quote credits a placeholder
    // NEAR Intents balance. No deposit address is created (dry: true).
    recipient: "commish-preview.near",
    recipientType: "INTENTS",
    refundTo: "commish-preview.near",
    refundType: "INTENTS",
    deadline: deadline.toISOString(),
    quoteWaitingTimeMs: 3000,
    referral: "commish",
  };
}

export function cors(res: Response, origin: string | null, allowed: string): Response {
  const list = allowed.split(",").map((s) => s.trim());
  const allow = list.includes("*") ? "*" : origin && list.includes(origin) ? origin : "";
  const h = new Headers(res.headers);
  if (allow) {
    h.set("access-control-allow-origin", allow);
    h.set("access-control-allow-methods", "POST, GET, OPTIONS");
    h.set("access-control-allow-headers", "content-type, authorization");
    h.set("vary", "origin");
  }
  return new Response(res.body, { status: res.status, headers: h });
}
