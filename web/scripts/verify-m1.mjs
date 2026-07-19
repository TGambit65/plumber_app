/* E2E: Phase M1 — management functionality for jobs, customers, leads.
   Requires: next on :3000 (fresh build), seeded Plumb Zebra tenant. */
import { chromium } from "playwright";
import { Pool } from "pg";

const BASE = "http://localhost:3000";
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

const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
await login(page, "owner@plumbzebra.demo");

// ── 1. Job: edit details ─────────────────────────────────────────────────────
let jobId, jobNumber;
{
  const [job] = await pz(`SELECT id, number FROM jobs WHERE status='SCHEDULED' AND deleted_at IS NULL AND scheduled_at IS NOT NULL ORDER BY scheduled_at LIMIT 1`);
  jobId = job.id; jobNumber = job.number;
  await page.goto(`${BASE}/jobs/${jobId}`, { waitUntil: "networkidle" });
  await page.click('summary:has-text("Edit details")');
  const form = page.locator('form:has(input[name="jobType"])');
  await form.locator('input[name="jobType"]').fill("M1 Water Heater Swap");
  await form.locator('select[name="priority"]').selectOption("HIGH");
  await form.locator('textarea[name="internalNotes"]').fill("Bring the tall ladder.");
  await form.locator('button:has-text("Save details")').click();
  await settle(page);

  const [after] = await pz(`SELECT job_type, priority, internal_notes FROM jobs WHERE id='${jobId}'`);
  check(`job details edited (type=${after.job_type}, prio=${after.priority})`,
    after.job_type === "M1 Water Heater Swap" && after.priority === "HIGH" && after.internal_notes === "Bring the tall ladder.");
  const [a] = await audits("UPDATE");
  check("job edit audited (UPDATE Job)", a?.entity === "Job" && a?.entity_id === jobId);
}

