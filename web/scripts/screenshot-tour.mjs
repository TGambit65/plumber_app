/* Smoke-test tour: log in as each role, screenshot key screens, report HTTP/console errors. */
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = "http://localhost:3000";
const OUT = "/tmp/shots";
fs.mkdirSync(OUT, { recursive: true });

const tours = [
  {
    email: "tech@apexplumbing.demo",
    role: "tech",
    pages: ["/my-day", "/inventory", "/kb", "/earnings"],
    mobile: true,
  },
  {
    email: "sales@apexplumbing.demo",
    role: "sales",
    pages: ["/cockpit", "/leads", "/pipeline", "/estimates", "/projects", "/kb"],
  },
  {
    email: "office@apexplumbing.demo",
    role: "office",
    pages: ["/dispatch", "/jobs", "/customers", "/invoices", "/inventory"],
  },
  {
    email: "owner@apexplumbing.demo",
    role: "admin",
    pages: ["/dashboard", "/commissions", "/pricebook", "/settings", "/settings?tab=integrations", "/search?q=water"],
  },
];

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
let failures = 0;

for (const tour of tours) {
  const ctx = await browser.newContext({
    viewport: tour.mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
  page.on("response", (r) => {
    if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.url()}`);
  });

  await page.goto(`${BASE}/login`);
  await page.fill("#email", tour.email);
  await page.fill("#password", "demo1234");
  await page.click("button[type=submit]");
  await page.waitForLoadState("networkidle");

  for (const path of tour.pages) {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    const name = `${tour.role}-${path.replace(/[\/?=]+/g, "_").replace(/^_/, "") || "home"}`;
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
    const bodyText = await page.innerText("body");
    const broken =
      bodyText.includes("Application error") ||
      bodyText.includes("This page could not be found") ||
      bodyText.includes("Unhandled Runtime Error");
    console.log(`${broken ? "❌" : "✅"} [${tour.role}] ${path}`);
    if (broken) failures++;
  }
  if (errors.length) {
    console.log(`   ⚠ ${tour.role} console/HTTP errors:`, errors.slice(0, 5));
    failures += errors.length;
  }
  await ctx.close();
}

await browser.close();
console.log(failures === 0 ? "TOUR-CLEAN" : `TOUR-FAILURES:${failures}`);
