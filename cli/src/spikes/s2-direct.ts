// Spike S2, step 2: ask OutLayer (testnet) to run the job directly from our account.
// Usage: tsx cli/src/spikes/s2-direct.ts <wasm-url> <sha256> [week]
import { actions } from "near-api-js";
import { rootAccount } from "../keys.js";
import { config } from "../config.js";

const [url, hash, weekArg] = process.argv.slice(2);
if (!url || !hash) throw new Error("usage: s2-direct.ts <wasm-url> <sha256> [week]");
const input = {
  sleeper_league_id: "1197787383500648448",
  season: "2025",
  kind: "weekly_high_score",
  week: Number(weekArg ?? 3),
  rules: { weekly_amount: "5000000", regular_season_weeks: 14, season_split_bps: [6000, 2500, 1500] },
  now_ns: String(BigInt(Date.now()) * 1_000_000n),
};
const args = {
  source: { WasmUrl: { url, hash, build_target: "wasm32-wasip2" } },
  resource_limits: { max_instructions: 10_000_000_000, max_memory_mb: 128, max_execution_seconds: 60 },
  input_data: JSON.stringify(input),
  secrets_ref: null,
  response_format: "Json",
  payer_account_id: null,
  params: null,
};
const root = rootAccount();
const t0 = Date.now();
const res = await root.signAndSendTransaction({
  receiverId: config.outlayerId,
  actions: [actions.functionCall("request_execution", args, 300_000_000_000_000n, 50_000_000_000_000_000_000_000n)],
  waitUntil: "EXECUTED_OPTIMISTIC",
  throwOnFailure: false,
});
const status = res.status as { SuccessValue?: string; Failure?: unknown };
console.log("tx", res.transaction.hash, "seconds", ((Date.now() - t0) / 1000).toFixed(1));
for (const r of res.receipts_outcome) {
  for (const log of r.outcome.logs) console.log("log:", log.slice(0, 400));
}
if (status.SuccessValue !== undefined) {
  const text = Buffer.from(status.SuccessValue, "base64").toString("utf8");
  console.log("RESULT", text);
} else {
  console.log("STATUS", JSON.stringify(status).slice(0, 2000));
}
