// A league member holds a payout from the league page, in a real browser against testnet.
// Uses an existing member's key (MEMBER_KEY_FILE, with account_id + private_key) injected into
// the test browser's storage. Also checks that "Use a NEAR wallet" opens the wallet selector.
// Usage: MEMBER_KEY_FILE=… node web/scripts/hold-flow.mjs [base-url] [league-id] [week]
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://127.0.0.1:5173";
const leagueId = process.argv[3] ?? "0";
const week = process.argv[4] ?? "2";
const key = JSON.parse(readFileSync(process.env.MEMBER_KEY_FILE, "utf8"));
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${m}`);
const browser = await chromium.launch();
const errors = [];
try {
  // Wallet selector smoke test (no wallet is installed in headless Chromium; the list should still open).
  const w = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  w.on("pageerror", (e) => errors.push(e.message));
  await w.goto(base, { waitUntil: "networkidle" });
  await w.getByRole("button", { name: "Sign in" }).click();
  await w.getByRole("button", { name: "Use a NEAR wallet" }).click();
  await w.waitForTimeout(4000);
  const frames = w.frames().length;
  const text = await w.locator("body").innerText();
  log(`wallet selector: ${/meteor|mynearwallet|hot|intear|wallet/i.test(text) || frames > 1 ? "opened" : "did not open"} (${frames} frames)`);

  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.evaluate(([id, sk]) => localStorage.setItem("commish:quick-account", JSON.stringify({ accountId: id, secretKey: sk })), [key.account_id, key.private_key]);
  await page.goto(`${base}/l/${leagueId}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: `Settle week ${week}`, exact: true }).click();
  log(`${key.account_id} pressed Settle week ${week}`);
  const stub = page.getByRole("link", { name: `Week ${week} high score receipt` });
  await stub.getByText(/On hold/).waitFor({ timeout: 120_000 });
  log("on hold");
  await page.getByRole("button", { name: "Hold this payout" }).click();
  await page.getByRole("button", { name: "Hold this payout" }).waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForTimeout(3000);
  log("voted to hold");
  await page.screenshot({ path: `${process.env.OUT ?? "."}/hold-voted.png`, fullPage: true });
  console.log(errors.length ? `page errors:\n${errors.join("\n")}` : "no page errors");
} catch (e) {
  console.error("FAILED:", e.message, errors.join("\n"));
  process.exitCode = 1;
} finally {
  await browser.close();
}
