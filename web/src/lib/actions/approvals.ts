"use server";

/* Approval-gated egress (constraint 8): nothing customer-facing leaves without
 * owner/office approval. Customer-facing work QUEUES an outbound_messages row
 * (PENDING_APPROVAL); office/admin (approvals.manage) approve — which EXECUTES
 * the real effect — or reject. LICENSED_SIGNOFF cards route to a human holding
 * a valid certification matching requiredCertName (or an ADMIN), enforced
 * server-side here. */

import { revalidatePath } from "next/cache";
import { t, withTenant } from "@/db";
import { and, eq, inArray } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { audit, logActivity, notify } from "@/lib/actions/helpers";
import { reallySendEstimate, reallySendFollowUp } from "@/lib/actions/sales";
import { deliverCustomerLink, publicBaseUrl, type LinkDeliveryOutcome } from "@/lib/comms/deliver";
import { orgName } from "@/lib/comms/sms";

// ── Internal helpers ─────────────────────────────────────────────────────────

function str(fd: FormData, key: string): string {
  return String(fd.get(key) ?? "").trim();
}

const KIND_LABEL: Record<string, string> = {
  ESTIMATE_SEND: "Estimate send",
  FOLLOW_UP_TOUCH: "Follow-up touch",
  CUSTOMER_MESSAGE: "Customer message",
  LICENSED_SIGNOFF: "Licensed sign-off",
};

/** Ping OFFICE + ADMIN (the approvals.manage roles) that something is waiting. */
async function notifyApprovers(
  organizationId: string,
  exceptUserId: string,
  title: string,
  body: string
) {
  const approvers = await withTenant(organizationId, (tx) =>
    tx
      .select({ id: t.users.id })
      .from(t.users)
      .where(and(eq(t.users.active, true), inArray(t.users.role, ["OFFICE", "ADMIN"])))
  );
  for (const a of approvers) {
    if (a.id === exceptUserId) continue;
    await notify(a.id, title, body, "/approvals");
  }
}

/** SMS unless the recipient snapshot looks like an email address. */
function channelForRecipient(recipient: string | null): "SMS" | "EMAIL" {
  return recipient && recipient.includes("@") ? "EMAIL" : "SMS";
}

/** Sensible forward motion for a permit when a licensed human signs off. */
function nextPermitStatus(current: string): (typeof t.permits.$inferSelect)["status"] {
  switch (current) {
    case "NOT_APPLIED":
    case "APPLIED":
      return "ISSUED";
    case "ISSUED":
    case "INSPECTION_SCHEDULED":
      return "PASSED";
    default:
      return current as (typeof t.permits.$inferSelect)["status"];
  }
}

/**
 * Server-side licensed routing. Returns null when eligible, or a reason string.
 * LICENSED_SIGNOFF may only be approved by an ADMIN, or by a user holding a
 * valid (non-expired) certification whose name === requiredCertName.
 */
async function licensedIneligibleReason(
  organizationId: string,
  userId: string,
  role: string,
  requiredCertName: string | null
): Promise<string | null> {
  if (role === "ADMIN") return null;
  if (!requiredCertName) return null; // no specific license demanded
  const now = new Date();
  const certs = await withTenant(organizationId, (tx) =>
    tx.query.certifications.findMany({
      where: and(eq(t.certifications.userId, userId), eq(t.certifications.name, requiredCertName)),
    })
  );
  const holdsValid = certs.some((c) => !c.expiresAt || c.expiresAt > now);
  if (holdsValid) return null;
  return `This sign-off requires a valid "${requiredCertName}" certification (or admin).`;
}

// ── Queue actions (produce PENDING_APPROVAL rows) ────────────────────────────

/** Queue an ESTIMATE_SEND. (markEstimateSent in sales.ts is the wired path; this
 *  is the reusable API for the same effect.) */
