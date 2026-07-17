"use server";

/**
 * Compliance / inspection engine actions (CORE capability — constraint 4).
 * Trade packs specialize the engine via templates (tradePackKey); inspections
 * and certifications are real rows, all tenant-scoped through withTenant.
 */

import { t, withTenant, type TenantDb } from "@/db";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { audit, logActivity, notify } from "./helpers";
import { and, asc, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  requiredBlockers,
  STEP_KINDS,
  type InspectionResults,
  type InspectionStep,
  type StepKind,
  type StepResult,
} from "@/components/compliance/types";

// ── Internal helpers (not exported — "use server" files export async fns only) ──

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function optStr(formData: FormData, key: string): string | null {
  const v = str(formData, key);
  return v === "" ? null : v;
}

function optDate(formData: FormData, key: string): Date | null {
  const v = str(formData, key);
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Parse the steps textarea. One step per line:
 *   kind|label|required?|unit?
 * kind ∈ check|measurement|photo|note; 3rd field "required" (or yes/true/req)
 * marks the step required, anything else (or blank) = optional; 4th field is
 * the unit for measurement steps. Blank lines and lines starting with # are
 * ignored.
 */
function parseSteps(raw: string): InspectionStep[] {
  const steps: InspectionStep[] = [];
  const lines = raw.split(/\r?\n/);
  let n = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    n++;
    const parts = trimmed.split("|").map((p) => p.trim());
    const kind = (parts[0] ?? "").toLowerCase() as StepKind;
    const label = parts[1] ?? "";
    if (!STEP_KINDS.includes(kind))
      throw new Error(`Step line ${n}: unknown kind "${parts[0]}" — use check|measurement|photo|note`);
    if (!label) throw new Error(`Step line ${n}: label is required (format: kind|label|required?|unit?)`);
    const required = /^(required|req|yes|true|1)$/i.test(parts[2] ?? "");
    const unit = (parts[3] ?? "").trim() || undefined;
    const slug =
      label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 24) || "step";
    steps.push({ key: `${slug}_${n}`, label, kind, required, ...(unit ? { unit } : {}) });
  }
  return steps;
}

async function adminIds(tx: TenantDb): Promise<string[]> {
  const rows = await tx
    .select({ id: t.users.id })
    .from(t.users)
    .where(and(eq(t.users.role, "ADMIN"), eq(t.users.active, true)));
  return rows.map((r) => r.id);
}

async function complianceManagerIds(tx: TenantDb): Promise<string[]> {
  const rows = await tx
    .select({ id: t.users.id })
    .from(t.users)
    .where(and(inArray(t.users.role, ["OFFICE", "ADMIN"]), eq(t.users.active, true)));
  return rows.map((r) => r.id);
}

// ── Templates ────────────────────────────────────────────────────────────────

export async function createTemplate(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "compliance.manage")) throw new Error("Not allowed");

  const name = str(formData, "name");
  if (!name) throw new Error("Template name is required");
  const tradePackKey = optStr(formData, "tradePackKey");
  const description = optStr(formData, "description");
  const issuesCertification = optStr(formData, "issuesCertification");
  const validityRaw = str(formData, "certValidityDays");
  const certValidityDays = validityRaw ? Math.max(1, Math.floor(Number(validityRaw))) : null;
  if (validityRaw && !Number.isFinite(certValidityDays!)) throw new Error("Cert validity must be a number of days");

  const steps = parseSteps(str(formData, "steps"));
  if (steps.length < 1) throw new Error("A template needs at least one step");

  const template = await withTenant(session.organizationId, async (tx) => {
    // Compose only ENABLED packs (constraint 1): a template may only claim a
    // tradePackKey the org actually has enabled.
    if (tradePackKey) {
      const enabled = await tx
        .select({ key: t.tradePacks.key })
        .from(t.organizationTradePacks)
        .innerJoin(t.tradePacks, eq(t.organizationTradePacks.tradePackId, t.tradePacks.id))
        .where(eq(t.organizationTradePacks.organizationId, session.organizationId));
      if (!enabled.some((p) => p.key === tradePackKey))
        throw new Error(`Trade pack "${tradePackKey}" is not enabled for this organization`);
    }
    const [row] = await tx
      .insert(t.inspectionTemplates)
      .values({
        name,
        tradePackKey,
        description,
        steps,
        issuesCertification,
        certValidityDays: issuesCertification ? certValidityDays : null,
      })
      .returning();
    return row;
  });

  await audit(session.userId, "CREATE_INSPECTION_TEMPLATE", "InspectionTemplate", template.id, {
    name,
    tradePackKey,
    stepCount: steps.length,
    issuesCertification,
  });
  revalidatePath("/compliance");
}

