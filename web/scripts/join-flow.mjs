// Gate G3's flow in a real browser against testnet: open an invite link, pick a team, sign in
// with a quick account, claim it, get test USDC, pay dues, see "You're in."
// Usage: node web/scripts/join-flow.mjs [base-url] [league-id] [out-dir]
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://127.0.0.1:5173";
const leagueId = process.argv[3] ?? "0";
const out = process.argv[4] ?? ".";
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${m}`);

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().slice(0, 120)}`));
try {
  await page.goto(`${base}/join/${leagueId}`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Which team is yours?" }).waitFor({ timeout: 30_000 });
  const open = page.locator("ul button:not([disabled])").first();
  const team = (await open.locator("span.block").first().innerText()).trim();
  await open.click();
  log(`picked ${team}`);
  await page.getByRole("button", { name: "Sign in to claim it" }).click();
  await page.getByLabel("Quick account").fill(`fan${Date.now().toString(36).slice(-6)}`);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByText("Waiting for the commissioner to confirm your team").waitFor({ timeout: 60_000 });
  log("claimed; waiting for the commissioner");
  await page.getByRole("button", { name: "Get test USDC" }).click();
  log("asked the faucet");
  const pay = page.getByRole("button", { name: /^Pay \$/ });
  await pay.and(page.locator(":not([disabled])")).waitFor({ timeout: 60_000 });
  await pay.click();
  await page.getByText("You're in.").waitFor({ timeout: 90_000 });
  log(`paid: ${await page.getByText(/of \d+ paid\./).innerText()}`);
  await page.screenshot({ path: `${out}/join-done.png`, fullPage: true });
  console.log(errors.length ? `page errors:\n${errors.join("\n")}` : "no page errors");
} catch (e) {
  await page.screenshot({ path: `${out}/join-error.png`, fullPage: true });
  console.error("FAILED:", e.message, errors.join("\n"));
  process.exitCode = 1;
} finally {
  await browser.close();
}
