// Builds settle-core for the browser (if needed) and copies it to public/settle-core.wasm.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(web, "..");
// Honors CARGO_TARGET_DIR, as cargo does.
const built = resolve(repo, process.env.CARGO_TARGET_DIR ?? "target", "wasm32-unknown-unknown/release/settle_wasm.wasm");
if (!existsSync(built) || process.env.REBUILD_WASM) {
  execFileSync("cargo", ["build", "-q", "--release", "--target", "wasm32-unknown-unknown", "-p", "settle-wasm"], { cwd: repo, stdio: "inherit" });
}
mkdirSync(join(web, "public"), { recursive: true });
copyFileSync(built, join(web, "public/settle-core.wasm"));
console.log("public/settle-core.wasm ready");