// ── Inspections ──────────────────────────────────────────────────────────────

export async function scheduleInspection(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "compliance.manage")) throw new Error("Not allowed");

  const templateId = str(formData, "templateId");
  const inspectorId = str(formData, "inspectorId");
  const scheduledAt = optDate(formData, "scheduledAt");
  if (!templateId) throw new Error("Template is required");
  if (!inspectorId) throw new Error("Inspector is required");
  if (!scheduledAt) throw new Error("A valid scheduled date/time is required");

  const { inspection, template } = await withTenant(session.organizationId, async (tx) => {
    const template = await tx.query.inspectionTemplates.findFirst({
      where: eq(t.inspectionTemplates.id, templateId),
    });
    if (!template) throw new Error("Template not found");
    const [inspection] = await tx
      .insert(t.inspections)
      .values({
        templateId,
        status: "SCHEDULED",
        jobId: optStr(formData, "jobId"),
        propertyId: optStr(formData, "propertyId"),
        equipmentId: optStr(formData, "equipmentId"),
        inspectorId,
        scheduledAt,
      })
      .returning();
    return { inspection, template };
  });

  if (inspectorId !== session.userId) {
    await notify(
      inspectorId,
      "Inspection assigned to you",
      `${template.name} — scheduled ${scheduledAt.toLocaleString("en-US")}`,
      `/compliance/inspections/${inspection.id}`
    );
  }
  await audit(session.userId, "SCHEDULE_INSPECTION", "Inspection", inspection.id, {
    template: template.name,
    inspectorId,
    scheduledAt: scheduledAt.toISOString(),
  });
  revalidatePath("/compliance");
}

export async function saveInspectionStep(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "inspections.run")) throw new Error("Not allowed");

  const inspectionId = str(formData, "inspectionId");
  const stepKey = str(formData, "stepKey");
  if (!inspectionId || !stepKey) throw new Error("Missing inspection or step");

  await withTenant(session.organizationId, async (tx) => {
    const inspection = await tx.query.inspections.findFirst({
      where: eq(t.inspections.id, inspectionId),
      with: { template: true },
    });
    if (!inspection) throw new Error("Inspection not found");
    if (inspection.status !== "SCHEDULED" && inspection.status !== "IN_PROGRESS")
      throw new Error(`Inspection is ${inspection.status} — steps are locked`);

    const steps = (inspection.template.steps as InspectionStep[]) ?? [];
    const step = steps.find((s) => s.key === stepKey);
    if (!step) throw new Error("Unknown step for this template");

    const results: InspectionResults = { ...((inspection.results as InspectionResults) ?? {}) };
    const entry: StepResult = { ...(results[stepKey] ?? {}) };

    const passRaw = formData.get("pass");
    if (passRaw !== null) entry.pass = String(passRaw) === "true";
    const valueRaw = formData.get("value");
    if (valueRaw !== null) {
      const v = String(valueRaw).trim();
      if (step.kind === "measurement") {
        const num = Number(v);
        if (v === "" || !Number.isFinite(num)) throw new Error("Enter a numeric measurement");
        entry.value = num;
      } else {
        entry.value = v;
      }
    }
    const noteRaw = formData.get("note");
    if (noteRaw !== null) entry.note = String(noteRaw).trim();

    results[stepKey] = entry;
    await tx
      .update(t.inspections)
      .set({
        results,
        // First saved step moves SCHEDULED → IN_PROGRESS.
        ...(inspection.status === "SCHEDULED" ? { status: "IN_PROGRESS" as const } : {}),
      })
      .where(eq(t.inspections.id, inspectionId));
  });

  revalidatePath(`/compliance/inspections/${inspectionId}`);
  revalidatePath("/compliance");
}

