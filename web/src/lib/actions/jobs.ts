"use server";

/* M1 job management actions — edit, reschedule/reassign, cancel, revert,
 * archive. Design principles (management plan §2): archive over delete,
 * explicit status maps, audit every mutation, loud guards. */

import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";
import { t, withTenant } from "@/db";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { audit, logActivity, notify } from "@/lib/actions/helpers";
import { fmtDateTime } from "@/lib/format";
import { pushJobToCalendar, removeJobFromCalendar } from "@/lib/calendar/push";
import {
  jobArchiveBlocker,
  jobCancelBlocker,
  jobRescheduleBlocker,
  jobRevertTarget,
  statusAfterReschedule,
  type JobStatus,
} from "@/lib/manage/lifecycle";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const PRIORITIES = ["LOW", "NORMAL", "HIGH", "EMERGENCY"] as const;

async function guardDispatch() {
  const session = await requireSession();
  if (!can(session.role, "dispatch.manage")) throw new Error("Not allowed");
  return session;
}

function revalidateJobs(jobId?: string) {
  revalidatePath("/jobs");
  revalidatePath("/dispatch");
  revalidatePath("/my-day");
  if (jobId) revalidatePath(`/jobs/${jobId}`);
}

/** Edit the job's descriptive fields (type, priority, description, notes). */
export async function updateJob(formData: FormData) {
  const session = await guardDispatch();
  const jobId = str(formData, "jobId");
  const jobType = str(formData, "jobType");
  if (!jobId || !jobType) return;
  const priority = (PRIORITIES as readonly string[]).includes(str(formData, "priority"))
    ? (str(formData, "priority") as (typeof PRIORITIES)[number])
    : "NORMAL";

  const job = await withTenant(session.organizationId, async (tx) => {
    const found = await tx.query.jobs.findFirst({ where: eq(t.jobs.id, jobId) });
    if (!found) return null;
    await tx
      .update(t.jobs)
      .set({
        jobType,
        priority,
        description: str(formData, "description") || null,
        internalNotes: str(formData, "internalNotes") || null,
        updatedAt: new Date(),
      })
      .where(eq(t.jobs.id, jobId));
    return found;
  });
  if (!job) return;

  await audit(session.userId, "UPDATE", "Job", jobId, { number: job.number, jobType, priority });
  await logActivity({
    kind: "SYSTEM",
    body: `Job ${job.number} details updated by ${session.name}`,
    userId: session.userId,
    jobId,
    customerId: job.customerId,
  });
  // Keep the mirrored calendar event's title/description fresh.
  await pushJobToCalendar(session.organizationId, jobId);
  revalidateJobs(jobId);
}

/**
 * Reschedule and/or reassign a job — change start, duration (finally captures
 * scheduledEnd), and tech, or UNASSIGN back to the lane. Never clobbers an
 * in-flight status (guarded for IN_PROGRESS/closed).
 */
export async function rescheduleJob(formData: FormData) {
  const session = await guardDispatch();
  const jobId = str(formData, "jobId");
  const when = str(formData, "scheduledAt");
  const durationMin = parseInt(str(formData, "durationMin") || "120", 10);
  const techId = str(formData, "techId"); // "" = unassign
  if (!jobId || !when) return;

  const scheduledAt = new Date(when);
  const scheduledEnd = new Date(
    scheduledAt.getTime() + (Number.isFinite(durationMin) && durationMin > 0 ? durationMin : 120) * 60_000
  );

  const result = await withTenant(session.organizationId, async (tx) => {
    const job = await tx.query.jobs.findFirst({ where: eq(t.jobs.id, jobId), with: { assignedTo: true } });
    if (!job) return null;
    const blocker = jobRescheduleBlocker(job.status as JobStatus);
    if (blocker) throw new Error(blocker);

    const status = statusAfterReschedule(job.status as JobStatus, Boolean(techId));
    await tx
      .update(t.jobs)
      .set({ scheduledAt, scheduledEnd, assignedToId: techId || null, status, updatedAt: new Date() })
      .where(eq(t.jobs.id, jobId));
    return { job, previousTechId: job.assignedToId };
  });
  if (!result) return;
  const { job, previousTechId } = result;

  await audit(session.userId, "JOB_RESCHEDULED", "Job", jobId, {
    number: job.number,
    scheduledAt: scheduledAt.toISOString(),
    scheduledEnd: scheduledEnd.toISOString(),
    techId: techId || null,
  });
  await logActivity({
    kind: "STATUS",
    body: `Job ${job.number} rescheduled to ${fmtDateTime(scheduledAt)}${techId ? "" : " and unassigned"}`,
    userId: session.userId,
    jobId,
    customerId: job.customerId,
  });
  if (techId && techId !== previousTechId) {
    await notify(techId, `Job assigned: ${job.number} — ${job.jobType}`, fmtDateTime(scheduledAt), "/my-day");
  }
  if (previousTechId && techId !== previousTechId) {
    await notify(previousTechId, `Job reassigned away: ${job.number}`, "It's off your schedule.", "/my-day");
  }
  await pushJobToCalendar(session.organizationId, jobId); // PATCHes the same event
  revalidateJobs(jobId);
}

