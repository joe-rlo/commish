// pnpm commish <command>. Testnet only.
import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { repoRoot } from "./config.js";
import { registerLeagueCommands } from "./commands.js";

const program = new Command();
program.name("commish").description("Commish CLI (NEAR testnet only)");

program
  .command("deploy")
  .description("Deploy Test USDC and the commish contract under DEMO_ROOT_ACCOUNT_ID")
  .requiredOption("--job-url <url>", "FastFS URL of the outlayer-job wasm")
  .requiredOption("--job-sha256 <hex>", "SHA-256 of that wasm")
  .option("--prefix <prefix>", "vault name prefix", "cmsh1-")
  .option("--contract <name>", "contract sub-account name", "commish")
  .option("--usdc <name>", "token sub-account name", "usdc")
  .action(async (o) => {
    const { deploy } = await import("./deploy.js");
    await deploy({ prefix: o.prefix, jobUrl: o.jobUrl, jobSha256: o.jobSha256, contractName: o.contract, usdcName: o.usdc });
  });

program
  .command("verify")
  .description("Recompute a settlement from public Sleeper data, no keys needed (runs settle-core natively)")
  .allowUnknownOption(true)
  .helpOption(false)
  .argument("[args...]")
  .action((args: string[]) => {
    const r = spawnSync("cargo", ["run", "-q", "--release", "-p", "commish-verify", "--", ...args], { cwd: repoRoot, stdio: "inherit" });
    process.exit(r.status ?? 1);
  });

registerLeagueCommands(program);

program.parseAsync(process.argv).catch((e: unknown) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
