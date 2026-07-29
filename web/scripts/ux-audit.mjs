/**
 * Functional UX audit — drives the app as each role and reports what a human
 * can actually DO on every screen.
 *
 * Not a code review: it logs in for real, walks every nav destination plus the
 * detail routes reachable from them, and records the affordances present.
 * The question it answers is "is this screen a dead end?" — a list you cannot
 * add to, a detail you cannot edit, a page that renders but does nothing.
 */
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE || "http://localhost:3300";
const OUT = process.env.OUT || "/tmp/ux";
fs.mkdirSync(OUT, { recursive: true });

const PASSWORD = "demo1234";

const ROLES = [
  { key: "tech", email: "tech@plumbzebra.demo", mobile: true },
  { key: "sales", email: "sales@plumbzebra.demo", mobile: false },
  { key: "office", email: "office@plumbzebra.demo", mobile: false },
  { key: "admin", email: "owner@plumbzebra.demo", mobile: false },
];

// Words that signal "you can create the primary thing on this screen".
const CREATE_RE = /^(\+|new |add |create |book |start |log |record |import |issue |raise |draft )/i;
const CREATE_WORD_RE = /(new|add|create|book|import)\b/i;

async function login(page, email) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => {}),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForTimeout(400);
  return !page.url().includes("/login");
}

async function auditPage(page, path) {
  const errors = [];
  const onErr = (m) => m.type() === "error" && errors.push(m.text().slice(0, 160));
  page.on("console", onErr);

  let status = 0;
  const resp = await page
    .goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 25000 })
    .catch(() => null);
  status = resp ? resp.status() : 0;
  await page.waitForTimeout(250);

  const data = await page.evaluate(() => {
    const txt = (el) => (el?.innerText || "").trim().replace(/\s+/g, " ");
    const main = document.querySelector("main") || document.body;

    const buttons = [...main.querySelectorAll("button")].map((b) => ({
      label: txt(b).slice(0, 60),
      disabled: b.disabled,
      type: b.type,
      inForm: !!b.closest("form"),
    }));
    const links = [...main.querySelectorAll("a[href]")].map((a) => ({
      label: txt(a).slice(0, 60),
      href: a.getAttribute("href"),
    }));
    const forms = [...main.querySelectorAll("form")].map((f) => ({
      inputs: f.querySelectorAll("input,select,textarea").length,
      hasSubmit: !!f.querySelector('button[type="submit"], button:not([type])'),
      // A form the user cannot see until they expand a disclosure.
      hidden: !!f.closest("details:not([open])"),
    }));

    // Disclosure widgets. Create actions living in here are functionally
    // present but visually absent — the crawler missed them the first time,
    // which is the same failure mode a hurried dispatcher has.
    const summaries = [...main.querySelectorAll("details > summary")].map((s) => ({
      label: txt(s).slice(0, 60),
      open: s.parentElement.hasAttribute("open"),
    }));

    const bodyText = txt(main);
    return {
      h1: txt(main.querySelector("h1")).slice(0, 80),
      chars: bodyText.length,
      buttons,
      links,
      forms,
      summaries,
      inputs: main.querySelectorAll("input,select,textarea").length,
      tables: main.querySelectorAll("table").length,
      rows: main.querySelectorAll("tbody tr").length,
      // Heuristic empty-state detection.
      emptyish: /no (results|records|jobs|leads|customers|invoices|estimates|projects|photos|items|messages|claims|inspections|threads|entries|data)\b|nothing (here|yet|to)|none yet|get started by/i.test(
        bodyText
      ),
    };
  });

  page.off("console", onErr);

  const isCreate = (l) => CREATE_RE.test(l) || (l.length < 28 && CREATE_WORD_RE.test(l));
  const visible = [...data.buttons.map((b) => b.label), ...data.links.map((l) => l.label)].filter(Boolean);
  const createVisible = visible.filter(isCreate);
  // Same intent, but collapsed behind a disclosure the user must find first.
  const createHidden = (data.summaries || []).filter((s) => !s.open && isCreate(s.label)).map((s) => s.label);
  const hiddenForms = (data.forms || []).filter((f) => f.hidden).length;

  return { path, status, ...data, createVisible, createHidden, hiddenForms, consoleErrors: errors };
}

const NAV_BY_ROLE = {
  tech: ["/my-day", "/field", "/inventory", "/kb", "/messages", "/earnings"],
  sales: ["/cockpit", "/leads", "/pipeline", "/estimates", "/projects", "/claims", "/customers", "/messages", "/kb", "/earnings"],
  office: ["/dispatch", "/approvals", "/jobs", "/customers", "/leads", "/invoices", "/claims", "/compliance", "/inventory", "/messages", "/kb"],
  admin: [
    "/dashboard", "/dispatch", "/approvals", "/pipeline", "/jobs", "/projects", "/customers",
    "/invoices", "/claims", "/compliance", "/inventory", "/pricebook", "/commissions",
    "/messages", "/kb", "/settings", "/search?q=water", "/dispatch/optimize", "/cockpit",
  ],
};