/** Unassign a job from the dispatch board — back to the unassigned lane. */
export async function unassignJob(formData: FormData) {
  const session = await guardDispatch();
  const jobId = str(formData, "jobId");
  if (!jobId) return;

  const job = await withTenant(session.organizationId, async (tx) => {
    const found = await tx.query.jobs.findFirst({ where: eq(t.jobs.id, jobId) });
    if (!found) return null;
    const blocker = jobRescheduleBlocker(found.status as JobStatus);
    if (blocker) throw new Error(blocker);
    await tx
      .update(t.jobs)
      .set({
        assignedToId: null,
        status: statusAfterReschedule(found.status as JobStatus, false),
        updatedAt: new Date(),
      })
      .where(eq(t.jobs.id, jobId));
    return found;
  });
  if (!job) return;

  await audit(session.userId, "JOB_UNASSIGNED", "Job", jobId, { number: job.number });
  await logActivity({
    kind: "STATUS",
    body: `Job ${job.number} unassigned — back to the lane`,
    userId: session.userId,
    jobId,
    customerId: job.customerId,
  });
  if (job.assignedToId) {
    await notify(job.assignedToId, `Job unassigned: ${job.number}`, "It's off your schedule.", "/my-day");
  }
  revalidateJobs(jobId);
}

/** Cancel a job with a required reason. Frees the slot + removes the calendar event. */
export async function cancelJob(formData: FormData) {
  const session = await guardDispatch();
  const jobId = str(formData, "jobId");
  const reason = str(formData, "reason");
  if (!jobId) return;
  if (!reason) throw new Error("A cancellation reason is required");

  const job = await withTenant(session.organizationId, async (tx) => {
    const found = await tx.query.jobs.findFirst({ where: eq(t.jobs.id, jobId) });
    if (!found) return null;
    const blocker = jobCancelBlocker(found.status as JobStatus);
    if (blocker) throw new Error(blocker);

    const note = `[Cancelled ${new Date().toISOString().slice(0, 10)}: ${reason}]`;
    await tx
      .update(t.jobs)
      .set({
        status: "CANCELLED",
        internalNotes: found.internalNotes ? `${found.internalNotes}\n${note}` : note,
        updatedAt: new Date(),
      })
      .where(eq(t.jobs.id, jobId));
    // Close any running clocks on this job.
    await tx
      .update(t.timeEntries)
      .set({ endedAt: new Date() })
      .where(and(eq(t.timeEntries.jobId, jobId), isNull(t.timeEntries.endedAt)));
    return found;
  });
  if (!job) return;

  await audit(session.userId, "JOB_CANCELLED", "Job", jobId, { number: job.number, reason, previousStatus: job.status });
  await logActivity({
    kind: "STATUS",
    body: `Job ${job.number} CANCELLED — ${reason}`,
    userId: session.userId,
    jobId,
    customerId: job.customerId,
  });
  if (job.assignedToId) {
    await notify(job.assignedToId, `Job cancelled: ${job.number}`, reason, "/my-day");
  }
  await removeJobFromCalendar(session.organizationId, jobId);
  revalidateJobs(jobId);
}

/** One safe step back (mis-tap fix): IN_PROGRESS→EN_ROUTE→DISPATCHED→SCHEDULED. */
export async function revertJobStatus(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "dispatch.manage") && !can(session.role, "jobs.work")) throw new Error("Not allowed");
  const jobId = str(formData, "jobId");
  if (!jobId) return;

  const result = await withTenant(session.organizationId, async (tx) => {
    const job = await tx.query.jobs.findFirst({ where: eq(t.jobs.id, jobId) });
    if (!job) return null;
    const target = jobRevertTarget(job.status as JobStatus);
    if (!target) throw new Error(`Can't step back from ${job.status}`);
    await tx.update(t.jobs).set({ status: target, updatedAt: new Date() }).where(eq(t.jobs.id, jobId));
    // A revert also closes clocks the forward step started (travel/work).
    await tx
      .update(t.timeEntries)
      .set({ endedAt: new Date() })
      .where(and(eq(t.timeEntries.jobId, jobId), isNull(t.timeEntries.endedAt)));
    return { job, target };
  });
  if (!result) return;

  await audit(session.userId, "JOB_STATUS_REVERTED", "Job", jobId, {
    number: result.job.number,
    from: result.job.status,
    to: result.target,
  });
  await logActivity({
    kind: "STATUS",
    body: `Job ${result.job.number} stepped back: ${result.job.status} → ${result.target}`,
    userId: session.userId,
    jobId,
    customerId: result.job.customerId,
  });
  revalidateJobs(jobId);
}

/** Archive a closed job (wires the existing deletedAt/deletedById columns). */
export async function archiveJob(formData: FormData) {
  const session = await guardDispatch();
  const jobId = str(formData, "jobId");
  if (!jobId) return;

  const job = await withTenant(session.organizationId, async (tx) => {
    const found = await tx.query.jobs.findFirst({ where: eq(t.jobs.id, jobId) });
    if (!found) return null;
    const blocker = jobArchiveBlocker(found.status as JobStatus);
    if (blocker) throw new Error(blocker);
    await tx
      .update(t.jobs)
      .set({ deletedAt: new Date(), deletedById: session.userId, updatedAt: new Date() })
      .where(eq(t.jobs.id, jobId));
    return found;
  });
  if (!job) return;

  await audit(session.userId, "JOB_ARCHIVED", "Job", jobId, { number: job.number });
  revalidateJobs(jobId);
}

/** Restore an archived job. */
export async function unarchiveJob(formData: FormData) {
  const session = await guardDispatch();
  const jobId = str(formData, "jobId");
  if (!jobId) return;
  const job = await withTenant(session.organizationId, async (tx) => {
    const found = await tx.query.jobs.findFirst({ where: eq(t.jobs.id, jobId) });
    if (!found || !found.deletedAt) return null;
    await tx
      .update(t.jobs)
      .set({ deletedAt: null, deletedById: null, updatedAt: new Date() })
      .where(eq(t.jobs.id, jobId));
    return found;
  });
  if (!job) return;
  await audit(session.userId, "JOB_UNARCHIVED", "Job", jobId, { number: job.number });
  revalidateJobs(jobId);
}
