// Cloudflare entry point: real NEAR, KV and 1Click behind the logic in app.ts.
import { Account, actions, JsonRpcProvider, PublicKey, type KeyPairString } from "near-api-js";
import { createDeposit, type Config } from "@commish/shared";
import { seedDemoLeague } from "@commish/shared/seed";
import { cors, handle, json, type Deps } from "./app";

export interface Env {
  NEAR_RPC_URL: string;
  DEMO_ROOT_ACCOUNT_ID: string;
  COMMISH_CONTRACT_ID: string;
  MOCK_USDC_CONTRACT_ID: string;
  DEMO_SLEEPER_LEAGUE_ID: string;
  ALLOWED_ORIGINS: string;
  DEMO_ROOT_PRIVATE_KEY: string;
  ADMIN_TOKEN?: string;
  ONECLICK_JWT?: string;
  /** Local dev only (worker/.dev.vars): multiplies rate limits. Unset in production. */
  RATE_LIMIT_SCALE?: string;
  RATE: KVNamespace;
}

const TGAS = 1_000_000_000_000n;
const GAS_ROOM = 400_000_000_000_000_000_000_000n; // gas reservation for a 300 Tgas call

function deps(env: Env): Deps {
  if (!env.DEMO_ROOT_PRIVATE_KEY) throw new Error("DEMO_ROOT_PRIVATE_KEY isn't set");
  const provider = new JsonRpcProvider({ url: env.NEAR_RPC_URL });
  const root = new Account(env.DEMO_ROOT_ACCOUNT_ID, provider, env.DEMO_ROOT_PRIVATE_KEY as KeyPairString);
  const view = <T>(contractId: string, method: string, args: Record<string, unknown> = {}) =>
    provider.callFunction({ contractId, method, args }) as Promise<T>;
  return {
    rootAccountId: env.DEMO_ROOT_ACCOUNT_ID,
    async createAccount(accountId, publicKey, yocto) {
      const r = await root.signAndSendTransaction({
        receiverId: accountId,
        actions: [actions.createAccount(), actions.transfer(yocto), actions.addFullAccessKey(PublicKey.fromString(publicKey))],
        waitUntil: "EXECUTED_OPTIMISTIC",
      });
      return r.transaction.hash;
    },
    async accountExists(accountId) {
      try {
        await provider.viewAccount({ accountId });
        return true;
      } catch {
        return false;
      }
    },
    async mint(accountId, units) {
      const r = await root.callFunctionRaw({
        contractId: env.MOCK_USDC_CONTRACT_ID, methodName: "mint",
        args: { account_id: accountId, amount: units.toString() },
        deposit: 1_250_000_000_000_000_000_000n, gas: 30n * TGAS, waitUntil: "EXECUTED_OPTIMISTIC",
      });
      const st = r.status as { Failure?: unknown };
      if (st.Failure) throw new Error(JSON.stringify(st.Failure));
      return r.transaction.hash;
    },
    async transfer(accountId, yocto) {
      const r = await root.signAndSendTransaction({ receiverId: accountId, actions: [actions.transfer(yocto)], waitUntil: "EXECUTED_OPTIMISTIC" });
      return r.transaction.hash;
    },
    async hasLeague(accountId) {
      const n = await view<number>(env.COMMISH_CONTRACT_ID, "league_count");
      const from = Math.max(0, n - 100);
      const leagues = await view<{ commissioner: string }[]>(env.COMMISH_CONTRACT_ID, "list_leagues", { from_index: from, limit: 100 });
      return leagues.some((l) => l.commissioner === accountId);
    },
    async sponsorAmount() {
      return createDeposit(await view<Config>(env.COMMISH_CONTRACT_ID, "get_config")) + GAS_ROOM;
    },
    async quote(body) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (env.ONECLICK_JWT) headers.authorization = `Bearer ${env.ONECLICK_JWT}`;
      const r = await fetch("https://1click.chaindefuser.com/v0/quote", { method: "POST", headers, body: JSON.stringify(body) });
      const j = (await r.json().catch(() => ({}))) as { quote?: unknown; message?: string };
      if (!r.ok || !j.quote) return { status: 502, body: { error: `NEAR Intents couldn't quote that right now${j.message ? `: ${j.message}` : "."}` } };
      return { status: 200, body: { quote: j.quote } };
    },
    seedDemo: (log) =>
      seedDemoLeague({
        root, provider, contractId: env.COMMISH_CONTRACT_ID, usdcId: env.MOCK_USDC_CONTRACT_ID,
        sleeperLeagueId: env.DEMO_SLEEPER_LEAGUE_ID, preSettleWeeks: [1, 2], log,
      }),
    rate: {
      async incr(key, ttl) {
        const n = Number((await env.RATE.get(key)) ?? "0") + 1;
        await env.RATE.put(key, String(n), { expirationTtl: Math.max(60, ttl) });
        return n;
      },
    },
    rateScale: Number(env.RATE_LIMIT_SCALE ?? "1") || 1,
    adminToken: env.ADMIN_TOKEN,
    now: () => Date.now(),
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const origin = req.headers.get("origin");
    if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }), origin, env.ALLOWED_ORIGINS);
    const ip = req.headers.get("cf-connecting-ip") ?? "local";
    try {
      return cors(await handle(req, deps(env), ip), origin, env.ALLOWED_ORIGINS);
    } catch (e) {
      console.error("worker error", e instanceof Error ? e.message : String(e));
      return cors(json({ error: "Something went wrong on our side. Try again." }, 500), origin, env.ALLOWED_ORIGINS);
    }
  },
};
