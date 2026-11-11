// The README's "try it in 2 minutes" flow, in a real browser against testnet:
//   /demo → sign in (quick account) → Settle week N → On hold → Paid → receipt → Check the math → Matches ✓
// Usage: node web/scripts/judge-flow.mjs [base-url] [week|auto] [out-dir]
// With no week (or "auto") it settles the first week the demo league still shows under Next up.
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://127.0.0.1:5173";
const weekArg = process.argv[3] ?? "auto";
const out = process.argv[4] ?? ".";
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${m}`);

const browser = await chromium.launch();
// VIDEO_DIR=<dir> also records the run as a .webm (for the demo post).
const video = process.env.VIDEO_DIR ? { recordVideo: { dir: process.env.VIDEO_DIR, size: { width: 390, height: 844 } } } : {};
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, ...video });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().slice(0, 120)}`));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

try {
  await page.goto(`${base}/demo`, { waitUntil: "networkidle" });
  await page.getByText("12 of 12 paid").waitFor({ timeout: 30_000 });
  log("demo league loaded: 12 of 12 paid");

  let week = Number(weekArg);
  if (weekArg === "auto") {
    const first = page.getByRole("button", { name: /^Settle week \d+$/ }).first();
    if (!(await first.count())) throw new Error("the demo league has no open weeks left; reseed it with `pnpm commish demo-seed`");
    week = Number((await first.innerText()).match(/\d+/)[0]);
    log(`first open week: ${week}`);
  }
  const settle = page.getByRole("button", { name: `Settle week ${week}`, exact: true });
  await settle.click();
  await page.getByRole("dialog", { name: "Sign in" }).waitFor();
  const name = `judge${Date.now().toString(36).slice(-6)}`;
  await page.getByLabel("Quick account").fill(name);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  log(`signing in as ${name}`);
  // After sign-in the settle runs automatically.
  await page.getByRole("link", { name: `Week ${week} high score receipt` }).waitFor({ timeout: 90_000 });
  log("settle sent; receipt appeared");
  const stub = page.getByRole("link", { name: `Week ${week} high score receipt` });
  await stub.getByText(/On hold/).waitFor({ timeout: 120_000 });
  log(`on hold: ${await stub.locator(".stamp").first().innerText()}`);
  await page.screenshot({ path: `${out}/flow-1-onhold.png`, fullPage: false });
  await stub.getByText("Paid", { exact: true }).waitFor({ timeout: 180_000 });
  log("flipped to Paid");
  await page.screenshot({ path: `${out}/flow-2-paid.png`, fullPage: false });

  await stub.click();
  await page.getByRole("heading", { name: `Week ${week} high score` }).waitFor();
  await page.getByRole("button", { name: "Check the math" }).click();
  await page.getByText("Matches ✓").waitFor({ timeout: 60_000 });
  log("Check the math: Matches ✓");
  await page.screenshot({ path: `${out}/flow-3-matches.png`, fullPage: true });
  console.log(errors.length ? `console errors:\n${errors.join("\n")}` : "no console errors");
} catch (e) {
  await page.screenshot({ path: `${out}/flow-error.png`, fullPage: true });
  console.error("FAILED:", e.message, errors.join("\n"));
  process.exitCode = 1;
} finally {
  if (process.env.VIDEO_DIR) await page.waitForTimeout(2500); // hold the last frame
  await ctx.close(); // flushes the video
  await browser.close();
}
