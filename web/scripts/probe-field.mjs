import { chromium, devices } from "playwright";
const BASE = "http://localhost:3000";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

async function run(label, { bypassSW }) {
  const ctx = await browser.newContext({ ...devices["iPhone 13"], serviceWorkers: bypassSW ? "block" : "allow" });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push(String(e).split("\n")[0].slice(0,90)));
  await page.goto(`${BASE}/login`);
  await page.fill('input[name=email]','tech@apexplumbing.demo');
  await page.fill('input[name=password]','demo1234');
  await page.click('button[type=submit]');
  await page.waitForLoadState("networkidle");
  // First field load
  errs.length = 0;
  await page.goto(`${BASE}/field`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const first = errs.length;
  // Second field load (SW now active if allowed)
  errs.length = 0;
  await page.goto(`${BASE}/field`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const second = errs.length;
  console.log(`${label}: 1st load errs=${first}, 2nd load errs=${second}`, errs.slice(0,1));
  await ctx.close();
}
await run("SW blocked ", { bypassSW: true });
await run("SW allowed ", { bypassSW: false });
await browser.close();
