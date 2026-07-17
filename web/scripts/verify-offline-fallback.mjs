/* Verifies the SW /offline fallback: while offline, a never-visited route
   is served the cached /offline page (not a network error). Clean context —
   no mid-test reload, so the emulated offline state is reliable. */
import { chromium, devices } from "playwright";
const BASE = "http://localhost:3000";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await b.newContext({ ...devices["iPhone 13"] });
const page = await ctx.newPage();
let fail = 0; const check = (l, ok) => { console.log(`${ok ? "✅" : "❌"} ${l}`); if (!ok) fail++; };
await page.goto(`${BASE}/login`);
await page.fill('input[name=email]', 'tech@apexplumbing.demo');
await page.fill('input[name=password]', 'demo1234');
await page.click('button[type=submit]');
await page.waitForLoadState("networkidle");
await page.goto(`${BASE}/field`, { waitUntil: "networkidle" });
await page.evaluate(async () => { for (let i = 0; i < 30 && !navigator.serviceWorker.controller; i++) await new Promise(r => setTimeout(r, 200)); });
const caches0 = await page.evaluate(async () => { const ks = await caches.keys(); const c = await caches.open(ks.find(k => k.includes("shell"))); return (await c.keys()).map(r => new URL(r.url).pathname); });
check(`/offline is precached (${caches0.join(",")})`, caches0.includes("/offline"));
await ctx.setOffline(true);
const resp = await page.goto(`${BASE}/never-${Date.now()}`, { waitUntil: "domcontentloaded" }).catch(() => null);
const body = (await page.textContent("body").catch(() => "")).replace(/\s+/g, " ");
check(`uncached route offline → /offline page served (status ${resp ? resp.status() : "?"})`, /You'?re offline|no signal/i.test(body));
await b.close();
console.log(fail === 0 ? "\nOFFLINE FALLBACK VERIFIED" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
