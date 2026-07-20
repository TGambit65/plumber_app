/* E2E: Phase C1 — the customer-facing loop.
   Internal send → approval queue → REAL email (mock Mailgun) with proposal
   link → logged-out customer opens /proposal/[token] (views tracked) →
   e-signs an option (commission + sold job + lead WON) → decline path →
   invoice send emails a /pay/[token] link → Stripe Checkout (mock) → signed
   webhook records the payment → forged webhook 403.
   Requires: next on :3000 (fresh build), seeded Plumb Zebra tenant,
   mock-mailgun on :8909, mock-stripe on :8910. */
import { chromium } from "playwright";
import { Pool } from "pg";

const BASE = "http://localhost:3000";
const MAILGUN = "http://localhost:8909";
const STRIPE = "http://localhost:8910";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
let failures = 0;
const check = (l, ok) => { console.log(`${ok ? "✅" : "❌"} ${l}`); if (!ok) failures++; };

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
async function pz(q) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.current_org',(SELECT id FROM organizations WHERE slug='plumb-zebra'),true)");
    const r = await c.query(q);
    await c.query("COMMIT");
    return r.rows;
  } finally { c.release(); }
}
const audits = async (action) => pz(`SELECT * FROM audit_logs WHERE action='${action}' ORDER BY created_at DESC LIMIT 5`);

async function login(page, email) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "demo1234");
  await page.click('button[type="submit"]');
  await page.waitForLoadState("networkidle");
}
const settle = async (page, ms = 900) => { await page.waitForLoadState("networkidle"); await page.waitForTimeout(ms); };

// ═══ BOOTSTRAP — live connectors (pointed at mocks) + C1 fixtures ════════════
const DECLINE_TOKEN = "c1declinetoken00000000000000000000000000000000aa";
{
  await pz(`INSERT INTO integration_connections (id, provider, status, config) VALUES
    ('c1-email','EMAIL','CONNECTED','{"domain":"mg.plumbzebra.demo","fromAddress":"Plumb Zebra <office@plumbzebra.demo>","apiKey":"mailgun-e2e-key","baseUrl":"${MAILGUN}"}'),
    ('c1-stripe','STRIPE','CONNECTED','{"apiKey":"sk_test_e2e","webhookSecret":"whsec_e2e","baseUrl":"${STRIPE}"}')
    ON CONFLICT (organization_id, provider) DO UPDATE SET status='CONNECTED', config=EXCLUDED.config`);

  const [boyd] = await pz(`SELECT id, email FROM customers WHERE name LIKE '%Boyd%' LIMIT 1`);
  const [sandra] = await pz(`SELECT id FROM customers WHERE name='Sandra Ellis' LIMIT 1`);
  const [prop] = await pz(`SELECT id FROM properties WHERE customer_id='${boyd.id}' LIMIT 1`);
  const [propS] = await pz(`SELECT id FROM properties WHERE customer_id='${sandra.id}' LIMIT 1`);
  const [sales] = await pz(`SELECT id FROM users WHERE email='sales@plumbzebra.demo'`);

  await pz(`INSERT INTO leads (id, source, stage, title, contact_name, phone, email, customer_id, assigned_to_id)
    VALUES ('c1-lead','WEB_FORM','ESTIMATE_SENT','C1 water heater replacement','Erica Boyd','555-2002','${boyd.email}','${boyd.id}','${sales.id}'),
           ('c1-lead2','PHONE','ESTIMATE_SENT','C1 decline-path lead','Sandra Ellis','555-2004',NULL,'${sandra.id}','${sales.id}')
    ON CONFLICT (id) DO UPDATE SET stage='ESTIMATE_SENT'`);

  await pz(`INSERT INTO estimates (id, number, status, customer_id, property_id, lead_id, created_by_id, notes)
    VALUES ('c1-est','E-C101','DRAFT','${boyd.id}','${prop.id}','c1-lead','${sales.id}','C1 loop test estimate'),
           ('c1-est2','E-C102','SENT','${sandra.id}','${propS.id}','c1-lead2','${sales.id}','C1 decline-path estimate')
    ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, signed_name=NULL, signed_at=NULL, job_id=NULL, public_token=NULL, view_count=0`);
  await pz(`UPDATE estimates SET sent_at=now(), expires_at=now() + interval '30 days', public_token='${DECLINE_TOKEN}' WHERE id='c1-est2'`);

  await pz(`INSERT INTO estimate_options (id, estimate_id, tier, name, description, sort_order) VALUES
    ('c1-opt-good','c1-est','GOOD','Standard Replacement','Like-for-like swap',0),
    ('c1-opt-better','c1-est','BETTER','Professional Package','Premium unit + expansion tank',1),
    ('c1-opt2','c1-est2','GOOD','Base option','',0)
    ON CONFLICT (id) DO UPDATE SET selected=false`);
  await pz(`INSERT INTO estimate_line_items (id, option_id, description, qty, unit_price_cents, unit_cost_cents) VALUES
    ('c1-li-1','c1-opt-good','50-gal gas water heater',1,50000,30000),
    ('c1-li-2','c1-opt-better','Premium 50-gal unit',1,100000,60000),
    ('c1-li-3','c1-opt-better','Expansion tank + pan',1,20000,8000),
    ('c1-li-4','c1-opt2','Base work',1,40000,20000)
    ON CONFLICT (id) DO NOTHING`);
  await pz(`INSERT INTO follow_ups (id, estimate_id, channel, status, due_at, body)
    VALUES ('c1-fu-1','c1-est2','SMS','PENDING', now() + interval '1 day','C1 decline-path follow-up')
    ON CONFLICT (id) DO UPDATE SET status='PENDING'`);

  await pz(`INSERT INTO invoices (id, number, status, customer_id)
    VALUES ('c1-inv','INV-C101','DRAFT','${boyd.id}')
    ON CONFLICT (id) DO UPDATE SET status='DRAFT', public_token=NULL`);
  await pz(`INSERT INTO invoice_line_items (id, invoice_id, description, qty, unit_price_cents)
    VALUES ('c1-inv-li','c1-inv','C1 water heater install balance',1,35000)
    ON CONFLICT (id) DO NOTHING`);
  await pz(`DELETE FROM payments WHERE invoice_id='c1-inv'`);
  console.log("Bootstrapped C1 fixtures + live connectors (mock endpoints)");
}

