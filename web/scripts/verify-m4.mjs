/* E2E: Phase M4 — KB edit/archive/un-verify, message group management +
   per-user archive + delete-own, approvals withdraw/edit/bulk, compliance
   template/cert/inspection management.
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

async function openMenu(page) {
  await page.waitForTimeout(400);
  await page.locator("details:has(> summary:has-text('⋯'))").first().evaluate((el) => { el.open = true; });
  await page.waitForTimeout(200);
}

async function closeMenu(page) {
  await page.locator("details:has(> summary:has-text('⋯'))").first().evaluate((el) => { el.open = false; }).catch(() => {});
  await page.waitForTimeout(150);
}

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

// ═══ KB ══════════════════════════════════════════════════════════════════════
{
  const [art] = await pz(`SELECT id, slug, title, updated_at, verified_at FROM kb_articles WHERE archived_at IS NULL AND verified_at IS NOT NULL LIMIT 1`);
  await page.goto(`${BASE}/kb/${art.slug}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.click('summary:has-text("Edit article")');
  await page.waitForTimeout(300);
  const form = page.locator('form:has(textarea[name="body"])');
  await form.locator('input[name="title"]').fill(`${art.title} (M4 edited)`);
  await form.locator('button:has-text("Save article")').click();
  await settle(page);
  const [after] = await pz(`SELECT title, updated_at, verified_at FROM kb_articles WHERE id='${art.id}'`);
  check("KB article edited — updatedAt finally real", after.title.endsWith("(M4 edited)") && new Date(after.updated_at) > new Date(art.updated_at));
  check("editing cleared verification (stale content must be re-reviewed)", art.verified_at !== null && after.verified_at === null);

  // Re-verify, then un-verify via the new button.
  await page.click('button:has-text("Mark verified today")');
  await settle(page);
  await page.click('button:has-text("Un-verify")');
  await settle(page);
  const [unv] = await pz(`SELECT verified_at FROM kb_articles WHERE id='${art.id}'`);
  check("admin un-verify works (audited)", unv.verified_at === null && (await audits("UNVERIFY"))[0]?.entity_id === art.id);

  // Unpublish → gone from the KB list; restore.
  await page.click('button:has-text("Unpublish")');
  await settle(page);
  await page.goto(`${BASE}/kb`, { waitUntil: "networkidle" });
  const listBody = await page.textContent("body");
  check("unpublished article hidden from the KB list", !listBody.includes("(M4 edited)"));
  await page.goto(`${BASE}/kb/${art.slug}`, { waitUntil: "networkidle" });
  await page.click('button:has-text("Republish")');
  await settle(page);
  const [rest] = await pz(`SELECT archived_at FROM kb_articles WHERE id='${art.id}'`);
  check("republish restores the article", rest.archived_at === null);
}

// ═══ MESSAGES ════════════════════════════════════════════════════════════════
{
  // Seed a group conversation owned by the owner.
  const [owner] = await pz(`SELECT id FROM users WHERE email='owner@plumbzebra.demo'`);
  const [office] = await pz(`SELECT id, name FROM users WHERE role='OFFICE' AND active LIMIT 1`);
  const [tech] = await pz(`SELECT id, name FROM users WHERE role='TECH' AND active LIMIT 1`);
  const [conv] = await pz(`INSERT INTO conversations (id, title, is_group, created_by_id) VALUES ('m4-group', 'M4 Crew Chat', true, '${owner.id}')
    ON CONFLICT (id) DO UPDATE SET title='M4 Crew Chat' RETURNING id`);
  await pz(`INSERT INTO conversation_participants (conversation_id, user_id) VALUES ('m4-group','${owner.id}'),('m4-group','${office.id}') ON CONFLICT DO NOTHING`);
  await pz(`INSERT INTO messages (id, conversation_id, sender_id, body) VALUES ('m4-msg-own','m4-group','${owner.id}','oops wrong chat') ON CONFLICT (id) DO UPDATE SET deleted_at=NULL, created_at=now()`);

  await page.goto(`${BASE}/messages/m4-group`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await openMenu(page);

  // Rename.
  const renameForm = page.locator('form:has(input[name="title"])');
  await renameForm.locator('input[name="title"]').fill("M4 Crew Chat — Renamed");
  await renameForm.locator('button:has-text("Rename")').click();
  await settle(page);
  const [renamed] = await pz(`SELECT title FROM conversations WHERE id='m4-group'`);
  check("group renamed (system message posted)", renamed.title === "M4 Crew Chat — Renamed");

  // Add + remove a participant.
  await openMenu(page);
  const addForm = page.locator('form:has(select[name="userId"])');
  await addForm.locator('select[name="userId"]').selectOption(tech.id);
  await addForm.locator('button:has-text("Add")').click();
  await settle(page);
  let parts = await pz(`SELECT user_id FROM conversation_participants WHERE conversation_id='m4-group'`);
  check(`participant added (${parts.length} members)`, parts.some((p) => p.user_id === tech.id));

  await openMenu(page);
  await page.locator(`form:has(input[name="userId"][value="${tech.id}"]) button:has-text("Remove")`).click();
  await settle(page);
  parts = await pz(`SELECT user_id FROM conversation_participants WHERE conversation_id='m4-group'`);
  check("participant removed", !parts.some((p) => p.user_id === tech.id));

  // Delete own message (grace window) → placeholder.
  await closeMenu(page);
  await page.locator(`form:has(input[name="messageId"][value="m4-msg-own"]) button`).click();
  await settle(page);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  const [del] = await pz(`SELECT deleted_at FROM messages WHERE id='m4-msg-own'`);
  const threadBody = await page.textContent("body");
  check("own message removed within grace → placeholder shown", del.deleted_at !== null && threadBody.includes("message removed") && !threadBody.includes("oops wrong chat"));

  // Archive the thread for this user only → off the list; office still sees it.
  await openMenu(page);
  await page.click('button:has-text("Archive thread")');
  await settle(page);
  const [ownPart] = await pz(`SELECT archived_at FROM conversation_participants WHERE conversation_id='m4-group' AND user_id='${owner.id}'`);
  await page.goto(`${BASE}/messages`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  const myList = await page.textContent("body");
  check("archived thread hidden from MY list", ownPart.archived_at !== null && !myList.includes("M4 Crew Chat — Renamed"));
  const [officePart] = await pz(`SELECT archived_at FROM conversation_participants WHERE conversation_id='m4-group' AND user_id='${office.id}'`);
  check("per-user only — the other participant is untouched", officePart.archived_at === null);

  // Unarchive + leave.
  await page.goto(`${BASE}/messages/m4-group`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  await openMenu(page);
  await page.click('button:has-text("Unarchive")');
  await settle(page);
  await page.goto(`${BASE}/messages/m4-group`, { waitUntil: "networkidle" });
  await openMenu(page);
  await page.click('button:has-text("Leave group")');
  await settle(page);
  const stillIn = await pz(`SELECT id FROM conversation_participants WHERE conversation_id='m4-group' AND user_id='${owner.id}'`);
  check("left the group (membership row gone)", stillIn.length === 0);
}

// ═══ APPROVALS ═══════════════════════════════════════════════════════════════
{
  // Queue a customer message via the compose form on /approvals.
  const [cust] = await pz(`SELECT id, name FROM customers WHERE archived_at IS NULL LIMIT 1`);
  await page.goto(`${BASE}/approvals`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  const compose = page.locator('form:has(select[name="customerId"]):has(textarea[name="body"])').first();
  await compose.locator('select[name="customerId"]').selectOption(cust.id);
  const subj = compose.locator('input[name="subject"]');
  if (await subj.count()) await subj.fill("M4 test note");
  await compose.locator('textarea[name="body"]').fill("Original body before edit");
  await compose.locator('button[type="submit"]').first().click();
  await settle(page);
  let [row] = await pz(`SELECT id, status FROM outbound_messages WHERE body='Original body before edit'`);
  check("customer message queued (PENDING_APPROVAL)", row?.status === "PENDING_APPROVAL");

  // Edit own pending.
  const editDetails = page.locator(`details:has(form:has(input[name="id"][value="${row.id}"]):has(textarea[name="body"]))`).first();
  await editDetails.locator("summary").click();
  await page.waitForTimeout(300);
  await editDetails.locator('textarea[name="body"]').fill("Edited body while pending");
  await editDetails.locator('button:has-text("Save changes")').click();
  await settle(page);
  [row] = await pz(`SELECT id, body, status FROM outbound_messages WHERE id='${row.id}'`);
  check("own pending request edited", row.body === "Edited body while pending");

  // Withdraw → CANCELLED (the enum's first UI path).
  await page.locator(`form:has(input[name="id"][value="${row.id}"]) button:has-text("Withdraw")`).click();
  await settle(page);
  [row] = await pz(`SELECT status FROM outbound_messages WHERE id='${row.id}'`);
  check("withdraw sets CANCELLED (audited)", row.status === "CANCELLED" && (await audits("WITHDRAW_OUTBOUND")).length > 0);

  // Bulk approve follow-up touches: queue two from real pending follow-ups.
  const fus = await pz(`SELECT id, body FROM follow_ups WHERE status='PENDING' LIMIT 2`);
  for (const fu of fus) {
    await pz(`INSERT INTO outbound_messages (kind, status, subject, body, follow_up_id, requested_by_id)
      SELECT 'FOLLOW_UP_TOUCH','PENDING_APPROVAL','Follow-up touch', body, id, (SELECT id FROM users WHERE email='owner@plumbzebra.demo')
      FROM follow_ups WHERE id='${fu.id}'`);
  }
  await page.goto(`${BASE}/approvals`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.click('button:has-text("Approve all")');
  await settle(page, 1500);
  const [pendingLeft] = await pz(`SELECT count(*)::int n FROM outbound_messages WHERE kind='FOLLOW_UP_TOUCH' AND status='PENDING_APPROVAL'`);
  const [sentFu] = await pz(`SELECT count(*)::int n FROM follow_ups WHERE id IN ('${fus.map((f) => f.id).join("','")}') AND status='SENT'`);
  check(`bulk approve cleared the follow-up queue (${fus.length} → 0) and SENT the touches`, pendingLeft.n === 0 && sentFu.n === fus.length);
  check("bulk approve audited with count", (await audits("BULK_APPROVE_OUTBOUND"))[0]?.detail?.count >= fus.length);
}

// ═══ COMPLIANCE ══════════════════════════════════════════════════════════════
{
  await page.goto(`${BASE}/compliance`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);

  // Template edit + deactivate/reactivate.
  const [tpl] = await pz(`SELECT id, name, active FROM inspection_templates WHERE active LIMIT 1`);
  const tplDetails = page.locator(`details:has(input[name="templateId"][value="${tpl.id}"]):has(input[name="name"])`).first();
  await tplDetails.locator("summary").click();
  await page.waitForTimeout(300);
  await tplDetails.locator('input[name="name"]').fill(`${tpl.name} v2`);
  await tplDetails.locator('button:has-text("Save template")').click();
  await settle(page);
  const [tplAfter] = await pz(`SELECT name FROM inspection_templates WHERE id='${tpl.id}'`);
  check("inspection template edited (the run-page hint is finally true)", tplAfter.name === `${tpl.name} v2`);

  await page.locator(`form:has(input[name="templateId"][value="${tpl.id}"]) button:has-text("Deactivate")`).click();
  await settle(page);
  const [deact] = await pz(`SELECT active FROM inspection_templates WHERE id='${tpl.id}'`);
  check("template deactivated (history untouched)", deact.active === false);
  await page.locator(`form:has(input[name="templateId"][value="${tpl.id}"]) button:has-text("Reactivate")`).click();
  await settle(page);

  // Inspection reschedule + reassign; cancel → reopen.
  const [insp] = await pz(`SELECT i.id, i.inspector_id FROM inspections i WHERE i.status='SCHEDULED' LIMIT 1`);
  if (insp) {
    const [newInspector] = await pz(`SELECT id, name FROM users WHERE active AND id != COALESCE('${insp.inspector_id}','x') LIMIT 1`);
    const resDetails = page.locator(`details:has(form:has(input[name="inspectionId"][value="${insp.id}"]):has(input[name="scheduledAt"]))`).first();
    await resDetails.locator("summary").click();
    await page.waitForTimeout(300);
    await resDetails.locator('input[name="scheduledAt"]').fill("2026-08-03T10:30");
    await resDetails.locator('select[name="inspectorId"]').selectOption(newInspector.id);
    await resDetails.locator('button:has-text("Save")').click();
    await settle(page);
    const [resAfter] = await pz(`SELECT scheduled_at, inspector_id FROM inspections WHERE id='${insp.id}'`);
    check("inspection rescheduled + reassigned (audited)",
      resAfter.inspector_id === newInspector.id && new Date(resAfter.scheduled_at).getDate() === 3 && (await audits("INSPECTION_RESCHEDULED"))[0]?.entity_id === insp.id);

    await page.locator(`form:has(input[name="inspectionId"][value="${insp.id}"]) button:has-text("Cancel")`).click();
    await settle(page);
    await page.goto(`${BASE}/compliance?insp=CANCELLED`, { waitUntil: "networkidle" });
    await page.locator(`form:has(input[name="inspectionId"][value="${insp.id}"]) button:has-text("Reopen")`).click();
    await settle(page);
    const [reopened] = await pz(`SELECT status FROM inspections WHERE id='${insp.id}'`);
    check("cancelled inspection reopened onto the schedule", reopened.status === "SCHEDULED");
  } else {
    check("a SCHEDULED inspection exists (seed)", false);
  }

  // Cert edit/renew + revoke; EQUIPMENT holder option present.
  await page.goto(`${BASE}/compliance`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  const [cert] = await pz(`SELECT id, name, expires_at FROM certifications WHERE expires_at IS NOT NULL ORDER BY expires_at LIMIT 1`);
  const certDetails = page.locator(`details:has(form:has(input[name="certId"][value="${cert.id}"]):has(input[name="expiresAt"]))`).first();
  await certDetails.locator("summary").click();
  await page.waitForTimeout(300);
  await certDetails.locator('input[name="expiresAt"]').fill("2028-01-15");
  await certDetails.locator('button:has-text("Save cert")').click();
  await settle(page);
  const [renewed] = await pz(`SELECT expires_at, renewal_notified_at FROM certifications WHERE id='${cert.id}'`);
  check("certification renewed (expiry pushed, renewal cycle reset)",
    new Date(renewed.expires_at).getFullYear() === 2028 && renewed.renewal_notified_at === null);

  const revDetails = page.locator(`details:has(form:has(input[name="certId"][value="${cert.id}"]):has(input[name="reason"]))`).first();
  await revDetails.locator("summary").click();
  await page.waitForTimeout(300);
  await revDetails.locator('input[name="reason"]').fill("Failed audit");
  await revDetails.locator('button:has-text("Go")').click();
  await settle(page);
  const [revoked] = await pz(`SELECT expires_at, notes FROM certifications WHERE id='${cert.id}'`);
  check("certification revoked — expired now, reason on record",
    new Date(revoked.expires_at) <= new Date() && revoked.notes.includes("[REVOKED: Failed audit]"));

  const body = await page.textContent("body");
  check("EQUIPMENT holder option available on the add-cert form", body.includes("Equipment (for equipment-held certs)"));
}

await ctx.close();
await browser.close();
await pool.end();
console.log(failures === 0 ? "\nALL M4 CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