// ── 2. Job: reschedule with duration + tech ─────────────────────────────────
{
  const [tech] = await pz(`SELECT id, name FROM users WHERE role='TECH' AND active LIMIT 1`);
  await page.click('summary:has-text("Reschedule / reassign")');
  const form = page.locator('form:has(select[name="durationMin"]):has(input[name="scheduledAt"])');
  const tomorrow = new Date(Date.now() + 86400000);
  const d = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}T15:00`;
  await form.locator('input[name="scheduledAt"]').fill(d);
  await form.locator('select[name="durationMin"]').selectOption("180");
  await form.locator('select[name="techId"]').selectOption(tech.id);
  await form.locator('button:has-text("Save schedule")').click();
  await settle(page);

  const [after] = await pz(`SELECT scheduled_at, scheduled_end, assigned_to_id, status FROM jobs WHERE id='${jobId}'`);
  const mins = (new Date(after.scheduled_end) - new Date(after.scheduled_at)) / 60000;
  check(`reschedule captured start + 3h duration (${mins} min) + tech`, mins === 180 && after.assigned_to_id === tech.id && after.status === "SCHEDULED");
  check("reschedule audited", (await audits("JOB_RESCHEDULED"))[0]?.entity_id === jobId);
}

// ── 3. Job: unassign from the reschedule form → back to the lane ────────────
{
  await page.goto(`${BASE}/jobs/${jobId}`, { waitUntil: "networkidle" });
  await page.click('summary:has-text("Reschedule / reassign")');
  const form = page.locator('form:has(select[name="durationMin"]):has(input[name="scheduledAt"])');
  await form.locator('select[name="techId"]').selectOption("");
  await form.locator('button:has-text("Save schedule")').click();
  await settle(page);
  const [after] = await pz(`SELECT assigned_to_id FROM jobs WHERE id='${jobId}'`);
  check("unassign puts the job back in the lane (assigned_to_id null)", after.assigned_to_id === null);
}

// ── 4. Dispatch: assign with duration; Unassign button on the placed card ───
{
  const [job] = await pz(`SELECT id, number, scheduled_at FROM jobs WHERE id='${jobId}'`);
  const day = new Date(job.scheduled_at);
  const dateStr = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  await page.goto(`${BASE}/dispatch?date=${dateStr}`, { waitUntil: "networkidle" });

  const laneCard = page.locator(`div:has(> div a:has-text("${job.number}"))`).first();
  const assignForm = page.locator(`form:has(input[name="jobId"][value="${job.id}"]):has(select[name="techId"])`).first();
  check("unassigned lane shows the job with an assign form", (await assignForm.count()) > 0);
  await assignForm.locator('select[name="techId"]').selectOption({ index: 1 });
  await assignForm.locator('input[name="scheduledAt"]').fill(`${dateStr}T10:00`);
  await assignForm.locator('select[name="durationMin"]').selectOption("60");
  await assignForm.locator('button:has-text("Assign")').click();
  await settle(page, 1200);

  const [assigned] = await pz(`SELECT assigned_to_id, scheduled_at, scheduled_end FROM jobs WHERE id='${job.id}'`);
  const mins = (new Date(assigned.scheduled_end) - new Date(assigned.scheduled_at)) / 60000;
  check(`board assign captured the 1h duration (${mins} min)`, assigned.assigned_to_id !== null && mins === 60);

  // Unassign straight from the placed card.
  const unassignForm = page.locator(`form:has(input[name="jobId"][value="${job.id}"]):has(button:has-text("Unassign"))`).first();
  check("placed card offers an Unassign control", (await unassignForm.count()) > 0);
  await unassignForm.locator('button:has-text("Unassign")').click();
  await settle(page, 1200);
  const [back] = await pz(`SELECT assigned_to_id, status FROM jobs WHERE id='${job.id}'`);
  check("Unassign sends it back to the lane (audited)", back.assigned_to_id === null && (await audits("JOB_UNASSIGNED"))[0]?.entity_id === job.id);
}

// ── 5. Job: revert one step (mis-tap fix) ───────────────────────────────────
{
  const [tech] = await pz(`SELECT id FROM users WHERE role='TECH' AND active LIMIT 1`);
  await pz(`UPDATE jobs SET assigned_to_id='${tech.id}', status='DISPATCHED' WHERE id='${jobId}'`);
  await page.goto(`${BASE}/jobs/${jobId}`, { waitUntil: "networkidle" });
  await page.click('button:has-text("Step back to Scheduled")');
  await settle(page);
  const [after] = await pz(`SELECT status FROM jobs WHERE id='${jobId}'`);
  check(`revert stepped DISPATCHED → SCHEDULED (${after.status})`, after.status === "SCHEDULED");
  check("revert audited", (await audits("JOB_STATUS_REVERTED"))[0]?.entity_id === jobId);
}

// ── 6. Job: cancel with reason, then archive + restore ──────────────────────
{
  await page.click('summary:has-text("Cancel job")');
  const form = page.locator('form:has(textarea[name="reason"])');
  await form.locator('textarea[name="reason"]').fill("Customer sold the house.");
  await form.locator('button:has-text("Cancel this job")').click();
  await settle(page);
  const [after] = await pz(`SELECT status, internal_notes FROM jobs WHERE id='${jobId}'`);
  check("cancel sets CANCELLED and stores the reason", after.status === "CANCELLED" && after.internal_notes.includes("Customer sold the house."));
  check("cancel audited with reason", (await audits("JOB_CANCELLED"))[0]?.detail?.reason === "Customer sold the house.");

  await page.click('button:has-text("Archive job")');
  await settle(page);
  const [arch] = await pz(`SELECT deleted_at, deleted_by_id FROM jobs WHERE id='${jobId}'`);
  check("archive wires deletedAt/deletedById", arch.deleted_at !== null && arch.deleted_by_id !== null);

  await page.goto(`${BASE}/jobs`, { waitUntil: "networkidle" });
  const activeBody = await page.textContent("body");
  await page.goto(`${BASE}/jobs?archived=1`, { waitUntil: "networkidle" });
  const archivedBody = await page.textContent("body");
  check("archived job hidden from the default list, shown under 📦 Show archived",
    !activeBody.includes(jobNumber) && archivedBody.includes(jobNumber));

  await page.goto(`${BASE}/jobs/${jobId}`, { waitUntil: "networkidle" });
  await page.click('button:has-text("Restore job")');
  await settle(page);
  const [rest] = await pz(`SELECT deleted_at FROM jobs WHERE id='${jobId}'`);
  check("restore clears the archive flags", rest.deleted_at === null);
}

// ── 7. Booking form captures duration + internal notes ──────────────────────
{
  await page.goto(`${BASE}/dispatch`, { waitUntil: "networkidle" });
  const [pair] = await pz(`SELECT p.id AS property_id, p.customer_id FROM properties p
    JOIN customers c ON c.id=p.customer_id
    WHERE p.archived_at IS NULL AND c.archived_at IS NULL ORDER BY p.address LIMIT 1`);
  const form = page.locator('form:has(select[name="customerId"])');
  await form.locator('select[name="customerId"]').selectOption(pair.customer_id);
  await form.locator('select[name="propertyId"]').selectOption(pair.property_id);
  const jt = form.locator('select[name="jobType"]');
  if (await jt.count()) await jt.selectOption({ index: 1 });
  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  await form.locator('input[name="scheduledAt"]').fill(`${dateStr}T13:00`);
  await form.locator('select[name="durationMin"]').selectOption("90");
  await form.locator('textarea[name="internalNotes"]').fill("M1 booking note — beware of dog.");
  await form.locator('button:has-text("Book job")').click();
  await settle(page, 1200);

  const [booked] = await pz(`SELECT number, scheduled_at, scheduled_end, internal_notes FROM jobs WHERE internal_notes LIKE 'M1 booking note%' ORDER BY created_at DESC LIMIT 1`);
  const mins = booked ? (new Date(booked.scheduled_end) - new Date(booked.scheduled_at)) / 60000 : 0;
  check(`booked job carries 90-min duration + internal notes (${booked?.number}, ${mins} min)`, Boolean(booked) && mins === 90);
}

// ── 8. Customer: edit + SMS opt-out toggle ──────────────────────────────────
let custId;
{
  const [cust] = await pz(`SELECT c.id, c.name FROM customers c
    WHERE c.archived_at IS NULL AND c.external_ref IS NULL
      AND EXISTS (SELECT 1 FROM equipment e JOIN properties p ON e.property_id=p.id WHERE p.customer_id=c.id AND e.archived_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.customer_id=c.id)
    ORDER BY c.name LIMIT 1`);
  custId = cust.id;
  await page.goto(`${BASE}/customers/${custId}`, { waitUntil: "networkidle" });
  await page.click('summary:has-text("Edit customer")');
  const form = page.locator('form:has(input[name="smsOptOut"])');
  await form.locator('textarea[name="notes"]').fill("M1 edited — VIP, always call first.");
  await form.locator('input[name="smsOptOut"]').check();
  await form.locator('button:has-text("Save customer")').click();
  await settle(page);

  const [after] = await pz(`SELECT notes, sms_opt_out FROM customers WHERE id='${custId}'`);
  check("customer edit saved (notes + manual SMS opt-out)", after.notes.startsWith("M1 edited") && after.sms_opt_out === true);
  const body = await page.textContent("body");
  check("SMS opt-out banner appears on the customer page", body.includes("SMS opt-out is SET"));
  // Clear the opt-out again (keep the demo clean).
  await page.goto(`${BASE}/customers/${custId}`, { waitUntil: "networkidle" });
  await page.click('summary:has-text("Edit customer")');
  await page.waitForTimeout(300);
  await form.locator('input[name="smsOptOut"]').uncheck();
  await form.locator('button:has-text("Save customer")').click();
  await settle(page);
}

// ── 9. Customer archive: guard blocks while open work exists ────────────────
{
  const [busy] = await pz(`SELECT c.id FROM customers c WHERE c.archived_at IS NULL AND EXISTS (
    SELECT 1 FROM jobs j WHERE j.customer_id=c.id AND j.status IN ('UNSCHEDULED','SCHEDULED','DISPATCHED','EN_ROUTE','IN_PROGRESS') AND j.deleted_at IS NULL) LIMIT 1`);
  await page.goto(`${BASE}/customers/${busy.id}`, { waitUntil: "networkidle" });
  await page.click('button:has-text("Archive customer")');
  await page.waitForTimeout(1200);
  const [after] = await pz(`SELECT archived_at FROM customers WHERE id='${busy.id}'`);
  check("archive guard refuses a customer with open jobs", after.archived_at === null);
}

// ── 10. Customer archive + restore on a clean customer ──────────────────────
{
  const [clean] = await pz(`
    INSERT INTO customers (id, name, type) VALUES ('m1-clean-cust', 'M1 Clean Customer', 'RESIDENTIAL')
    ON CONFLICT (id) DO UPDATE SET archived_at=NULL RETURNING id`);
  await page.goto(`${BASE}/customers/${clean.id}`, { waitUntil: "networkidle" });
  await page.click('button:has-text("Archive customer")');
  await settle(page);
  const [arch] = await pz(`SELECT archived_at FROM customers WHERE id='${clean.id}'`);
  check("clean customer archives", arch.archived_at !== null);

  await page.goto(`${BASE}/customers`, { waitUntil: "networkidle" });
  const activeBody = await page.textContent("body");
  await page.goto(`${BASE}/customers?archived=1`, { waitUntil: "networkidle" });
  const archBody = await page.textContent("body");
  check("archived customer hidden from list, visible under Show archived",
    !activeBody.includes("M1 Clean Customer") && archBody.includes("M1 Clean Customer"));

  await page.goto(`${BASE}/customers/${clean.id}`, { waitUntil: "networkidle" });
  await page.click('button:has-text("Restore customer")');
  await settle(page);
  const [rest] = await pz(`SELECT archived_at FROM customers WHERE id='${clean.id}'`);
  check("restore un-archives the customer", rest.archived_at === null);
}

// ── 11. Property: address edit clears stale geocode ─────────────────────────
{
  const [prop] = await pz(`SELECT id, address FROM properties WHERE customer_id='${custId}' AND archived_at IS NULL LIMIT 1`);
  await page.goto(`${BASE}/customers/${custId}`, { waitUntil: "networkidle" });
  await page.click('summary:has-text("Edit address / label")');
  const form = page.locator(`form:has(input[name="propertyId"][value="${prop.id}"]):has(input[name="address"])`);
  await form.locator('input[name="address"]').fill("2222 M1 Rewrite Ave");
  await form.locator('button:has-text("Save address")').click();
  await settle(page);
  const [after] = await pz(`SELECT address, lat, lng, geocoded_at FROM properties WHERE id='${prop.id}'`);
  check("property address edited + stale coords cleared for re-geocode",
    after.address === "2222 M1 Rewrite Ave" && after.lat === null && after.geocoded_at === null);
}

// ── 12. Equipment: edit + remove ────────────────────────────────────────────
{
  const [eqp] = await pz(`SELECT e.id FROM equipment e JOIN properties p ON e.property_id=p.id WHERE p.customer_id='${custId}' AND e.archived_at IS NULL LIMIT 1`);
  if (eqp) {
    await page.goto(`${BASE}/customers/${custId}`, { waitUntil: "networkidle" });
    const eqDetails = () => page.locator(`details:has(input[name="equipmentId"][value="${eqp.id}"])`).first();
    await eqDetails().locator("summary").click();
    const form = page.locator(`form:has(input[name="equipmentId"][value="${eqp.id}"]):has(input[name="brand"])`);
    await form.locator('input[name="brand"]').fill("M1-Brand");
    await form.locator('button:has-text("Save equipment")').click();
    await settle(page);
    const [after] = await pz(`SELECT brand FROM equipment WHERE id='${eqp.id}'`);
    check("equipment brand edited", after.brand === "M1-Brand");

    await page.goto(`${BASE}/customers/${custId}`, { waitUntil: "networkidle" });
    await eqDetails().locator("summary").click();
    await page.waitForTimeout(300);
    await page.locator(`form:has(input[name="equipmentId"][value="${eqp.id}"]) button:has-text("Remove equipment")`).click();
    await settle(page);
    const [rem] = await pz(`SELECT archived_at FROM equipment WHERE id='${eqp.id}'`);
    check("equipment removed (soft archive, history kept)", rem.archived_at !== null);
  } else {
    check("equipment present to edit (seed)", false);
  }
}

// ── 13. Membership: add, then cancel ────────────────────────────────────────
{
  await page.goto(`${BASE}/customers/${custId}`, { waitUntil: "networkidle" });
  await page.click('summary:has-text("Add membership"), summary:has-text("Edit membership")');
  const form = page.locator('form:has(input[name="plan"])');
  await form.locator('input[name="plan"]').fill("Zebra Care Gold");
  await form.locator('button:has-text("Save membership")').click();
  await settle(page);
  const [ms] = await pz(`SELECT plan, status FROM memberships WHERE customer_id='${custId}'`);
  check("membership created from the customer page", ms?.plan === "Zebra Care Gold" && ms?.status === "ACTIVE");

  await page.click('button:has-text("Cancel membership")');
  await settle(page);
  const [cancelled] = await pz(`SELECT status FROM memberships WHERE customer_id='${custId}'`);
  check("membership cancelled (kept on record)", cancelled.status === "CANCELLED");
}

// ── 14. Lead: edit + reassign + link customer ───────────────────────────────
let leadId;
{
  const [lead] = await pz(`SELECT id FROM leads WHERE archived_at IS NULL AND stage NOT IN ('WON','LOST') ORDER BY created_at LIMIT 1`);
  leadId = lead.id;
  await page.goto(`${BASE}/leads/${leadId}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700); // let server-action hydration finish before submitting
  await page.click('summary:has-text("Edit details")');
  await page.waitForTimeout(300);
  const form = page.locator('form:has(input[name="title"])');
  await form.locator('input[name="title"]').fill("M1 Retitled Opportunity");
  await form.locator('input[name="estValue"]').fill("4321");
  await form.locator('button:has-text("Save details")').click();
  await settle(page);
  const [after] = await pz(`SELECT title, est_value_cents FROM leads WHERE id='${leadId}'`);
  check("lead edited (title + est. value)", after.title === "M1 Retitled Opportunity" && after.est_value_cents === 432100);

  const [rep] = await pz(`SELECT id, name FROM users WHERE role='SALES_PM' AND active LIMIT 1`);
  const reassign = page.locator('form:has(select[name="assignedToId"])');
  await reassign.locator('select[name="assignedToId"]').selectOption(rep.id);
  await reassign.locator('button:has-text("Reassign")').click();
  await settle(page);
  const [ra] = await pz(`SELECT assigned_to_id FROM leads WHERE id='${leadId}'`);
  check("lead reassigned (audited)", ra.assigned_to_id === rep.id && (await audits("LEAD_REASSIGNED"))[0]?.entity_id === leadId);

  const linkForm = page.locator('form:has(select[name="customerId"]):has(select[name="propertyId"])');
  await linkForm.locator('select[name="customerId"]').selectOption(custId);
  await linkForm.locator('button:has-text("Link")').click();
  await settle(page);
  const [linked] = await pz(`SELECT customer_id FROM leads WHERE id='${leadId}'`);
  check("lead linked to a customer directly", linked.customer_id === custId);
}

