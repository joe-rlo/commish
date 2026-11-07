// Uploads a file to FastFS (on-chain file hosting that OutLayer reads WasmUrl sources from).
//
// Format from out-layer/outlayer-cli src/commands/upload.rs: one function call
// `__fastdata_fastfs` to the receiver with Borsh args
//   enum FastfsData { Simple { relative_path: String, content: Option<{ mime_type: String, content: Vec<u8> }> } }
// and gas = 1. The receipt fails by design; the indexer reads the arguments.
// The file is then served at https://test.fastfs.io/<sender>/<receiver>/<sha256>.<ext>.
import { createHash } from "node:crypto";
import { actions, type Account } from "near-api-js";
import { config } from "./config.js";

const u32le = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const borshString = (s: string) => { const b = new TextEncoder().encode(s); return concat(u32le(b.length), b); };
const borshBytes = (b: Uint8Array) => concat(u32le(b.length), b);

export function fastfsSimplePayload(relativePath: string, mimeType: string, content: Uint8Array): Uint8Array {
  // variant 0 (Simple), relative_path, Some(1) { mime_type, content }
  return concat(new Uint8Array([0]), borshString(relativePath), new Uint8Array([1]), borshString(mimeType), borshBytes(content));
}

export function sha256Hex(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

export async function uploadToFastfs(sender: Account, receiverId: string, content: Uint8Array, ext = "wasm"): Promise<{ url: string; sha256: string; txHash: string }> {
  if (content.length > 1 << 20) throw new Error("files over 1 MB need chunked upload, which this tool doesn't do");
  const sha256 = sha256Hex(content);
  const mime = ext === "wasm" ? "application/wasm" : "application/octet-stream";
  const payload = fastfsSimplePayload(`${sha256}.${ext}`, mime, content);
  const res = await sender.signAndSendTransaction({
    receiverId,
    actions: [actions.functionCall("__fastdata_fastfs", payload, 1n, 0n)],
    throwOnFailure: false,
  });
  const url = `${config.fastfsHost}/${sender.accountId}/${receiverId}/${sha256}.${ext}`;
  return { url, sha256, txHash: res.transaction.hash };
}

/** Polls the FastFS URL until it serves bytes with the expected SHA-256. */
export async function waitForFastfs(url: string, sha256: string, timeoutMs = 300_000): Promise<void> {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) {
        const got = sha256Hex(new Uint8Array(await r.arrayBuffer()));
        if (got === sha256) return;
        last = `hash ${got}`;
      } else last = `HTTP ${r.status}`;
    } catch (e) { last = String(e); }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`FastFS didn't serve ${url} in time (last: ${last})`);
}
