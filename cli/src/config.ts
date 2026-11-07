// CLI configuration from the environment (.env at the repo root is loaded by index.ts).
// Testnet only: anything else is refused.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Minimal .env loader: KEY=VALUE lines, no expansion. Existing env vars win. */
export function loadDotEnv(path = join(repoRoot, ".env")): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const [, k, raw] = m as unknown as [string, string, string];
    const v = raw.replace(/^["']|["']$/g, "");
    if (process.env[k] === undefined && v !== "") process.env[k] = v;
  }
}
loadDotEnv();

const env = (k: string, fallback?: string): string => {
  const v = process.env[k] ?? fallback;
  if (v === undefined || v === "") throw new Error(`Set ${k} in .env (see .env.example)`);
  return v;
};

const network = process.env.NEAR_NETWORK ?? "testnet";
if (network !== "testnet") throw new Error(`NEAR_NETWORK=${network}: this build signs on testnet only`);

export const config = {
  network,
  get rpcUrl() { return process.env.NEAR_RPC_URL || "https://test.rpc.fastnear.com"; },
  get rootAccountId() { return env("DEMO_ROOT_ACCOUNT_ID"); },
  get contractId() { return env("COMMISH_CONTRACT_ID"); },
  get usdcId() { return env("MOCK_USDC_CONTRACT_ID"); },
  get sputnikFactoryId() { return env("SPUTNIK_FACTORY_ID", "sputnik-v2.testnet"); },
  get outlayerId() { return env("OUTLAYER_CONTRACT_ID", "outlayer.testnet"); },
  outlayerApi: "https://testnet-api.outlayer.ai",
  fastfsHost: "https://test.fastfs.io",
};