// ── 15. Lead: reopen a LOST lead ────────────────────────────────────────────
{
  await pz(`UPDATE leads SET stage='LOST', lost_reason='test loss' WHERE id='${leadId}'`);
  await page.goto(`${BASE}/leads/${leadId}`, { waitUntil: "networkidle" });
  const form = page.locator('form:has(input[name="reason"])');
  await form.locator('input[name="reason"]').fill("Customer called back");
  await form.locator('button:has-text("Reopen")').click();
  await settle(page);
  const [after] = await pz(`SELECT stage, lost_reason FROM leads WHERE id='${leadId}'`);
  check("LOST lead reopened → FOLLOW_UP, lost reason cleared", after.stage === "FOLLOW_UP" && after.lost_reason === null);
  check("reopen audited", (await audits("LEAD_REOPENED"))[0]?.entity_id === leadId);
}

// ── 16. Lead: archive → off pipeline/SLA, restore via Show archived ─────────
{
  const [before] = await pz(`SELECT title FROM leads WHERE id='${leadId}'`);
  await page.goto(`${BASE}/leads/${leadId}`, { waitUntil: "networkidle" });
  await page.click('button:has-text("Archive lead")');
  await settle(page);
  const [arch] = await pz(`SELECT archived_at FROM leads WHERE id='${leadId}'`);
  check("lead archived", arch.archived_at !== null);

  await page.goto(`${BASE}/pipeline`, { waitUntil: "networkidle" });
  const pipeBody = await page.textContent("body");
  check("archived lead is OFF the pipeline board", !pipeBody.includes(before.title));

  await page.goto(`${BASE}/leads?archived=1`, { waitUntil: "networkidle" });
  const archBody = await page.textContent("body");
  check("archived lead listed under Show archived", archBody.includes(before.title));

  await page.goto(`${BASE}/leads/${leadId}`, { waitUntil: "networkidle" });
  await page.click('button:has-text("Restore lead")');
  await settle(page);
  const [rest] = await pz(`SELECT archived_at FROM leads WHERE id='${leadId}'`);
  check("lead restored", rest.archived_at === null);
}

// ── 17. Pipeline: stage jump straight to FOLLOW_UP ──────────────────────────
{
  const [lead] = await pz(`SELECT id, title FROM leads WHERE archived_at IS NULL AND stage='NEW' LIMIT 1`);
  if (lead) {
    await page.goto(`${BASE}/pipeline`, { waitUntil: "networkidle" });
    const card = page.locator(`div:has(> a:has-text("${lead.title}"))`).first();
    await card.locator('summary:has-text("Jump to stage")').click();
    await card.locator('select[name="stage"]').selectOption("FOLLOW_UP");
    await card.locator('button:has-text("Move")').click();
    await settle(page, 1200);
    const [after] = await pz(`SELECT stage FROM leads WHERE id='${lead.id}'`);
    check(`pipeline jump moved NEW → FOLLOW_UP (${after.stage})`, after.stage === "FOLLOW_UP");
  } else {
    check("a NEW lead exists for the jump test (seed)", false);
  }
}

await ctx.close();
await browser.close();
await pool.end();
console.log(failures === 0 ? "\nALL M1 CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
