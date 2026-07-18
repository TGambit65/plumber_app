/* Verifies the OFFLINE EN_ROUTE path: sync push → post-commit on-my-way SMS, deduped. */
import { chromium } from "playwright";
import { Pool } from "pg";
const BASE = "http://localhost:3000";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
async function pz(q){const c=await pool.connect();try{await c.query("BEGIN");await c.query("SELECT set_config('app.current_org',(SELECT id FROM organizations WHERE slug='plumb-zebra'),true)");const r=await c.query(q);await c.query("COMMIT");return r.rows}finally{c.release()}}
let fail=0; const check=(l,ok)=>{console.log(`${ok?"✅":"❌"} ${l}`); if(!ok)fail++;};

// Reset: a DISPATCHED job for the routable customer, no prior ON_MY_WAY for it.
const [job] = await pz(`SELECT j.id FROM jobs j JOIN customers c ON c.id=j.customer_id WHERE c.phone='+15095550142' AND j.status IN ('EN_ROUTE','DISPATCHED') LIMIT 1`);
await pz(`UPDATE jobs SET status='DISPATCHED' WHERE id='${job.id}'`);
await pz(`DELETE FROM outbound_messages WHERE kind='ON_MY_WAY' AND job_id='${job.id}'`);
await pz(`UPDATE customers SET sms_opt_out=false WHERE phone='+15095550142'`);
const before = (await (await fetch("http://localhost:8904/__messages")).json()).length;

const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await (await b.newContext()).newPage();
await page.goto(`${BASE}/login`);
await page.fill('input[name=email]','tech@plumbzebra.demo');
await page.fill('input[name=password]','demo1234');
await page.click('button[type=submit]');
await page.waitForLoadState("networkidle");

const push = (ts) => page.evaluate(async ({jobId, ts}) => {
  const res = await fetch("/api/sync/push", { method:"POST", headers:{"content-type":"application/json"},
    body: JSON.stringify({ changes: [{ entityType:"job", entityId:jobId, action:"update", data:{ status:"EN_ROUTE" }, clientTimestamp: ts }] }) });
  return res.json();
}, { jobId: job.id, ts });

const r1 = await push(new Date(Date.now()+5000).toISOString());
check(`offline sync push applied EN_ROUTE (${r1.results?.[0]?.status})`, r1.results?.[0]?.status === "updated");
await page.waitForTimeout(800);
const mid = (await (await fetch("http://localhost:8904/__messages")).json());
check(`post-commit hook sent the on-my-way SMS (+${mid.length-before})`, mid.length === before+1 && mid[mid.length-1].body.includes("on the way"));

// Re-push the same transition (offline queue replay) → deduped, no second text.
const r2 = await push(new Date(Date.now()+10000).toISOString());
await page.waitForTimeout(800);
const after = (await (await fetch("http://localhost:8904/__messages")).json()).length;
check(`replayed EN_ROUTE push does NOT double-text (count ${mid.length}→${after})`, after === mid.length);

await b.close(); await pool.end();
console.log(fail===0?"\nOFFLINE ON-MY-WAY VERIFIED":`\n${fail} FAILED`);
process.exit(fail===0?0:1);
