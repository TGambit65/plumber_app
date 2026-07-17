/* Mobile audit: every screen at iPhone viewport (390×844). Checks HTTP status,
   console/page errors, horizontal overflow, and tiny tap targets; screenshots each. */
import { chromium, devices } from "playwright";
import fs from "node:fs";

const BASE = "http://localhost:3000";
const OUT = "/tmp/mobile";
fs.mkdirSync(OUT, { recursive: true });

const IDS = {
  customer: "81b7fe43-e89e-4f64-b8e2-24eb1d2c414d",
  job: "54da7652-854f-4572-9329-7efefa27d30a",
  estimate: "86b46261-975d-4bbb-9edf-e1b254de1a45",
  lead: "5640d346-67e6-46d2-b807-7d6edf3f2b57",
  claim: "eb5187db-8e64-4de3-b088-274e7a6c9b1b",
  project: "600b589b-6c50-4def-aae9-b775112f8b10",
  inspection: "eee3277c-0461-467d-b6ac-5c1b47fa09d1",
  kbslug: "discount-policy",
  conversation: "8f5ab607-4175-4b85-aead-66739c736a29",
};

const TOURS = [
  {
    role: "tech",
    email: "tech@apexplumbing.demo",
    screens: ["/my-day", "/field", "/inventory", "/kb", `/kb/${IDS.kbslug}`, "/messages", "/earnings", "/search?q=water"],
  },
  {
    role: "sales",
    email: "sales@apexplumbing.demo",
    screens: ["/cockpit", "/leads", `/leads/${IDS.lead}`, "/pipeline", "/estimates", `/estimates/${IDS.estimate}`, "/projects", `/projects/${IDS.project}`, "/claims", `/claims/${IDS.claim}`, "/customers", `/customers/${IDS.customer}`, "/messages", "/kb", "/earnings"],
  },
  {
    role: "office",
    email: "office@apexplumbing.demo",
    screens: ["/dispatch", "/approvals", "/jobs", `/jobs/${IDS.job}`, `/jobs/${IDS.job}/closeout`, "/customers", "/leads", "/invoices", "/claims", "/compliance", `/compliance/inspections/${IDS.inspection}`, "/inventory", "/messages", `/messages/${IDS.conversation}`, "/kb"],
  },
  {
    role: "admin",
    email: "owner@apexplumbing.demo",
    screens: ["/dashboard", "/dispatch", "/approvals", "/pipeline", "/jobs", "/projects", "/customers", "/invoices", "/claims", "/compliance", "/inventory", "/pricebook", "/commissions", "/messages", "/kb", "/settings", "/settings?tab=integrations", `/claims/${IDS.claim}`],
  },
];

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const iPhone = devices["iPhone 13"];
const results = [];

for (const tour of TOURS) {
  const ctx = await browser.newContext({ ...iPhone });
  const page = await ctx.newPage();

  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
  });
  page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + String(e).slice(0, 200)));

  // login
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="email"]', tour.email);
  await page.fill('input[name="password"]', "demo1234");
  await page.click('button[type="submit"]');
  await page.waitForLoadState("networkidle");

  for (const screen of tour.screens) {
    consoleErrors.length = 0;
    let status = 0;
    try {
      const resp = await page.goto(`${BASE}${screen}`, { waitUntil: "networkidle", timeout: 20000 });
      status = resp ? resp.status() : 0;
    } catch (e) {
      results.push({ role: tour.role, screen, status: "NAV_ERR", overflow: null, overflowPx: null, errors: [String(e).slice(0, 120)], tinyTaps: null });
      continue;
    }
    await page.waitForTimeout(400);

    // Horizontal overflow: does content exceed the viewport width?
    const metrics = await page.evaluate(() => {
      const de = document.documentElement;
      const vw = window.innerWidth;
      const scrollW = de.scrollWidth;
      // find worst offending elements sticking out past the right edge
      const offenders = [];
      for (const el of Array.from(document.body.querySelectorAll("*"))) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > vw + 1) {
          offenders.push({
            tag: el.tagName.toLowerCase(),
            cls: (el.className && typeof el.className === "string" ? el.className : "").slice(0, 60),
            right: Math.round(r.right),
          });
        }
      }
      offenders.sort((a, b) => b.right - a.right);
      // tap targets: interactive elements smaller than 32px in a dimension
      let tiny = 0;
      for (const el of Array.from(document.querySelectorAll("a,button,[role=button],input[type=checkbox]"))) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && (r.height < 32 || r.width < 24)) tiny++;
      }
      return { vw, scrollW, overflow: scrollW > vw + 1, offenders: offenders.slice(0, 3), tiny };
    });

    const slug = `${tour.role}${screen.replace(/[/?=&]/g, "_")}`;
    await page.screenshot({ path: `${OUT}/${slug}.png`, fullPage: false }).catch(() => {});

    results.push({
      role: tour.role,
      screen,
      status,
      overflow: metrics.overflow,
      overflowPx: metrics.overflow ? metrics.scrollW - metrics.vw : 0,
      offenders: metrics.offenders,
      errors: [...consoleErrors],
      tinyTaps: metrics.tiny,
    });
  }
  await ctx.close();
}
await browser.close();

// Report
let bad = 0;
console.log("\n=== MOBILE AUDIT (390×844 iPhone 13) ===\n");
for (const r of results) {
  const problems = [];
  if (r.status !== 200) problems.push(`HTTP ${r.status}`);
  if (r.overflow) problems.push(`H-OVERFLOW +${r.overflowPx}px [${(r.offenders || []).map((o) => `${o.tag}.${o.cls}@${o.right}`).join(", ")}]`);
  if (r.errors && r.errors.length) problems.push(`${r.errors.length} console err`);
  const ok = problems.length === 0;
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "⚠️ "} ${r.role.padEnd(6)} ${r.screen.padEnd(42)} ${problems.join(" | ")}`);
  if (r.errors && r.errors.length) for (const e of r.errors.slice(0, 2)) console.log(`      ↳ ${e}`);
}
console.log(`\n${results.length} screens tested · ${bad} with issues · screenshots in ${OUT}`);
fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
