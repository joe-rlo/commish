// Deploys Test USDC and the commish contract to testnet under the root account.
//
//   pnpm commish deploy [--prefix cmsh1-] [--job-url <fastfs url>] [--job-sha256 <hex>]
//
// Idempotent: an account that already has code is left alone. Each new contract account gets
// its own fresh full-access key, saved to ~/.near-credentials/testnet/<account>.json (never
// printed). Writes the contract ids to .env.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, KeyPair, actions, nearToYocto, type KeyPairString } from "near-api-js";
import { config, repoRoot } from "./config.js";
import { provider, rootAccount } from "./keys.js";
import { explorerTx } from "./util.js";

const TOKEN_STORAGE = "1250000000000000000000"; // 0.00125 NEAR (NEP-145 FT registration)

function saveKey(accountId: string, kp: KeyPair) {
  const dir = join(homedir(), ".near-credentials", config.network);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${accountId}.json`);
  writeFileSync(file, JSON.stringify({ account_id: accountId, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
}

async function hasCode(accountId: string): Promise<boolean | null> {
  try {
    const a = await provider().viewAccount({ accountId });
    return (a as { code_hash: string }).code_hash !== "11111111111111111111111111111111";
  } catch {
    return null; // doesn't exist
  }
}

/** Creates `<sub>.<root>` with code and an init call in one atomic transaction. */
async function deployNew(root: Account, accountId: string, near: `${number}`, wasmPath: string, initArgs: Record<string, unknown>): Promise<string> {
  const code = new Uint8Array(readFileSync(wasmPath));
  const kp = KeyPair.fromRandom("ed25519");
  saveKey(accountId, kp); // before sending, so the key is never lost
  const res = await root.signAndSendTransaction({
    receiverId: accountId,
    actions: [
      actions.createAccount(),
      actions.transfer(nearToYocto(near)),
      actions.addFullAccessKey(kp.getPublicKey()),
      actions.deployContract(code),
      actions.functionCall("new", initArgs, 100_000_000_000_000n, 0n),
    ],
    waitUntil: "FINAL",
  });
  return res.transaction.hash;
}

function setEnv(updates: Record<string, string>) {
  const path = join(repoRoot, ".env");
  let text = existsSync(path) ? readFileSync(path, "utf8") : "";
  for (const [k, v] of Object.entries(updates)) {
    const line = `${k}=${v}`;
    text = new RegExp(`^${k}=.*$`, "m").test(text) ? text.replace(new RegExp(`^${k}=.*$`, "m"), line) : `${text.trimEnd()}\n${line}\n`;
    process.env[k] = v;
  }
  writeFileSync(path, text.endsWith("\n") ? text : text + "\n");
}

export async function deploy(opts: { prefix: string; jobUrl: string; jobSha256: string; contractName: string; usdcName: string }) {
  const root = rootAccount();
  const usdcId = `${opts.usdcName}.${root.accountId}`;
  const commishId = `${opts.contractName}.${root.accountId}`;
  const wasm = (p: string) => join(repoRoot, p);

  // 1. Test USDC
  const usdcState = await hasCode(usdcId);
  if (usdcState === true) console.log(`✓ ${usdcId} already deployed`);
  else if (usdcState === null) {
    const tx = await deployNew(root, usdcId, "2", wasm("target/near/mock_usdc/mock_usdc.wasm"), {});
    console.log(`✓ deployed Test USDC at ${usdcId}  ${explorerTx(tx)}`);
  } else throw new Error(`${usdcId} exists without code; deploy it by hand`);

  // 2. commish
  const commishState = await hasCode(commishId);
  if (commishState === true) console.log(`✓ ${commishId} already deployed`);
  else if (commishState === null) {
    const contractConfig = {
      outlayer_id: config.outlayerId,
      job_wasm_url: opts.jobUrl,
      job_wasm_sha256: opts.jobSha256,
      job_build_target: "wasm32-wasip2",
      core_version: "1.0.0",
      sputnik_factory_id: config.sputnikFactoryId,
      default_token_id: usdcId,
      vault_name_prefix: opts.prefix,
      vault_deposit: nearToYocto("5.3").toString(),
      token_storage_deposit: TOKEN_STORAGE,
      outlayer_deposit: nearToYocto("0.02").toString(),
      settle_storage_deposit: nearToYocto("0.01").toString(),
      demo_admin: root.accountId,
    };
    const tx = await deployNew(root, commishId, "4.5", wasm("target/near/commish/commish.wasm"), { config: contractConfig });
    console.log(`✓ deployed commish at ${commishId}  ${explorerTx(tx)}`);
  } else throw new Error(`${commishId} exists without code; deploy it by hand`);

  // 3. commish must be registered with the token to receive dues.
  const reg = await provider().callFunction({ contractId: usdcId, method: "storage_balance_of", args: { account_id: commishId } });
  if (reg) console.log(`✓ ${commishId} registered with Test USDC`);
  else {
    const r = await root.callFunction({
      contractId: usdcId, methodName: "storage_deposit",
      args: { account_id: commishId, registration_only: true }, deposit: BigInt(TOKEN_STORAGE), gas: 30_000_000_000_000n,
    });
    void r;
    console.log(`✓ registered ${commishId} with Test USDC`);
  }

  setEnv({ COMMISH_CONTRACT_ID: commishId, MOCK_USDC_CONTRACT_ID: usdcId });
  console.log(`\n.env updated: COMMISH_CONTRACT_ID=${commishId} MOCK_USDC_CONTRACT_ID=${usdcId}`);
}

export function loadAccount(accountId: string): Account {
  const file = join(homedir(), ".near-credentials", config.network, `${accountId}.json`);
  const j = JSON.parse(readFileSync(file, "utf8")) as { private_key: string };
  return new Account(accountId, provider(), j.private_key as KeyPairString);
}
