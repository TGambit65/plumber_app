import { chromium, devices } from "playwright";
const BASE = "http://localhost:3000";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await browser.newContext({ ...devices["iPhone 13"] });
const page = await ctx.newPage();
const ok = (l,b)=>console.log(`${b?"✅":"❌"} ${l}`);

await page.goto(`${BASE}/login`);
await page.fill('input[name=email]','tech@apexplumbing.demo');
await page.fill('input[name=password]','demo1234');
await page.click('button[type=submit]');
await page.waitForLoadState("networkidle");
await page.goto(`${BASE}/field`, { waitUntil:"networkidle" });

// Manifest linked + parseable
const manifestHref = await page.getAttribute('link[rel=manifest]', 'href').catch(()=>null);
ok(`manifest linked in <head> (${manifestHref})`, !!manifestHref);
const m = await page.evaluate(async (h)=>{ const r=await fetch(h); return r.ok?await r.json():null; }, manifestHref);
ok("manifest parses; display=standalone; start_url=/field", m && m.display==="standalone" && m.start_url==="/field");
ok(`manifest has 192+512 icons (${(m?.icons||[]).length})`, (m?.icons||[]).some(i=>i.sizes?.includes("192"))&&(m?.icons||[]).some(i=>i.sizes?.includes("512")));

// theme-color + apple-web-app meta
const theme = await page.getAttribute('meta[name=theme-color]','content').catch(()=>null);
ok(`theme-color meta present (${theme})`, !!theme);
const appleCap = await page.getAttribute('meta[name=apple-mobile-web-app-capable]','content').catch(()=>null);
ok(`apple-mobile-web-app-capable (${appleCap})`, appleCap==="yes");

// Icons load (not 404)
for (const path of ["/icon.svg","/icon-192.png","/icon-512.png"]) {
  const st = await page.evaluate(async(p)=>{const r=await fetch(p);return r.status;},path);
  ok(`icon ${path} → ${st}`, st===200);
}

// Service worker registers + activates
const swState = await page.evaluate(async ()=>{
  if (!("serviceWorker" in navigator)) return "unsupported";
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return "none";
  // wait up to 5s for activation
  for (let i=0;i<25;i++){ if (navigator.serviceWorker.controller || reg.active) return reg.active?.state||"active"; await new Promise(r=>setTimeout(r,200)); }
  return "pending";
});
ok(`service worker active (${swState})`, swState==="activated"||swState==="active");

await browser.close();