export async function completeInspection(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "inspections.run")) throw new Error("Not allowed");

  const inspectionId = str(formData, "inspectionId");
  const outcome = str(formData, "outcome");
  if (outcome !== "PASSED" && outcome !== "FAILED") throw new Error("Invalid outcome");
  const failureNote = str(formData, "note");
  if (outcome === "FAILED" && !failureNote) throw new Error("A failure reason note is required");

  const now = new Date();

  const done = await withTenant(session.organizationId, async (tx) => {
    const inspection = await tx.query.inspections.findFirst({
      where: eq(t.inspections.id, inspectionId),
      with: { template: true, job: true },
    });
    if (!inspection) throw new Error("Inspection not found");
    if (inspection.status !== "SCHEDULED" && inspection.status !== "IN_PROGRESS")
      throw new Error(`Inspection already ${inspection.status}`);

    const steps = (inspection.template.steps as InspectionStep[]) ?? [];
    const results = ((inspection.results as InspectionResults) ?? {}) as InspectionResults;

    if (outcome === "PASSED") {
      // Server-side re-validation: every required step answered, none failed.
      const { unanswered, failed } = requiredBlockers(steps, results);
      if (failed.length > 0)
        throw new Error(`Cannot mark PASSED — required step failed: ${failed.map((s) => s.label).join(", ")}`);
      if (unanswered.length > 0)
        throw new Error(`Cannot mark PASSED — required steps unanswered: ${unanswered.map((s) => s.label).join(", ")}`);
    }

    await tx
      .update(t.inspections)
      .set({
        status: outcome,
        completedAt: now,
        ...(outcome === "FAILED"
          ? { notes: [inspection.notes, `FAILED: ${failureNote}`].filter(Boolean).join("\n") }
          : {}),
      })
      .where(eq(t.inspections.id, inspectionId));

    // Passing an inspection can auto-issue a certification (real data).
    let certificationId: string | null = null;
    if (outcome === "PASSED" && inspection.template.issuesCertification) {
      const validityDays = inspection.template.certValidityDays;
      const [cert] = await tx
        .insert(t.certifications)
        .values({
          name: inspection.template.issuesCertification,
          holderType: inspection.equipmentId ? "EQUIPMENT" : "ORGANIZATION",
          equipmentId: inspection.equipmentId,
          issuedAt: now,
          expiresAt: validityDays ? new Date(now.getTime() + validityDays * DAY_MS) : null,
          sourceInspectionId: inspection.id,
          notes: `Auto-issued on passing "${inspection.template.name}"`,
        })
        .returning();
      certificationId = cert.id;
    }

    const admins = await adminIds(tx);
    const managers = await complianceManagerIds(tx);
    return { inspection, certificationId, admins, managers };
  });

  const { inspection, certificationId, admins, managers } = done;
  const templateName = inspection.template.name;
  const href = `/compliance/inspections/${inspectionId}`;

  if (outcome === "PASSED" && certificationId) {
    const recipients = new Set<string>(admins);
    if (inspection.inspectorId) recipients.add(inspection.inspectorId);
    for (const uid of Array.from(recipients)) {
      await notify(
        uid,
        `Certification issued: ${inspection.template.issuesCertification}`,
        `Auto-issued after "${templateName}" passed.`,
        href
      );
    }
  }
  if (outcome === "FAILED") {
    for (const uid of managers.filter((id) => id !== session.userId)) {
      await notify(uid, `Inspection FAILED: ${templateName}`, `Reason: ${failureNote}`, href);
    }
  }
  if (inspection.jobId) {
    await logActivity({
      kind: "SYSTEM",
      body: `Inspection "${templateName}" ${outcome} (${session.name})${outcome === "FAILED" ? ` — ${failureNote}` : ""}${certificationId ? ` · certification issued` : ""}`,
      userId: session.userId,
      jobId: inspection.jobId,
    });
  }
  await audit(session.userId, "COMPLETE_INSPECTION", "Inspection", inspectionId, {
    outcome,
    template: templateName,
    ...(outcome === "FAILED" ? { reason: failureNote } : {}),
    ...(certificationId ? { certificationId } : {}),
  });

  revalidatePath(`/compliance/inspections/${inspectionId}`);
  revalidatePath("/compliance");
}

export async function cancelInspection(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "compliance.manage")) throw new Error("Not allowed");

  const inspectionId = str(formData, "inspectionId");
  const inspection = await withTenant(session.organizationId, async (tx) => {
    const row = await tx.query.inspections.findFirst({
      where: eq(t.inspections.id, inspectionId),
      with: { template: true },
    });
    if (!row) throw new Error("Inspection not found");
    if (row.status !== "SCHEDULED" && row.status !== "IN_PROGRESS")
      throw new Error(`Cannot cancel a ${row.status} inspection`);
    await tx.update(t.inspections).set({ status: "CANCELLED" }).where(eq(t.inspections.id, inspectionId));
    return row;
  });

  if (inspection.inspectorId && inspection.inspectorId !== session.userId) {
    await notify(
      inspection.inspectorId,
      "Inspection cancelled",
      `${inspection.template.name} was cancelled by ${session.name}.`,
      "/compliance"
    );
  }
  await audit(session.userId, "CANCEL_INSPECTION", "Inspection", inspectionId, {
    template: inspection.template.name,
  });
  revalidatePath("/compliance");
  revalidatePath(`/compliance/inspections/${inspectionId}`);
}

