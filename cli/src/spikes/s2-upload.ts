// Spike S2, step 1: upload the outlayer-job wasm to FastFS and wait for it to be served.
// Usage: pnpm exec tsx cli/src/spikes/s2-upload.ts target/job/wasm32-wasip2/release/outlayer-job.wasm (from scripts/build-job.sh)
import { readFileSync } from "node:fs";
import { rootAccount } from "../keys.js";
import { config } from "../config.js";
import { uploadToFastfs, waitForFastfs } from "../fastfs.js";

const file = process.argv[2];
if (!file) throw new Error("usage: s2-upload.ts <file.wasm>");
const content = new Uint8Array(readFileSync(file));
const root = rootAccount();
const { url, sha256, txHash } = await uploadToFastfs(root, config.outlayerId, content);
console.log(JSON.stringify({ url, sha256, txHash, bytes: content.length }));
await waitForFastfs(url, sha256);
console.log("served", url);