export async function queueEstimateSend(estimateId: string) {
  const session = await requireSession();
  await withTenant(session.organizationId, async (tx) => {
    const est = await tx.query.estimates.findFirst({
      where: eq(t.estimates.id, estimateId),
      with: { customer: true },
    });
    if (!est) throw new Error("Estimate not found");
    const existing = await tx.query.outboundMessages.findFirst({
      where: and(
        eq(t.outboundMessages.estimateId, estimateId),
        eq(t.outboundMessages.status, "PENDING_APPROVAL")
      ),
    });
    if (existing) return;
    await tx.insert(t.outboundMessages).values({
      kind: "ESTIMATE_SEND",
      status: "PENDING_APPROVAL",
      customerId: est.customerId,
      recipient: est.customer.email ?? est.customer.phone ?? null,
      subject: `Estimate ${est.number}`,
      body: `Send estimate ${est.number} to ${est.customer.name}. Approving delivers the proposal and starts the default 7-day follow-up sequence.`,
      estimateId: est.id,
      requestedById: session.userId,
    });
  });
  await notifyApprovers(
    session.organizationId,
    session.userId,
    "✉️ Estimate send awaiting approval",
    `${session.name} queued an estimate for delivery.`
  );
  await audit(session.userId, "QUEUE_OUTBOUND", "Estimate", estimateId, { kind: "ESTIMATE_SEND" });
  revalidatePath("/approvals");
}

/** Queue a FOLLOW_UP_TOUCH. */
export async function queueFollowUpTouch(followUpId: string) {
  const session = await requireSession();
  await withTenant(session.organizationId, async (tx) => {
    const fu = await tx.query.followUps.findFirst({
      where: eq(t.followUps.id, followUpId),
      with: { estimate: { with: { customer: true } }, lead: true },
    });
    if (!fu) throw new Error("Follow-up not found");
    const existing = await tx.query.outboundMessages.findFirst({
      where: and(
        eq(t.outboundMessages.followUpId, followUpId),
        eq(t.outboundMessages.status, "PENDING_APPROVAL")
      ),
    });
    if (existing) return;
    await tx.insert(t.outboundMessages).values({
      kind: "FOLLOW_UP_TOUCH",
      status: "PENDING_APPROVAL",
      customerId: fu.estimate?.customerId ?? null,
      recipient:
        fu.estimate?.customer?.email ??
        fu.estimate?.customer?.phone ??
        fu.lead?.email ??
        fu.lead?.phone ??
        null,
      subject: `Follow-up ${fu.channel} touch`,
      body: fu.body,
      followUpId: fu.id,
      estimateId: fu.estimateId ?? null,
      requestedById: session.userId,
    });
  });
  await notifyApprovers(
    session.organizationId,
    session.userId,
    "✉️ Follow-up touch awaiting approval",
    `${session.name} queued a follow-up touch.`
  );
  await audit(session.userId, "QUEUE_OUTBOUND", "FollowUp", followUpId, { kind: "FOLLOW_UP_TOUCH" });
  revalidatePath("/approvals");
}

/** Queue a free-form CUSTOMER_MESSAGE. */
export async function queueCustomerMessage(formData: FormData) {
  const session = await requireSession();
  const customerId = str(formData, "customerId");
  const subject = str(formData, "subject");
  const body = str(formData, "body");
  if (!customerId) throw new Error("Pick a customer");
  if (!body) throw new Error("Message body is required");
  await withTenant(session.organizationId, async (tx) => {
    const customer = await tx.query.customers.findFirst({ where: eq(t.customers.id, customerId) });
    if (!customer) throw new Error("Customer not found");
    await tx.insert(t.outboundMessages).values({
      kind: "CUSTOMER_MESSAGE",
      status: "PENDING_APPROVAL",
      customerId,
      recipient: customer.email ?? customer.phone ?? null,
      subject: subject || null,
      body,
      requestedById: session.userId,
    });
  });
  await notifyApprovers(
    session.organizationId,
    session.userId,
    "✉️ Customer message awaiting approval",
    `${session.name} drafted a customer message.`
  );
  await audit(session.userId, "QUEUE_OUTBOUND", "Customer", customerId, { kind: "CUSTOMER_MESSAGE" });
  revalidatePath("/approvals");
}

