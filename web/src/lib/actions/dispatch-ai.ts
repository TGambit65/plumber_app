"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { t, withTenant } from "@/db";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { audit, logActivity, notify } from "./helpers";
import { orgName, sendTransactionalSms } from "@/lib/comms/sms";
import { pushJobToCalendar } from "@/lib/calendar/push";
import { fmtDateTime } from "@/lib/format";

/**
 * D4 server actions — the HUMAN side of "the engine proposes, the dispatcher
 * disposes". Accepting a suggestion runs the exact same pipeline as a manual
 * assignment (activity, tech notification, confirmation SMS, calendar push);
 * the only difference is the audit trail records that an AI suggestion was
 * accepted (or rejected), with its reasons — the training signal for tuning.
 * Nothing in this file ever runs without a dispatcher's explicit click.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

export async function acceptSuggestion(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "dispatch.manage")) throw new Error("Not allowed");
  const jobId = str(formData, "jobId");
  const techId = str(formData, "techId");
  const whenIso = str(formData, "whenIso");
  const reasons = str(formData, "reasons");
  const kind = str(formData, "kind") || "NORMAL";
  if (!jobId || !techId || !whenIso) return;
  const scheduledAt = new Date(whenIso);

  const job = await withTenant(session.organizationId, async (tx) => {
    const found = await tx.query.jobs.findFirst({
      where: eq(t.jobs.id, jobId),
      with: { customer: true, property: true },
    });
    if (!found) return null;
    const tech = await tx.query.users.findFirst({ where: and(eq(t.users.id, techId), eq(t.users.active, true)) });
    if (!tech) return null;
    await tx
      .update(t.jobs)
      .set({ assignedToId: techId, scheduledAt, status: "SCHEDULED" })
      .where(eq(t.jobs.id, jobId));
    return found;
  });
  if (!job) return;

  await audit(session.userId, "AI_SUGGESTION_ACCEPTED", "Job", jobId, {
    techId,
    scheduledAt: whenIso,
    kind,
    reasons,
  });
  await logActivity({
    kind: "SYSTEM",
    body: `Job ${job.number} assigned via accepted suggestion (${reasons}) for ${fmtDateTime(scheduledAt)}`,
    userId: session.userId,
    jobId,
    customerId: job.customerId,
  });
  await notify(
    techId,
    `New job assigned: ${job.number} — ${job.jobType}`,
    `${job.customer.name} · ${job.property.address} · ${fmtDateTime(scheduledAt)}`,
    "/my-day"
  );
  await sendTransactionalSms({
    organizationId: session.organizationId,
    requestedById: session.userId,
    kind: "BOOKING_CONFIRMATION",
    customerId: job.customerId,
    jobId,
    params: {
      companyName: await orgName(session.organizationId),
      customerFirstName: job.customer.name,
      jobType: job.jobType,
      when: fmtDateTime(scheduledAt),
      address: job.property.address,
    },
  });
  await pushJobToCalendar(session.organizationId, jobId);

  revalidatePath("/dispatch");
  revalidatePath("/jobs");
}

export async function dismissSuggestion(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "dispatch.manage")) throw new Error("Not allowed");
  const jobId = str(formData, "jobId");
  const techId = str(formData, "techId");
  const reasons = str(formData, "reasons");
  if (!jobId) return;
  // The rejection IS the point: an audited training signal for score tuning.
  await audit(session.userId, "AI_SUGGESTION_REJECTED", "Job", jobId, { techId, reasons });
  revalidatePath("/dispatch");
}

export async function applyOptimizedDay(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "dispatch.manage")) throw new Error("Not allowed");
  const techId = str(formData, "techId");
  const planRaw = str(formData, "plan");
  const summary = str(formData, "summary");
  if (!techId || !planRaw) return;

  let plan: Array<{ id: string; startIso: string; endIso: string }>;
  try {
    plan = JSON.parse(planRaw);
    if (!Array.isArray(plan) || plan.some((p) => !p.id || !p.startIso || !p.endIso)) throw new Error("bad plan");
  } catch {
    return;
  }

  const applied = await withTenant(session.organizationId, async (tx) => {
    const ids = plan.map((p) => p.id);
    // Only this tech's still-editable jobs may move (RLS scopes to the org).
    const rows = await tx.query.jobs.findMany({
      where: and(
        inArray(t.jobs.id, ids),
        eq(t.jobs.assignedToId, techId),
        inArray(t.jobs.status, ["SCHEDULED", "DISPATCHED"])
      ),
    });
    if (rows.length !== plan.length) return 0;
    for (const p of plan) {
      await tx
        .update(t.jobs)
        .set({ scheduledAt: new Date(p.startIso), scheduledEnd: new Date(p.endIso) })
        .where(eq(t.jobs.id, p.id));
    }
    return rows.length;
  });

  if (applied > 0) {
    await audit(session.userId, "AI_OPTIMIZE_APPLIED", "Dispatch", techId, { jobs: applied, summary });
    await notify(
      techId,
      "📋 Your route was optimized",
      summary || `${applied} jobs retimed by the dispatcher.`,
      "/my-day"
    );
    // Keep the org calendar mirrored (no-op when none connected).
    for (const p of plan) await pushJobToCalendar(session.organizationId, p.id);
  }
  revalidatePath("/dispatch");
  revalidatePath("/jobs");
}
