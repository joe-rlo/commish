// Loads signing keys for the CLI. Keys never get printed or logged.
//
// Order: an explicit env var (e.g. DEMO_ROOT_PRIVATE_KEY for the root account), then the
// near-cli legacy keychain at ~/.near-credentials/<network>/<account>.json.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, JsonRpcProvider, type KeyPairString } from "near-api-js";
import { config } from "./config.js";

export function loadKey(accountId: string, envVar?: string): KeyPairString {
  if (envVar && process.env[envVar]) return process.env[envVar] as KeyPairString;
  const file = join(homedir(), ".near-credentials", config.network, `${accountId}.json`);
  if (existsSync(file)) {
    const j = JSON.parse(readFileSync(file, "utf8")) as { private_key?: string; secret_key?: string };
    const k = j.private_key ?? j.secret_key;
    if (k) return k as KeyPairString;
  }
  throw new Error(`No key for ${accountId}: set ${envVar ?? "a key env var"} or add ${file}`);
}

export function provider(): JsonRpcProvider {
  return new JsonRpcProvider({ url: config.rpcUrl });
}

export function account(accountId: string, envVar?: string): Account {
  return new Account(accountId, provider(), loadKey(accountId, envVar));
}

export function rootAccount(): Account {
  return account(config.rootAccountId, "DEMO_ROOT_PRIVATE_KEY");
}