/** Queue a LICENSED_SIGNOFF that routes to a licensed human (or admin). */
export async function queueLicensedSignoff(formData: FormData) {
  const session = await requireSession();
  const permitId = str(formData, "permitId") || null;
  const jobId = str(formData, "jobId") || null;
  const requiredCertName = str(formData, "requiredCertName");
  const body = str(formData, "body");
  if (!permitId && !jobId) throw new Error("Attach a permit or a job");
  if (!requiredCertName) throw new Error("Name the certification required to sign off");
  if (!body) throw new Error("Describe what's being signed off");
  await withTenant(session.organizationId, async (tx) => {
    let customerId: string | null = null;
    if (permitId) {
      const permit = await tx.query.permits.findFirst({
        where: eq(t.permits.id, permitId),
        with: { project: true },
      });
      if (!permit) throw new Error("Permit not found");
      customerId = permit.project?.customerId ?? null;
    } else if (jobId) {
      const job = await tx.query.jobs.findFirst({ where: eq(t.jobs.id, jobId) });
      if (!job) throw new Error("Job not found");
      customerId = job.customerId;
    }
    await tx.insert(t.outboundMessages).values({
      kind: "LICENSED_SIGNOFF",
      status: "PENDING_APPROVAL",
      customerId,
      subject: `Licensed sign-off — ${requiredCertName}`,
      body,
      permitId,
      jobId,
      requiredCertName,
      requestedById: session.userId,
    });
  });
  await notifyApprovers(
    session.organizationId,
    session.userId,
    "🔏 Licensed sign-off awaiting a licensed approver",
    `${session.name} requested a "${requiredCertName}" sign-off.`
  );
  await audit(session.userId, "QUEUE_OUTBOUND", "OutboundMessage", permitId ?? jobId ?? undefined, {
    kind: "LICENSED_SIGNOFF",
    requiredCertName,
  });
  revalidatePath("/approvals");
}

// ── Decisions ────────────────────────────────────────────────────────────────

