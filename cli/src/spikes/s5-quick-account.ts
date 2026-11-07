// Spike S5: quick account made from a browser-generated key, then it pays dues itself.
import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";
const W = "http://127.0.0.1:8787";
const provider = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
const kp = KeyPair.fromRandom("ed25519");
const name = "s5" + Date.now().toString(36).slice(-6);
const post = async (p: string, b: unknown) => { const r = await fetch(W + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() as any }; };
const acc = await post("/accounts", { name, public_key: kp.getPublicKey().toString() });
console.log("accounts:", acc.status, acc.body.account_id, "tx", acc.body.tx);
const dup = await post("/accounts", { name, public_key: kp.getPublicKey().toString() });
console.log("duplicate name:", dup.status, dup.body.error);
const f = await post("/faucet", { account_id: acc.body.account_id });
console.log("faucet:", f.status, f.body.minted, "tx", f.body.tx);
await new Promise((r) => setTimeout(r, 2500));
const me = new Account(acc.body.account_id, provider, kp.toString() as KeyPairString);
const c = await me.callFunctionRaw({ contractId: "commish.commishhq.testnet", methodName: "claim_team", args: { league_id: 0, roster_id: 5 }, gas: 30_000_000_000_000n, waitUntil: "EXECUTED_OPTIMISTIC" });
console.log("claim roster 5 of league 0:", JSON.stringify(c.status), "tx", c.transaction.hash);
const p = await me.callFunctionRaw({ contractId: "usdc.commishhq.testnet", methodName: "ft_transfer_call", args: { receiver_id: "commish.commishhq.testnet", amount: "50000000", msg: JSON.stringify({ league_id: 0, roster_id: 5 }) }, deposit: 1n, gas: 150_000_000_000_000n, waitUntil: "FINAL" });
console.log("pay $50 dues:", JSON.stringify(p.status), "tx", p.transaction.hash);
