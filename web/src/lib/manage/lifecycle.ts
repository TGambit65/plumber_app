/**
 * M1 lifecycle rules — PURE module, unit-testable.
 *
 * Centralizes the management-plan invariants (docs/strategy/specs/
 * management-functionality-plan.md §2): explicit status maps with deliberate
 * back-transitions, archive-over-delete guards, and blockers expressed as
 * human-readable strings so the UI can explain WHY an action is refused.
 */

// ── Jobs ─────────────────────────────────────────────────────────────────────

export type JobStatus =
  | "UNSCHEDULED"
  | "SCHEDULED"
  | "DISPATCHED"
  | "EN_ROUTE"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "CANCELLED";

/** One SAFE step back for mis-taps. Never backwards out of COMPLETED/CANCELLED. */
const JOB_REVERT: Partial<Record<JobStatus, JobStatus>> = {
  DISPATCHED: "SCHEDULED",
  EN_ROUTE: "DISPATCHED",
  IN_PROGRESS: "EN_ROUTE",
};

export function jobRevertTarget(status: JobStatus): JobStatus | null {
  return JOB_REVERT[status] ?? null;
}

/** Cancel is allowed from any state except the terminal ones. */
export function jobCancelBlocker(status: JobStatus): string | null {
  if (status === "COMPLETED") return "Completed jobs can't be cancelled — void the invoice instead.";
  if (status === "CANCELLED") return "Job is already cancelled.";
  return null;
}

/** Reschedule/reassign is for jobs that haven't started; unstarted statuses only. */
export function jobRescheduleBlocker(status: JobStatus): string | null {
  if (status === "IN_PROGRESS") return "Job is in progress — finish or revert it first.";
  if (status === "COMPLETED" || status === "CANCELLED") return "Closed jobs can't be rescheduled.";
  return null;
}

/** Archive is the lifecycle exit for CLOSED jobs only. */
export function jobArchiveBlocker(status: JobStatus): string | null {
  if (status === "COMPLETED" || status === "CANCELLED") return null;
  return "Only completed or cancelled jobs can be archived.";
}

/** Statuses that count as "open" work for archive guards. */
export const OPEN_JOB_STATUSES: JobStatus[] = ["UNSCHEDULED", "SCHEDULED", "DISPATCHED", "EN_ROUTE", "IN_PROGRESS"];

/** New status after a reschedule, never clobbering an in-flight state. */
export function statusAfterReschedule(current: JobStatus, hasTech: boolean): JobStatus {
  // DISPATCHED stays DISPATCHED only while a tech is still on it.
  if (current === "DISPATCHED") return hasTech ? "DISPATCHED" : "SCHEDULED";
  if (current === "UNSCHEDULED" || current === "SCHEDULED") return "SCHEDULED";
  return current;
}

// ── Customers / properties ───────────────────────────────────────────────────

/** Why a customer can't be archived right now (null = go ahead). */
export function customerArchiveBlocker(input: { openJobs: number; openInvoices: number }): string | null {
  const parts: string[] = [];
  if (input.openJobs > 0) parts.push(`${input.openJobs} open job${input.openJobs > 1 ? "s" : ""}`);
  if (input.openInvoices > 0) parts.push(`${input.openInvoices} unpaid invoice${input.openInvoices > 1 ? "s" : ""}`);
  if (parts.length === 0) return null;
  return `Can't archive — customer has ${parts.join(" and ")}. Close them out first.`;
}

export function propertyArchiveBlocker(input: { openJobs: number }): string | null {
  if (input.openJobs > 0)
    return `Can't archive — ${input.openJobs} open job${input.openJobs > 1 ? "s" : ""} reference this property.`;
  return null;
}

// ── Leads ────────────────────────────────────────────────────────────────────

export type LeadStage = "NEW" | "CONTACTED" | "ESTIMATE_SCHEDULED" | "ESTIMATE_SENT" | "FOLLOW_UP" | "WON" | "LOST";

/** Closed leads reopen into FOLLOW_UP (an open, working stage). */
export const LEAD_REOPEN_STAGE: LeadStage = "FOLLOW_UP";

export function leadReopenBlocker(stage: LeadStage): string | null {
  if (stage === "WON" || stage === "LOST") return null;
  return "Only WON or LOST leads can be reopened.";
}
