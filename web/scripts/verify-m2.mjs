/* E2E: Phase M2 — project lifecycle: create, edit, status map, milestones,
   change orders, costs, subs, job linking, ad-hoc invoices, archive, promote.
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

const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
const page = await ctx.newPage();
await login(page, "owner@plumbzebra.demo");

// ── 1. Create a project from the Projects page ──────────────────────────────
let projectId;
{
  const [pair] = await pz(`SELECT p.id AS property_id, p.customer_id FROM properties p
    JOIN customers c ON c.id=p.customer_id WHERE p.archived_at IS NULL AND c.archived_at IS NULL ORDER BY p.address LIMIT 1`);
  await page.goto(`${BASE}/projects`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.click('summary:has-text("New project")');
  await page.waitForTimeout(300);
  const form = page.locator('form:has(input[name="contractValue"])');
  await form.locator('input[name="name"]').fill("M2 Sewer Main Replacement");
  await form.locator('select[name="customerId"]').selectOption(pair.customer_id);
  await form.locator('select[name="propertyId"]').selectOption(pair.property_id);
  await form.locator('input[name="contractValue"]').fill("48000");
  await form.locator('input[name="budgetLabor"]').fill("18000");
  await form.locator('input[name="budgetMaterials"]').fill("14000");
  await form.locator('input[name="startDate"]').fill("2026-08-01");
  await form.locator('input[name="endDate"]').fill("2026-09-15");
  await form.locator('button:has-text("Create project")').click();
  await page.waitForURL(/\/projects\/[a-z0-9-]+$/, { timeout: 15000 });
  await settle(page);

  const [proj] = await pz(`SELECT * FROM projects WHERE name='M2 Sewer Main Replacement'`);
  projectId = proj?.id;
  check(`project CREATED via UI (status=${proj?.status}, contract=${proj?.contract_value_cents})`,
    Boolean(proj) && proj.status === "PLANNING" && proj.contract_value_cents === 4800000 && proj.budget_labor_cents === 1800000);
  check("creation audited (CREATE Project)", (await audits("CREATE")).some((a) => a.entity === "Project" && a.entity_id === projectId));
}

// ── 2. Edit the project header ──────────────────────────────────────────────
{
  await page.click('summary:has-text("Edit project details")');
  await page.waitForTimeout(300);
  const form = page.locator('form:has(input[name="budgetLabor"])');
  await form.locator('input[name="name"]').fill("M2 Sewer Main Replacement — Phase 1");
  await form.locator('input[name="contractValue"]').fill("52500");
  await form.locator('button:has-text("Save project")').click();
  await settle(page);
  const [proj] = await pz(`SELECT name, contract_value_cents FROM projects WHERE id='${projectId}'`);
  check("header edited (name + contract value)", proj.name.endsWith("Phase 1") && proj.contract_value_cents === 5250000);
}

// ── 3. Status map: PLANNING→ACTIVE→ON_HOLD→ACTIVE; no shortcuts offered ─────
{
  const body0 = await page.textContent("body");
  check("PLANNING offers only → Active (no shortcut to Completed/Closed)",
    body0.includes("→ Active") && !body0.includes("→ Completed") && !body0.includes("→ Closed"));

  await page.click('form:has(input[name="to"][value="ACTIVE"]) button');
  await settle(page);
  let [proj] = await pz(`SELECT status FROM projects WHERE id='${projectId}'`);
  check(`PLANNING → ACTIVE (${proj.status})`, proj.status === "ACTIVE");

  await page.click('form:has(input[name="to"][value="ON_HOLD"]) button');
  await settle(page);
  [proj] = await pz(`SELECT status FROM projects WHERE id='${projectId}'`);
  check(`ACTIVE → ON_HOLD (${proj.status})`, proj.status === "ON_HOLD");

  await page.click('form:has(input[name="to"][value="ACTIVE"]) button');
  await settle(page);
  [proj] = await pz(`SELECT status FROM projects WHERE id='${projectId}'`);
  check(`ON_HOLD ⇄ ACTIVE resume (${proj.status})`, proj.status === "ACTIVE");
  check("status transitions audited", (await audits("PROJECT_STATUS")).some((a) => a.entity_id === projectId));
}

// ── 4. Milestones: add ×2, edit, reorder, block, delete, billed-lock ────────
{
  const addForm = page.locator('form:has(input[name="billingAmount"]):has(button:has-text("Add milestone"))');
  await addForm.locator('input[name="name"]').fill("Rough-in complete");
  await addForm.locator('input[name="dueDate"]').fill("2026-08-20");
  await addForm.locator('input[name="billingAmount"]').fill("12000");
  await addForm.locator('button:has-text("Add milestone")').click();
  await settle(page);
  await addForm.locator('input[name="name"]').fill("Final walkthrough");
  await addForm.locator('input[name="billingAmount"]').fill("0");
  await addForm.locator('button:has-text("Add milestone")').click();
  await settle(page);
  let ms = await pz(`SELECT * FROM milestones WHERE project_id='${projectId}' ORDER BY sort_order`);
  check(`two milestones added in order (${ms.map((m) => m.name).join(" → ")})`,
    ms.length === 2 && ms[0].name === "Rough-in complete" && ms[1].name === "Final walkthrough" && ms[0].billing_amount_cents === 1200000);

  // Edit the first milestone.
  const msDetails = page.locator(`details:has(input[name="milestoneId"][value="${ms[0].id}"]):has(input[name="billingAmount"])`).first();
  await msDetails.locator("summary").click();
  await page.waitForTimeout(300);
  const editForm = page.locator(`form:has(input[name="milestoneId"][value="${ms[0].id}"]):has(input[name="name"])`);
  await editForm.locator('input[name="name"]').fill("Rough-in + inspection ready");
  await editForm.locator('button:has-text("Save milestone")').click();
  await settle(page);
  [ms] = await pz(`SELECT name FROM milestones WHERE id='${ms[0].id}'`);
  check("milestone edited (rename)", ms.name === "Rough-in + inspection ready");

  // Reorder: move the first milestone down.
  let rows = await pz(`SELECT id, name, sort_order FROM milestones WHERE project_id='${projectId}' ORDER BY sort_order`);
  await page.locator(`form:has(input[name="milestoneId"][value="${rows[0].id}"]):has(input[name="dir"][value="1"]) button`).click();
  await settle(page);
  rows = await pz(`SELECT id, name FROM milestones WHERE project_id='${projectId}' ORDER BY sort_order`);
  check(`reorder swaps the sequence (${rows.map((r) => r.name.split(" ")[0]).join(" → ")})`, rows[0].name === "Final walkthrough");

  // Block with a reason.
  const target = rows[1];
  const blockDetails = page.locator(`details:has(form:has(input[name="milestoneId"][value="${target.id}"]):has(input[name="reason"]))`).first();
  await blockDetails.locator("summary").click();
  await page.waitForTimeout(300);
  await blockDetails.locator('input[name="reason"]').fill("Fixture delivery slipped a week");
  await blockDetails.locator('button:has-text("Block")').click();
  await settle(page);
  const [blocked] = await pz(`SELECT status FROM milestones WHERE id='${target.id}'`);
  const [act] = await pz(`SELECT body FROM activities WHERE project_id='${projectId}' AND body LIKE '%BLOCKED%' LIMIT 1`);
  check(`manual block with reason (${blocked.status})`, blocked.status === "BLOCKED" && Boolean(act));

  // Bill the blocked milestone → Delete control disappears (billed lock).
  await page.locator(`form:has(input[name="milestoneId"][value="${target.id}"]) button:has-text("Generate milestone invoice")`).click();
  await settle(page);
  const [billedMs] = await pz(`SELECT billed FROM milestones WHERE id='${target.id}'`);
  const deleteBtnCount = await page.locator(`form:has(input[name="milestoneId"][value="${target.id}"]) button:has-text("Delete")`).count();
  check("billed milestone locks: invoiced + Delete control gone", billedMs.billed === true && deleteBtnCount === 0);

  // Delete the unbilled one.
  await page.locator(`form:has(input[name="milestoneId"][value="${rows[0].id}"]) button:has-text("Delete")`).click();
  await settle(page);
  const remaining = await pz(`SELECT id FROM milestones WHERE project_id='${projectId}'`);
  check("unbilled milestone deleted", remaining.length === 1 && remaining[0].id === target.id);
}

// ── 5. Change orders: edit while pending, reject with reason ────────────────
{
  const coForm = page.locator('form:has(button:has-text("Create CO"))');
  await coForm.locator('input[name="description"]').fill("Upsize cleanout to 6 inch");
  await coForm.locator('input[name="amount"]').fill("1850");
  await coForm.locator('button:has-text("Create CO")').click();
  await settle(page);
  let [co] = await pz(`SELECT id, amount_cents FROM change_orders WHERE project_id='${projectId}'`);
  check("CO created (pending signature)", co?.amount_cents === 185000);

  // Edit while pending.
  const editDetails = page.locator(`details:has(form:has(input[name="changeOrderId"][value="${co.id}"]):has(input[name="amount"]))`).first();
  await editDetails.locator("summary").click();
  await page.waitForTimeout(300);
  await editDetails.locator('input[name="amount"]').fill("2100");
  await editDetails.locator('button:has-text("Save CO")').click();
  await settle(page);
  [co] = await pz(`SELECT id, amount_cents, status FROM change_orders WHERE id='${co.id}'`);
  check("CO edited while pending (amount 1850 → 2100)", co.amount_cents === 210000);

  // Reject with a reason.
  const rejDetails = page.locator(`details:has(form:has(input[name="changeOrderId"][value="${co.id}"]):has(input[name="reason"]))`).first();
  await rejDetails.locator("summary").click();
  await page.waitForTimeout(300);
  await rejDetails.locator('input[name="reason"]').fill("Customer declined the price");
  await rejDetails.locator('button:has-text("Reject CO")').click();
  await settle(page);
  [co] = await pz(`SELECT status FROM change_orders WHERE id='${co.id}'`);
  check(`CO rejected — enum finally reachable (${co.status})`, co.status === "REJECTED");
  check("rejection audited with reason", (await audits("CHANGE_ORDER_REJECTED"))[0]?.detail?.reason === "Customer declined the price");
}

// ── 6. Costs: log, edit (kind/amount/date), delete ──────────────────────────
{
  const costForm = page.locator('form:has(button:has-text("Log cost"))');
  await costForm.locator('input[name="description"]').fill("PVC pipe stock");
  await costForm.locator('input[name="amount"]').fill("900");
  await costForm.locator('button:has-text("Log cost")').click();
  await settle(page);
  let [cost] = await pz(`SELECT id FROM cost_entries WHERE project_id='${projectId}' AND description='PVC pipe stock'`);
  check("cost logged", Boolean(cost));

  const costDetails = page.locator(`details:has(form:has(input[name="costId"][value="${cost.id}"]))`).first();
  await costDetails.locator("summary").click();
  await page.waitForTimeout(300);
  await costDetails.locator('select[name="kind"]').selectOption("SUBCONTRACTOR");
  await costDetails.locator('input[name="amount"]').fill("1150");
  await costDetails.locator('input[name="incurredAt"]').fill("2026-07-10");
  await costDetails.locator('button:has-text("Save cost")').click();
  await settle(page);
  [cost] = await pz(`SELECT kind, amount_cents, incurred_at FROM cost_entries WHERE id='${cost.id}'`);
  check("cost edited (kind + amount + incurred date)",
    cost.kind === "SUBCONTRACTOR" && cost.amount_cents === 115000 && new Date(cost.incurred_at).toISOString().startsWith("2026-07-10"));

  const [cost2] = await pz(`SELECT id FROM cost_entries WHERE project_id='${projectId}' AND description='PVC pipe stock'`);
  await page.locator(`form:has(input[name="costId"][value="${cost2.id}"]) button:has-text("Delete")`).click();
  await settle(page);
  const left = await pz(`SELECT id FROM cost_entries WHERE id='${cost2.id}'`);
  check("cost deleted (audited)", left.length === 0 && (await audits("COST_DELETED"))[0]?.entity_id === cost2.id);
}

// ── 7. Subs: add, edit/renew COI, remove ────────────────────────────────────
{
  const subForm = page.locator('form:has(button:has-text("Add subcontractor"))');
  await subForm.locator('input[name="name"]').fill("Inland Electric LLC");
  await subForm.locator('input[name="trade"]').fill("Electrical");
  await subForm.locator('button:has-text("Add subcontractor")').click();
  await settle(page);
  let [sub] = await pz(`SELECT id, coi_expires_at FROM subcontractors WHERE project_id='${projectId}'`);
  check("sub added (no COI on file yet)", Boolean(sub) && sub.coi_expires_at === null);

  const subDetails = page.locator(`details:has(form:has(input[name="subId"][value="${sub.id}"]))`).first();
  await subDetails.locator("summary").click();
  await page.waitForTimeout(300);
  await subDetails.locator('input[name="coiExpiresAt"]').fill("2027-07-01");
  await subDetails.locator('button:has-text("Save sub")').click();
  await settle(page);
  [sub] = await pz(`SELECT id, coi_expires_at FROM subcontractors WHERE id='${sub.id}'`);
  check("COI renewed via edit (expiry set)", sub.coi_expires_at !== null && new Date(sub.coi_expires_at).getFullYear() === 2027);

  await page.locator(`form:has(input[name="subId"][value="${sub.id}"]) button:has-text("Remove")`).click();
  await settle(page);
  const subsLeft = await pz(`SELECT id FROM subcontractors WHERE project_id='${projectId}'`);
  check("sub removed", subsLeft.length === 0);
}

// ── 8. Job linking: link a same-customer job, then unlink ───────────────────
{
  const [proj] = await pz(`SELECT customer_id FROM projects WHERE id='${projectId}'`);
  let [job] = await pz(`SELECT id, number FROM jobs WHERE customer_id='${proj.customer_id}' AND project_id IS NULL AND deleted_at IS NULL LIMIT 1`);
  if (!job) {
    // Bootstrap one directly (booking is covered in verify-m1).
    [job] = await pz(`INSERT INTO jobs (id, number, job_type, status, customer_id, property_id)
      SELECT 'm2-link-job', 'J-9901', 'M2 link test', 'UNSCHEDULED', '${proj.customer_id}', p.id FROM properties p WHERE p.customer_id='${proj.customer_id}' LIMIT 1
      ON CONFLICT (id) DO UPDATE SET project_id=NULL RETURNING id, number`);
    await page.reload({ waitUntil: "networkidle" });
  }
  const linkForm = page.locator('form:has(select[name="jobId"])');
  check("link picker offers same-customer jobs", (await linkForm.count()) > 0);
  await linkForm.locator('select[name="jobId"]').selectOption(job.id);
  await linkForm.locator('button:has-text("Link")').click();
  await settle(page);
  let [linked] = await pz(`SELECT project_id FROM jobs WHERE id='${job.id}'`);
  check(`job ${job.number} linked to the project`, linked.project_id === projectId);

  await page.locator(`form:has(input[name="jobId"][value="${job.id}"]) button:has-text("Unlink")`).click();
  await settle(page);
  [linked] = await pz(`SELECT project_id FROM jobs WHERE id='${job.id}'`);
  check("job unlinked (audited)", linked.project_id === null && (await audits("JOB_UNLINKED"))[0]?.detail?.job === job.number);
}

// ── 9. Ad-hoc project invoice ───────────────────────────────────────────────
{
  const invForm = page.locator('form:has(button:has-text("Draft invoice"))');
  await invForm.locator('input[name="description"]').fill("Deposit — mobilization");
  await invForm.locator('input[name="amount"]').fill("5000");
  await invForm.locator('button:has-text("Draft invoice")').click();
  await settle(page);
  const [inv] = await pz(`SELECT i.number, i.status, i.project_id, l.unit_price_cents, l.description
    FROM invoices i JOIN invoice_line_items l ON l.invoice_id=i.id WHERE i.project_id='${projectId}' AND l.description LIKE 'Deposit%'`);
  check(`ad-hoc DRAFT invoice created against the project (${inv?.number})`,
    Boolean(inv) && inv.status === "DRAFT" && inv.unit_price_cents === 500000);
  check("invoice draft audited", (await audits("PROJECT_INVOICE_CREATED"))[0]?.entity_id === projectId);
}

// ── 10. Complete → Close → archive → restore → reopen ───────────────────────
{
  await page.click('form:has(input[name="to"][value="COMPLETED"]) button');
  await settle(page);
  await page.click('form:has(input[name="to"][value="CLOSED"]) button');
  await settle(page);
  let [proj] = await pz(`SELECT status FROM projects WHERE id='${projectId}'`);
  check(`ACTIVE → COMPLETED → CLOSED (${proj.status})`, proj.status === "CLOSED");

  await page.click('button:has-text("Archive project")');
  await settle(page);
  [proj] = await pz(`SELECT archived_at FROM projects WHERE id='${projectId}'`);
  check("CLOSED project archived", proj.archived_at !== null);

  await page.goto(`${BASE}/projects`, { waitUntil: "networkidle" });
  const activeBody = await page.textContent("body");
  await page.goto(`${BASE}/projects?archived=1`, { waitUntil: "networkidle" });
  const archBody = await page.textContent("body");
  check("archived project hidden from the list, shown under 📦 Show archived",
    !activeBody.includes("M2 Sewer Main Replacement") && archBody.includes("M2 Sewer Main Replacement"));

  await page.goto(`${BASE}/projects/${projectId}`, { waitUntil: "networkidle" });
  await page.click('button:has-text("Restore project")');
  await settle(page);
  await page.click('button:has-text("Reopen (Completed)")');
  await settle(page);
  [proj] = await pz(`SELECT status, archived_at FROM projects WHERE id='${projectId}'`);
  check(`restore + reopen CLOSED → COMPLETED (${proj.status})`, proj.archived_at === null && proj.status === "COMPLETED");
}

// ── 11. Promote an APPROVED estimate to a project ───────────────────────────
{
  const [est] = await pz(`SELECT id, number, job_id FROM estimates WHERE status='APPROVED' LIMIT 1`);
  await page.goto(`${BASE}/estimates/${est.id}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.click('button:has-text("Promote to project")');
  await page.waitForURL(/\/projects\/[a-z0-9-]+$/, { timeout: 15000 });
  await settle(page);
  const [proj] = await pz(`SELECT id, name, contract_value_cents FROM projects WHERE name LIKE '%${est.number}%'`);
  check(`estimate ${est.number} promoted to a project (contract=${proj?.contract_value_cents})`,
    Boolean(proj) && proj.contract_value_cents > 0);
  if (est.job_id) {
    const [job] = await pz(`SELECT project_id FROM jobs WHERE id='${est.job_id}'`);
    check("the sold job came along (linked to the new project)", job.project_id === proj.id);
  } else {
    check("estimate had a sold job to link (seed)", false);
  }
  check("promotion audited", (await audits("PROJECT_PROMOTED"))[0]?.detail?.estimate === est.number);
}

await ctx.close();
await browser.close();
await pool.end();
console.log(failures === 0 ? "\nALL M2 CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