/** Approve — checks eligibility, EXECUTES the effect, marks APPROVED_SENT. */
export async function approveOutbound(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "approvals.manage")) {
    throw new Error("You do not have permission to approve outbound messages.");
  }
  const id = str(formData, "id");

  const row = await withTenant(session.organizationId, (tx) =>
    tx.query.outboundMessages.findFirst({
      where: eq(t.outboundMessages.id, id),
      with: { estimate: true, followUp: true, permit: true, customer: true },
    })
  );
  if (!row) throw new Error("Outbound message not found");
  if (row.status !== "PENDING_APPROVAL") throw new Error("This message has already been decided.");

  // Licensed routing — strictly server-enforced.
  if (row.kind === "LICENSED_SIGNOFF") {
    const reason = await licensedIneligibleReason(
      session.organizationId,
      session.userId,
      session.role,
      row.requiredCertName
    );
    if (reason) throw new Error(reason + " Route it to a licensed teammate.");
  }

  // Execute the effect by kind.
  let delivery: LinkDeliveryOutcome | null = null;
  if (row.kind === "ESTIMATE_SEND" && row.estimateId) {
    const est = await reallySendEstimate(session.organizationId, row.estimateId, row.requestedById);
    // C1: really DELIVER the proposal link (email preferred, SMS fallback).
    const link = `${publicBaseUrl()}/proposal/${est.publicToken}`;
    delivery = await deliverCustomerLink({
      organizationId: session.organizationId,
      customerId: est.customerId,
      subject: `Your proposal from ${await orgName(session.organizationId)} — ${est.number}`,
      emailBody: [
        `Hi ${est.customer.name},`,
        ``,
        `Your proposal ${est.number} is ready. View your options and approve online here:`,
        link,
        ``,
        `Questions? Just reply to this email or give us a call.`,
      ].join("\n"),
      smsBody: `Your proposal ${est.number} is ready — view options & approve online: ${link}`,
    });
    if (delivery.status === "SENT") {
      await logActivity({
        kind: delivery.channel === "EMAIL" ? "EMAIL" : "SMS",
        body: `Proposal link for ${est.number} delivered by ${delivery.channel.toLowerCase()} to ${delivery.recipient}`,
        userId: session.userId,
        customerId: est.customerId,
        leadId: est.leadId ?? undefined,
      });
    } else {
      // Loud degraded surface: the approver sees exactly why nothing went out.
      await notify(
        session.userId,
        `⚠️ Proposal ${est.number} approved but NOT delivered`,
        delivery.error ?? `Delivery ${delivery.status}`,
        `/estimates/${est.id}`
      );
    }
  } else if (row.kind === "FOLLOW_UP_TOUCH" && row.followUpId) {
    await reallySendFollowUp(session.organizationId, row.followUpId, row.requestedById);
  } else if (row.kind === "CUSTOMER_MESSAGE") {
    await logActivity({
      kind: channelForRecipient(row.recipient),
      body: `${row.subject ? `${row.subject}: ` : ""}${row.body}`,
      userId: row.requestedById,
      customerId: row.customerId ?? undefined,
    });
  } else if (row.kind === "LICENSED_SIGNOFF") {
    if (row.permitId) {
      const projectId = await withTenant(session.organizationId, async (tx) => {
        const permit = await tx.query.permits.findFirst({ where: eq(t.permits.id, row.permitId!) });
        if (!permit) return null;
        await tx
          .update(t.permits)
          .set({ status: nextPermitStatus(permit.status) })
          .where(eq(t.permits.id, row.permitId!));
        return permit.projectId;
      });
      await logActivity({
        kind: "SYSTEM",
        body: `🔏 Licensed sign-off approved by ${session.name} (${row.requiredCertName ?? "admin"}) — ${row.body}`,
        userId: session.userId,
        projectId: projectId ?? undefined,
      });
    } else {
      await logActivity({
        kind: "SYSTEM",
        body: `🔏 Licensed sign-off approved by ${session.name} (${row.requiredCertName ?? "admin"}) — ${row.body}`,
        userId: session.userId,
        jobId: row.jobId ?? undefined,
        customerId: row.customerId ?? undefined,
      });
    }
  }

  await withTenant(session.organizationId, (tx) =>
    tx
      .update(t.outboundMessages)
      .set({
        status: "APPROVED_SENT",
        approvedById: session.userId,
        decidedAt: new Date(),
        // C1: honest delivery record on the approval row itself.
        ...(delivery
          ? {
              recipient: delivery.recipient ?? row.recipient,
              externalSid: delivery.externalId ?? null,
              deliveryStatus: delivery.status,
              deliveryError: delivery.error ?? null,
            }
          : {}),
      })
      .where(eq(t.outboundMessages.id, id))
  );

  await notify(
    row.requestedById,
    `✅ Approved & sent: ${KIND_LABEL[row.kind] ?? row.kind}`,
    `${session.name} approved your request.`,
    "/approvals"
  );
  await audit(session.userId, "APPROVE_OUTBOUND", "OutboundMessage", row.id, {
    kind: row.kind,
    requiredCertName: row.requiredCertName ?? undefined,
    estimateId: row.estimateId ?? undefined,
    followUpId: row.followUpId ?? undefined,
    permitId: row.permitId ?? undefined,
  });
  revalidatePath("/approvals");
}

// ── M4: requester-side management + bulk approve ─────────────────────────────

/** Withdraw your OWN pending request (the CANCELLED enum finally gets a path). */
export async function withdrawOutbound(formData: FormData) {
  const session = await requireSession();
  const id = str(formData, "id");
  if (!id) return;
  const row = await withTenant(session.organizationId, async (tx) => {
    const row = await tx.query.outboundMessages.findFirst({ where: eq(t.outboundMessages.id, id) });
    if (!row) throw new Error("Outbound message not found");
    if (row.requestedById !== session.userId && session.role !== "ADMIN") {
      throw new Error("You can only withdraw your own requests");
    }
    if (row.status !== "PENDING_APPROVAL") throw new Error("This request has already been decided.");
    await tx
      .update(t.outboundMessages)
      .set({ status: "CANCELLED", decidedAt: new Date() })
      .where(eq(t.outboundMessages.id, id));
    return row;
  });
  await audit(session.userId, "WITHDRAW_OUTBOUND", "OutboundMessage", row.id, { kind: row.kind });
  revalidatePath("/approvals");
}