// ── Certifications ───────────────────────────────────────────────────────────

export async function addCertification(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "compliance.manage")) throw new Error("Not allowed");

  const name = str(formData, "name");
  if (!name) throw new Error("Certification name is required");
  const holderType = str(formData, "holderType");
  if (holderType !== "USER" && holderType !== "ORGANIZATION") throw new Error("Invalid holder type");
  const userId = holderType === "USER" ? optStr(formData, "userId") : null;
  if (holderType === "USER" && !userId) throw new Error("Pick the user who holds this certification");

  const [cert] = await withTenant(session.organizationId, (tx) =>
    tx
      .insert(t.certifications)
      .values({
        name,
        holderType,
        userId,
        certificateNumber: optStr(formData, "certificateNumber"),
        issuingAuthority: optStr(formData, "issuingAuthority"),
        issuedAt: optDate(formData, "issuedAt"),
        expiresAt: optDate(formData, "expiresAt"),
      })
      .returning()
  );

  await audit(session.userId, "ADD_CERTIFICATION", "Certification", cert.id, { name, holderType, userId });
  revalidatePath("/compliance");
}

/**
 * Renewal sweep: every certification expiring within 60 days (or already
 * expired) gets its holder (USER certs) and every ADMIN notified — once per
 * cert, skipping certs already notified within the last 14 days. Counts are
 * surfaced back on /compliance via query params.
 */
export async function runRenewalSweep() {
  const session = await requireSession();
  if (!can(session.role, "compliance.manage")) throw new Error("Not allowed");

  const now = new Date();
  const horizon = new Date(now.getTime() + 60 * DAY_MS);
  const recent = new Date(now.getTime() - 14 * DAY_MS);

  const { toNotify, skipped, admins } = await withTenant(session.organizationId, async (tx) => {
    const certs = await tx.query.certifications.findMany({
      with: { user: true, equipmentRef: true },
      orderBy: [asc(t.certifications.expiresAt)],
    });
    const due = certs.filter((c) => c.expiresAt !== null && c.expiresAt <= horizon);
    const toNotify = due.filter((c) => !c.renewalNotifiedAt || c.renewalNotifiedAt < recent);
    const skipped = due.length - toNotify.length;
    if (toNotify.length > 0) {
      await tx
        .update(t.certifications)
        .set({ renewalNotifiedAt: now })
        .where(
          inArray(
            t.certifications.id,
            toNotify.map((c) => c.id)
          )
        );
    }
    const admins = await adminIds(tx);
    return { toNotify, skipped, admins };
  });

  let notifications = 0;
  for (const cert of toNotify) {
    const expired = cert.expiresAt! <= now;
    const days = Math.ceil(Math.abs(cert.expiresAt!.getTime() - now.getTime()) / DAY_MS);
    const title = expired
      ? `Certification EXPIRED: ${cert.name}`
      : `Certification expires in ${days} day${days === 1 ? "" : "s"}: ${cert.name}`;
    const holder =
      cert.holderType === "USER"
        ? cert.user?.name ?? "Unassigned user"
        : cert.holderType === "EQUIPMENT"
          ? cert.equipmentRef
            ? `${cert.equipmentRef.kind}${cert.equipmentRef.brand ? ` (${cert.equipmentRef.brand})` : ""}`
            : "Equipment"
          : "Organization";
    const body = `Holder: ${holder}${cert.certificateNumber ? ` · #${cert.certificateNumber}` : ""} — renew before ${cert.expiresAt!.toLocaleDateString("en-US")}.`;
    const recipients = new Set<string>(admins);
    if (cert.holderType === "USER" && cert.userId) recipients.add(cert.userId);
    for (const uid of Array.from(recipients)) {
      await notify(uid, title, body, "/compliance");
      notifications++;
    }
  }

  await audit(session.userId, "RUN_RENEWAL_SWEEP", "Certification", undefined, {
    certsNotified: toNotify.length,
    certsSkippedRecentlyNotified: skipped,
    notificationsSent: notifications,
  });

  revalidatePath("/compliance");
  redirect(`/compliance?swept=1&notified=${toNotify.length}&skipped=${skipped}`);
}
