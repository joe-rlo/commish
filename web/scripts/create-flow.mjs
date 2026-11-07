// Create a league in the browser as a brand-new quick account, then have a second person join
// and the commissioner approve them from the league page. Testnet; spends one vault deposit.
// Usage: node web/scripts/create-flow.mjs [base-url] [sleeper-id] [out-dir]
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://127.0.0.1:5173";
const sleeperId = process.argv[3] ?? "1197787383500648448";
const out = process.argv[4] ?? ".";
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${m}`);
const browser = await chromium.launch();
const errors = [];
const newPage = async () => {
  const p = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  return p;
};

try {
  // Optional: approve on an existing league whose commissioner key is in COMMISSIONER_KEY_FILE.
  if (process.env.APPROVE_ONLY_LEAGUE) {
    await approveOnly(process.env.APPROVE_ONLY_LEAGUE);
    process.exit(process.exitCode ?? 0);
  }
  const boss = await newPage();
  await boss.goto(`${base}/new?demo=1`, { waitUntil: "networkidle" });
  await boss.getByLabel("Paste your Sleeper league link or ID").fill(`https://sleeper.com/leagues/${sleeperId}/matchup`);
  await boss.getByRole("button", { name: "Find" }).click();
  await boss.getByRole("heading", { name: "Set the rules" }).waitFor({ timeout: 30_000 });
  log("league found; rules shown");
  const summary = await boss.locator(".board p").first().innerText();
  log(`summary: ${summary}`);
  await boss.getByLabel("Dues per team").fill("20");
  await boss.getByRole("button", { name: "Sign in to create the league" }).click();
  await boss.getByLabel("Quick account").fill(`boss${Date.now().toString(36).slice(-6)}`);
  await boss.getByRole("button", { name: "Create", exact: true }).click();
  await boss.getByRole("heading", { name: "Your league is live" }).waitFor({ timeout: 180_000 });
  const link = await boss.getByLabel("Invite link").inputValue();
  log(`created; invite ${link}`);
  await boss.screenshot({ path: `${out}/create-invite.png` });

  const fan = await newPage();
  await fan.goto(link.replace(/^https?:\/\/[^/]+/, base), { waitUntil: "networkidle" });
  await fan.getByRole("heading", { name: "Which team is yours?" }).waitFor({ timeout: 30_000 });
  await fan.locator("ul button:not([disabled])").first().click();
  await fan.getByRole("button", { name: "Sign in to claim it" }).click();
  await fan.getByLabel("Quick account").fill(`fan${Date.now().toString(36).slice(-6)}`);
  await fan.getByRole("button", { name: "Create", exact: true }).click();
  await fan.getByText("Waiting for the commissioner to confirm your team").waitFor({ timeout: 60_000 });
  log("second person claimed a team");

  const leagueUrl = link.replace("/join/", "/l/").replace(/^https?:\/\/[^/]+/, base);
  await boss.goto(leagueUrl, { waitUntil: "networkidle" });
  await boss.getByRole("heading", { name: "Commissioner" }).waitFor({ timeout: 30_000 });
  await boss.getByRole("button", { name: "Approve" }).first().click({ timeout: 30_000 });
  log("commissioner pressed Approve");
  await fan.getByText("The commissioner confirmed your team.").waitFor({ timeout: 90_000 });
  log("the second person sees the approval");
  await boss.screenshot({ path: `${out}/create-league.png`, fullPage: true });
  console.log(errors.length ? `page errors:\n${errors.join("\n")}` : "no page errors");
} catch (e) {
  console.error("FAILED:", e.message, errors.join("\n"));
  process.exitCode = 1;
} finally {
  await browser.close();
}

async function approveOnly(leagueId) {
  const { readFileSync } = await import("node:fs");
  const key = JSON.parse(readFileSync(process.env.COMMISSIONER_KEY_FILE, "utf8"));
  try {
    const fan = await newPage();
    await fan.goto(`${base}/join/${leagueId}`, { waitUntil: "networkidle" });
    await fan.getByRole("heading", { name: "Which team is yours?" }).waitFor({ timeout: 30_000 });
    await fan.locator("ul button:not([disabled])").first().click();
    await fan.getByRole("button", { name: "Sign in to claim it" }).click();
    const fanName = `fan${Date.now().toString(36).slice(-6)}`;
    await fan.getByLabel("Quick account").fill(fanName);
    await fan.getByRole("button", { name: "Create", exact: true }).click();
    await fan.getByText("Waiting for the commissioner to confirm your team").waitFor({ timeout: 60_000 });
    log(`${fanName} claimed a team`);
    const boss = await newPage();
    await boss.goto(base, { waitUntil: "domcontentloaded" });
    await boss.evaluate(([id, sk]) => localStorage.setItem("commish:quick-account", JSON.stringify({ accountId: id, secretKey: sk })), [process.env.COMMISSIONER_ACCOUNT_ID ?? key.account_id, key.private_key]);
    await boss.goto(`${base}/l/${leagueId}`, { waitUntil: "networkidle" });
    await boss.getByRole("heading", { name: "Commissioner" }).waitFor({ timeout: 30_000 });
    await boss.locator("li", { hasText: fanName }).getByRole("button", { name: "Approve" }).click({ timeout: 30_000 });
    log(`commissioner approved ${fanName}`);
    await fan.getByText("The commissioner confirmed your team.").waitFor({ timeout: 90_000 });
    log("the new member sees the approval");
    await boss.screenshot({ path: `${out}/commissioner-panel.png`, fullPage: true });
    console.log(errors.length ? `page errors:\n${errors.join("\n")}` : "no page errors");
  } catch (e) {
    console.error("FAILED:", e.message, errors.join("\n"));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}
