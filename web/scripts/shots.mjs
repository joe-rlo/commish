// Screenshots of the main pages at phone width, light and dark. Usage:
//   node web/scripts/shots.mjs <out-dir> [base-url]
import { chromium } from "playwright";
const out = process.argv[2] ?? "shots";
const base = process.argv[3] ?? "http://127.0.0.1:5173";
const pages = [["landing", "/"], ["demo", "/demo"], ["receipt", "/l/1/r/w1"], ["how", "/how"], ["new", "/new"], ["join", "/join/1"]];
const browser = await chromium.launch();
const errors = [];
for (const scheme of ["light", "dark"]) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, colorScheme: scheme });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(`${scheme} ${page.url()}: ${m.text()}`));
  page.on("pageerror", (e) => errors.push(`${scheme} ${page.url()}: ${e.message}`));
  for (const [name, path] of pages) {
    await page.goto(base + path, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${out}/${name}-${scheme}.png`, fullPage: true });
  }
  await ctx.close();
}
await browser.close();
console.log(errors.length ? errors.join("\n") : "no console errors");