/** Detail routes: discovered by following the first in-app link from each list. */
async function firstDetailLink(page, listPath, pattern) {
  await page.goto(`${BASE}${listPath}`, { waitUntil: "networkidle" }).catch(() => {});
  const href = await page.evaluate((p) => {
    const re = new RegExp(p);
    const a = [...document.querySelectorAll("main a[href]")].find((x) => re.test(x.getAttribute("href") || ""));
    return a ? a.getAttribute("href") : null;
  }, pattern);
  return href;
}

const results = {};

const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}
);
for (const role of ROLES) {
  const ctx = await browser.newContext({
    viewport: role.mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();

  const ok = await login(page, role.email);
  if (!ok) {
    results[role.key] = { loginFailed: true };
    console.error(`LOGIN FAILED: ${role.email}`);
    await ctx.close();
    continue;
  }

  const pages = [];
  for (const path of NAV_BY_ROLE[role.key]) {
    const r = await auditPage(page, path);
    pages.push(r);
    const safe = path.replace(/[^a-z0-9]/gi, "_");
    await page.screenshot({ path: `${OUT}/${role.key}${safe}.png`, fullPage: false }).catch(() => {});
  }

  // Follow into detail screens — that is where "cannot edit" hides.
  const detailTargets = [
    ["/jobs", "^/jobs/[a-f0-9-]{8,}$"],
    ["/customers", "^/customers/[a-f0-9-]{8,}$"],
    ["/projects", "^/projects/[a-f0-9-]{8,}$"],
    ["/estimates", "^/estimates/[a-f0-9-]{8,}$"],
    ["/invoices", "^/invoices/[a-f0-9-]{8,}$"],
    ["/leads", "^/leads/[a-f0-9-]{8,}$"],
    ["/claims", "^/claims/[a-f0-9-]{8,}$"],
  ];
  for (const [list, pat] of detailTargets) {
    if (!NAV_BY_ROLE[role.key].includes(list)) continue;
    const href = await firstDetailLink(page, list, pat);
    if (!href) {
      pages.push({ path: `${list} → (no detail link found)`, status: -1, noDetailLink: true });
      continue;
    }
    const r = await auditPage(page, href);
    r.viaList = list;
    pages.push(r);
    await page.screenshot({ path: `${OUT}/${role.key}_detail_${list.replace(/\W/g, "")}.png` }).catch(() => {});
  }

  results[role.key] = { email: role.email, pages };
  await ctx.close();
}
await browser.close();

fs.writeFileSync(`${OUT}/audit.json`, JSON.stringify(results, null, 2));

// ── Report ──────────────────────────────────────────────────────────────────
for (const [role, data] of Object.entries(results)) {
  if (data.loginFailed) {
    console.log(`\n### ${role.toUpperCase()} — LOGIN FAILED`);
    continue;
  }
  console.log(`\n### ${role.toUpperCase()} (${data.email})`);
  console.log(
    ["path", "st", "h1", "rows", "btns", "inputs", "create?", "empty?"].map((h) => h.padEnd(h === "path" ? 34 : 7)).join("")
  );
  for (const p of data.pages) {
    if (p.noDetailLink) {
      console.log(`${p.path.padEnd(34)}  NO DETAIL LINK FROM LIST`);
      continue;
    }
    const create = p.createVisible?.length
      ? p.createVisible.slice(0, 2).join("|").slice(0, 28)
      : p.createHidden?.length
        ? "HIDDEN: " + p.createHidden.slice(0, 1).join("").slice(0, 20)
        : "— NONE —";
    console.log(
      p.path.padEnd(34) +
        String(p.status).padEnd(7) +
        (p.h1 || "(no h1)").slice(0, 22).padEnd(7 + 15) +
        String(p.rows ?? "").padEnd(7) +
        String(p.buttons?.length ?? "").padEnd(7) +
        String(p.inputs ?? "").padEnd(7) +
        create.padEnd(32) +
        (p.hiddenForms ? `${p.hiddenForms} hidden form(s) ` : "") +
        (p.emptyish ? "EMPTY" : "")
    );
    if (p.consoleErrors?.length) console.log(`      ⚠ console: ${p.consoleErrors[0]}`);
  }
}
console.log(`\nScreenshots + audit.json in ${OUT}`);
