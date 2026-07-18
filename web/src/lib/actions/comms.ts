"use server";

import { and, gte, inArray, lt } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { t, withTenant } from "@/db";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { audit, notify } from "./helpers";
import { hasRecentSend, orgName, sendTransactionalSms } from "@/lib/comms/sms";
import { fmtDateTime } from "@/lib/format";

/**
 * Dispatch D1 — appointment-reminder sweep.
 *
 * Sends the templated day-before REMINDER SMS for every job scheduled
 * TOMORROW (status SCHEDULED/DISPATCHED). Deduped per job via the recorded
 * outbound_messages, so running the sweep twice never double-texts anyone.
 * Triggered from the dispatch board; a cron can hit the same action daily.
 */
export async function sendTomorrowReminders() {
  const session = await requireSession();
  if (!can(session.role, "dispatch.manage")) throw new Error("Not allowed");

  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);

  const jobs = await withTenant(session.organizationId, (tx) =>
    tx.query.jobs.findMany({
      where: and(
        gte(t.jobs.scheduledAt, start),
        lt(t.jobs.scheduledAt, end),
        inArray(t.jobs.status, ["SCHEDULED", "DISPATCHED"])
      ),
      with: { customer: true, property: true },
    })
  );

  const company = await orgName(session.organizationId);
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const job of jobs) {
    if (await hasRecentSend(session.organizationId, job.id, "REMINDER")) {
      skipped++;
      continue;
    }
    const outcome = await sendTransactionalSms({
      organizationId: session.organizationId,
      requestedById: session.userId,
      kind: "REMINDER",
      customerId: job.customerId,
      jobId: job.id,
      params: {
        companyName: company,
        customerFirstName: job.customer.name,
        jobType: job.jobType,
        when: job.scheduledAt ? fmtDateTime(job.scheduledAt) : "tomorrow",
        address: job.property.address,
      },
    });
    if (outcome.status === "SENT") sent++;
    else if (outcome.status === "FAILED") failed++;
    else skipped++;
  }

  await audit(session.userId, "REMINDER_SWEEP", "Dispatch", undefined, {
    jobs: jobs.length,
    sent,
    skipped,
    failed,
  });
  await notify(
    session.userId,
    failed > 0 ? `⚠️ Reminders: ${sent} sent, ${failed} FAILED` : `✅ Reminders: ${sent} sent`,
    `${jobs.length} job(s) tomorrow · ${sent} sent · ${skipped} skipped (already sent / opt-out / no phone) · ${failed} failed`,
    "/dispatch"
  );
  revalidatePath("/dispatch");
}