/** Edit the subject/body of your OWN request while it's still pending. */
export async function updateOutbound(formData: FormData) {
  const session = await requireSession();
  const id = str(formData, "id");
  const body = str(formData, "body");
  if (!id || !body) return;
  const row = await withTenant(session.organizationId, async (tx) => {
    const row = await tx.query.outboundMessages.findFirst({ where: eq(t.outboundMessages.id, id) });
    if (!row) throw new Error("Outbound message not found");
    if (row.requestedById !== session.userId && session.role !== "ADMIN") {
      throw new Error("You can only edit your own requests");
    }
    if (row.status !== "PENDING_APPROVAL") throw new Error("This request has already been decided.");
    await tx
      .update(t.outboundMessages)
      .set({ body, subject: str(formData, "subject") || row.subject })
      .where(eq(t.outboundMessages.id, id));
    return row;
  });
  await audit(session.userId, "UPDATE", "OutboundMessage", row.id, { kind: row.kind });
  revalidatePath("/approvals");
}

/** Bulk-approve the low-risk queue: every pending FOLLOW_UP_TOUCH at once.
 *  (Estimates, customer messages and licensed sign-offs stay one-by-one.) */
export async function bulkApproveFollowUps() {
  const session = await requireSession();
  if (!can(session.role, "approvals.manage")) throw new Error("Not allowed");

  const rows = await withTenant(session.organizationId, (tx) =>
    tx.query.outboundMessages.findMany({
      where: and(eq(t.outboundMessages.kind, "FOLLOW_UP_TOUCH"), eq(t.outboundMessages.status, "PENDING_APPROVAL")),
    })
  );
  for (const row of rows) {
    if (row.followUpId) await reallySendFollowUp(session.organizationId, row.followUpId, row.requestedById);
    await withTenant(session.organizationId, (tx) =>
      tx
        .update(t.outboundMessages)
        .set({ status: "APPROVED_SENT", approvedById: session.userId, decidedAt: new Date() })
        .where(eq(t.outboundMessages.id, row.id))
    );
    await notify(row.requestedById, "✅ Follow-up touch approved & sent", `${session.name} bulk-approved the follow-up queue.`, "/approvals");
  }
  await audit(session.userId, "BULK_APPROVE_OUTBOUND", "OutboundMessage", undefined, {
    kind: "FOLLOW_UP_TOUCH",
    count: rows.length,
  });
  revalidatePath("/approvals");
}

/** Reject — reason required, notify requester, no effect executed. */
export async function rejectOutbound(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "approvals.manage")) {
    throw new Error("You do not have permission to reject outbound messages.");
  }
  const id = str(formData, "id");
  const reason = str(formData, "reason");
  if (!reason) throw new Error("A rejection reason is required.");

  const row = await withTenant(session.organizationId, async (tx) => {
    const row = await tx.query.outboundMessages.findFirst({ where: eq(t.outboundMessages.id, id) });
    if (!row) throw new Error("Outbound message not found");
    if (row.status !== "PENDING_APPROVAL") throw new Error("This message has already been decided.");
    await tx
      .update(t.outboundMessages)
      .set({ status: "REJECTED", approvedById: session.userId, decidedAt: new Date(), rejectReason: reason })
      .where(eq(t.outboundMessages.id, id));
    return row;
  });

  await notify(
    row.requestedById,
    `⛔ Rejected: ${KIND_LABEL[row.kind] ?? row.kind}`,
    `${session.name}: ${reason}`,
    "/approvals"
  );
  await audit(session.userId, "REJECT_OUTBOUND", "OutboundMessage", row.id, { kind: row.kind, reason });
  revalidatePath("/approvals");
}