const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
const page = await ctx.newPage();
await login(page, "owner@plumbzebra.demo");

// ═══ 1. SEND: queue → approve → REAL email with the proposal link ════════════
let proposalToken;
{
  await page.goto(`${BASE}/estimates/c1-est`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.click('button:has-text("Mark sent")');
  await settle(page);

  const [ob] = await pz(`SELECT id FROM outbound_messages WHERE estimate_id='c1-est' AND status='PENDING_APPROVAL'`);
  check("estimate send queued for approval (nothing left the building yet)", !!ob);
  const preMail = await (await fetch(`${MAILGUN}/__messages`)).json();

  await page.goto(`${BASE}/approvals`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.locator(`form:has(input[name="id"][value="${ob.id}"]) button:has-text("Approve")`).click();
  await settle(page, 1200);

  const [est] = await pz(`SELECT status, public_token FROM estimates WHERE id='c1-est'`);
  proposalToken = est.public_token;
  check("approval flips estimate to SENT and mints a public token", est.status === "SENT" && /^[0-9a-f]{48}$/.test(est.public_token ?? ""));

  const mail = await (await fetch(`${MAILGUN}/__messages`)).json();
  const sent = mail.slice(preMail.length).find((m) => (m.to ?? "").includes("boyds@example.com"));
  check("REAL email left via the Mailgun API with the proposal link", !!sent && sent.text.includes(`/proposal/${proposalToken}`) && sent.subject.includes("E-C101"));

  const [obAfter] = await pz(`SELECT status, delivery_status, external_sid, recipient FROM outbound_messages WHERE id='${ob.id}'`);
  check("approval row records the honest delivery (channel, provider id)",
    obAfter.status === "APPROVED_SENT" && obAfter.delivery_status === "SENT" && (obAfter.external_sid ?? "").includes("@mg.plumbzebra.demo") && obAfter.recipient === "boyds@example.com");

  const fus = await pz(`SELECT count(*)::int n FROM follow_ups WHERE estimate_id='c1-est'`);
  check("7-day follow-up cadence started on send", fus[0].n === 7);

  await page.goto(`${BASE}/estimates/c1-est`, { waitUntil: "networkidle" });
  const body = await page.textContent("body");
  check("internal estimate page surfaces the customer proposal link", body.includes(`/proposal/${est.public_token}`));
}

// ═══ 2. CUSTOMER OPENS THE PROPOSAL (no login) — views tracked ═══════════════
const cust = await browser.newContext({ viewport: { width: 430, height: 930 } }); // phone-ish
const cpage = await cust.newPage();
{
  await cpage.goto(`${BASE}/proposal/${proposalToken}`, { waitUntil: "networkidle" });
  await cpage.waitForTimeout(600);
  const body = await cpage.textContent("body");
  check("public proposal renders branded, logged-out (org name + options + totals)",
    body.includes("Plumb Zebra") && body.includes("Professional Package") && body.includes("$1,200") && body.includes("Approve"));
  check("financing framing on the option cards", body.includes("/mo with financing"));

  const [est1] = await pz(`SELECT status, view_count FROM estimates WHERE id='c1-est'`);
  check("open counted as a view and SENT → VIEWED", est1.status === "VIEWED" && est1.view_count >= 1);

  await cpage.reload({ waitUntil: "networkidle" });
  await cpage.waitForTimeout(600);
  const hot = await pz(`SELECT count(*)::int n FROM notifications WHERE title LIKE '%viewed E-C101%'`);
  check("2nd view fires the hot-signal notification to the creator", hot[0].n >= 1);
  const acts = await pz(`SELECT count(*)::int n FROM activities WHERE kind='ESTIMATE_VIEW' AND body LIKE '%E-C101%'`);
  check("every view lands on the timeline", acts[0].n >= 2);

  const forged = await cpage.goto(`${BASE}/proposal/000000000000000000000000000000000000000000000000`);
  check("guessing a token 404s", forged.status() === 404);
  await cpage.goto(`${BASE}/proposal/${proposalToken}`, { waitUntil: "networkidle" });
  await cpage.waitForTimeout(600);
}

// ═══ 3. CUSTOMER E-SIGNS FROM THEIR PHONE ════════════════════════════════════
{
  await cpage.locator('input[name="optionId"][value="c1-opt-better"]').check();
  await cpage.fill('input[name="signedName"]', "Erica Boyd");
  await cpage.click('button:has-text("Approve & e-sign")');
  await settle(cpage, 1200);

  const [est] = await pz(`SELECT status, signed_name, job_id FROM estimates WHERE id='c1-est'`);
  check("estimate APPROVED with the customer's e-signature", est.status === "APPROVED" && est.signed_name === "Erica Boyd");
  const [opt] = await pz(`SELECT selected FROM estimate_options WHERE id='c1-opt-better'`);
  check("chosen option marked selected", opt.selected === true);

  const [com] = await pz(`SELECT amount_cents, status FROM commission_entries WHERE source_type='ESTIMATE' AND source_id='c1-est'`);
  check("5% commission created for the estimate's creator ($60 of $1,200)", com?.amount_cents === 6000 && com?.status === "PENDING");

  const [job] = await pz(`SELECT j.number, j.status FROM jobs j JOIN estimates e ON e.job_id=j.id WHERE e.id='c1-est'`);
  check("sold job auto-created from the approval", !!job && job.status === "UNSCHEDULED");

  const fus = await pz(`SELECT count(*)::int n FROM follow_ups WHERE estimate_id='c1-est' AND status='PENDING'`);
  check("follow-up sequence auto-stopped (customer answered)", fus[0].n === 0);
  const [lead] = await pz(`SELECT stage FROM leads WHERE id='c1-lead'`);
  check("lead marked WON", lead.stage === "WON");

  const [aud] = await audits("ESTIMATE_APPROVED");
  check("approval audited as public_proposal (no internal user)", aud?.detail?.via === "public_proposal" && aud?.user_id === null);

  const body = await cpage.textContent("body");
  check("customer sees the confirmation state", body.includes("all set"));
}

// ═══ 4. DECLINE PATH ═════════════════════════════════════════════════════════
{
  await cpage.goto(`${BASE}/proposal/${DECLINE_TOKEN}`, { waitUntil: "networkidle" });
  await cpage.waitForTimeout(600);
  await cpage.locator("details:has(textarea[name='reason'])").evaluate((el) => { el.open = true; });
  await cpage.fill('textarea[name="reason"]', "Going with another bid");
  await cpage.click('button:has-text("Decline this proposal")');
  await settle(cpage, 1200);

  const [est] = await pz(`SELECT status FROM estimates WHERE id='c1-est2'`);
  check("estimate DECLINED by the customer", est.status === "DECLINED");
  const [fu] = await pz(`SELECT status FROM follow_ups WHERE id='c1-fu-1'`);
  check("decline stops the follow-up sequence", fu.status === "SKIPPED");
  const [lead] = await pz(`SELECT stage, lost_reason FROM leads WHERE id='c1-lead2'`);
  check("lead LOST with the customer's own words", lead.stage === "LOST" && lead.lost_reason.includes("another bid"));
  const [aud] = await audits("ESTIMATE_DECLINED");
  check("decline audited with the reason", aud?.detail?.via === "public_proposal" && aud?.detail?.reason?.includes("another bid"));
}

// ═══ 5. INVOICE SEND → PAY LINK EMAIL ════════════════════════════════════════
let payToken;
{
  const preMail = await (await fetch(`${MAILGUN}/__messages`)).json();
  await page.goto(`${BASE}/invoices`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.locator(`form:has(input[name="invoiceId"][value="c1-inv"]) button:has-text("Mark sent")`).click();
  await settle(page, 1200);

  const [inv] = await pz(`SELECT status, public_token FROM invoices WHERE id='c1-inv'`);
  payToken = inv.public_token;
  check("invoice SENT with a minted pay token", inv.status === "SENT" && /^[0-9a-f]{48}$/.test(inv.public_token ?? ""));

  const mail = await (await fetch(`${MAILGUN}/__messages`)).json();
  const sent = mail.slice(preMail.length).find((m) => (m.subject ?? "").includes("INV-C101"));
  check("invoice email carries the balance + pay link", !!sent && sent.text.includes(`/pay/${payToken}`) && sent.text.includes("$350"));
}

// ═══ 6. CUSTOMER PAYS ONLINE (hosted checkout + signed webhook) ══════════════
{
  await cpage.goto(`${BASE}/pay/${payToken}`, { waitUntil: "networkidle" });
  await cpage.waitForTimeout(600);
  const body = await cpage.textContent("body");
  check("public pay page shows the invoice + balance, logged out",
    body.includes("INV-C101") && body.includes("$350") && body.includes("Pay $350 now"));

  await cpage.click('button:has-text("Pay $350 now")');
  await cpage.waitForURL(/localhost:8910\/checkout\//, { timeout: 15000 });
  check("Pay now redirects to the hosted Stripe checkout", cpage.url().startsWith(`${STRIPE}/checkout/`));

  const sessions = await (await fetch(`${STRIPE}/__sessions`)).json();
  const sess = sessions.find((s) => s.client_reference_id === "c1-inv");
  check("checkout session created for OUR invoice id at the open balance", !!sess && sess.amount_total === 35000);

  // Customer completes payment → mock fires the SIGNED webhook at the app.
  const done = await (await fetch(`${STRIPE}/__complete/${sess.id}`, { method: "POST" })).json();
  check("signed webhook accepted and payment recorded", done.webhook?.status === 200 && done.webhook?.body?.recorded === true);

  const [pay] = await pz(`SELECT amount_cents, method, reference FROM payments WHERE invoice_id='c1-inv'`);
  check("payment row: $350 CARD with the provider reference", pay?.amount_cents === 35000 && pay?.method === "CARD" && pay?.reference === `pi_${sess.id}`);
  const [inv] = await pz(`SELECT status FROM invoices WHERE id='c1-inv'`);
  check("invoice rolled to PAID", inv.status === "PAID");
  const [aud] = await audits("ONLINE_PAYMENT_RECORDED");
  check("online payment audited (webhook, no user)", aud?.entity_id === "c1-inv" && aud?.detail?.via === "stripe_webhook");

  // Stripe retries deliveries — the second one must be a no-op.
  const again = await (await fetch(`${STRIPE}/__complete/${sess.id}`, { method: "POST" })).json();
  const payCount = await pz(`SELECT count(*)::int n FROM payments WHERE invoice_id='c1-inv'`);
  check("duplicate webhook delivery is idempotent", again.webhook?.body?.recorded === false && payCount[0].n === 1);

  // Forged + unknown-org webhooks are rejected.
  const forged = await fetch(`${BASE}/api/webhooks/stripe/plumb-zebra`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=deadbeef" },
    body: JSON.stringify({ type: "checkout.session.completed", data: { object: { id: "cs_forged", client_reference_id: "c1-inv", amount_total: 1 } } }),
  });
  check("forged webhook signature → 403", forged.status === 403);
  const badOrg = await fetch(`${BASE}/api/webhooks/stripe/not-a-tenant`, { method: "POST", body: "{}" });
  check("unknown org webhook → 404", badOrg.status === 404);

  await cpage.goto(`${BASE}/pay/${payToken}`, { waitUntil: "networkidle" });
  const paidBody = await cpage.textContent("body");
  check("pay page settles to Paid in full", paidBody.includes("Paid in full"));
}

await cust.close();
await ctx.close();
await browser.close();
await pool.end();
console.log(failures === 0 ? "\nALL C1 CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
