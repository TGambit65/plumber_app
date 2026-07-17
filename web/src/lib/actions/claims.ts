"use server";

/* INSURANCE/CLAIMS module server actions.
 * Claims are CORE and PII-sensitive: every mutation AND the export action is
 * audited via audit(). Policy numbers are NEVER written in full to the audit
 * detail — always masked to the last 4 characters. All DB access runs through
 * withTenant (RLS-enforced). */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { t, withTenant } from "@/db";
import { and, eq, isNull } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { audit, logActivity, notify } from "@/lib/actions/helpers";
import { money } from "@/lib/format";
import { CLAIM_NEXT, SUPPLEMENT_NEXT, maskPolicyNumber, type ClaimStatus } from "@/components/claims/meta";

// ── Internal helpers (not exported — "use server" files may only export async fns) ──

async function guard() {
  const session = await requireSession();
  if (!can(session.role, "claims.manage")) throw new Error("You do not have permission to manage claims.");
  return session;
}

function str(fd: FormData, key: string): string {
  return String(fd.get(key) ?? "").trim();
}

function dollarsToCents(fd: FormData, key: string): number | null {
  const raw = str(fd, key).replace(/[$,\s]/g, "");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function revalidateClaims(claimId?: string) {
  revalidatePath("/claims");
  if (claimId) {
    revalidatePath(`/claims/${claimId}`);
    revalidatePath(`/claims/${claimId}/export`);
  }
}

// ── Claims ───────────────────────────────────────────────────────────────────

export async function createClaim(formData: FormData) {
  const session = await guard();
  const claimNumber = str(formData, "claimNumber");
  const customerId = str(formData, "customerId");
  if (!claimNumber || !customerId) throw new Error("Claim number and customer are required.");
  const policyNumber = str(formData, "policyNumber") || null;
  const dateOfLossRaw = str(formData, "dateOfLoss");

  const [claim] = await withTenant(session.organizationId, (tx) =>
    tx
      .insert(t.claims)
      .values({
        claimNumber,
        status: "OPEN",
        customerId,
        propertyId: str(formData, "propertyId") || null,
        carrierId: str(formData, "carrierId") || null,
        adjusterId: str(formData, "adjusterId") || null,
        policyNumber,
        dateOfLoss: dateOfLossRaw ? new Date(dateOfLossRaw) : null,
        lossDescription: str(formData, "lossDescription") || null,
        deductibleCents: dollarsToCents(formData, "deductible"),
        createdById: session.userId,
      })
      .returning()
  );

  await audit(session.userId, "CLAIM_CREATE", "Claim", claim.id, {
    claimNumber,
    policyNumber: maskPolicyNumber(policyNumber), // PII: masked, never full
    deductibleCents: claim.deductibleCents,
  });
  await logActivity({
    kind: "SYSTEM",
    body: `Insurance claim ${claimNumber} opened${claim.deductibleCents != null ? ` — deductible ${money(claim.deductibleCents)}` : ""}`,
    userId: session.userId,
    customerId,
  });
  revalidateClaims(claim.id);
  redirect(`/claims/${claim.id}`);
}

export async function advanceClaimStatus(formData: FormData) {
  const session = await guard();
  const claimId = str(formData, "claimId");
  const to = str(formData, "to");

  const claim = await withTenant(session.organizationId, async (tx) => {
    const claim = await tx.query.claims.findFirst({ where: eq(t.claims.id, claimId) });
    if (!claim) throw new Error("Claim not found.");
    const allowed: string[] = CLAIM_NEXT[claim.status as ClaimStatus] ?? [];
    if (!allowed.includes(to)) throw new Error(`Cannot move claim from ${claim.status} to ${to}.`);
    await tx.update(t.claims).set({ status: to as ClaimStatus }).where(eq(t.claims.id, claimId));
    return claim;
  });

  await audit(session.userId, "CLAIM_STATUS", "Claim", claimId, {
    claimNumber: claim.claimNumber,
    from: claim.status,
    to,
  });
  await logActivity({
    kind: "STATUS",
    body: `Claim ${claim.claimNumber}: status ${claim.status} → ${to}`,
    userId: session.userId,
    customerId: claim.customerId,
  });
  revalidateClaims(claimId);
}

export async function updateClaimFacts(formData: FormData) {
  const session = await guard();
  const claimId = str(formData, "claimId");

  const { claim, changed } = await withTenant(session.organizationId, async (tx) => {
    const claim = await tx.query.claims.findFirst({ where: eq(t.claims.id, claimId) });
    if (!claim) throw new Error("Claim not found.");
    const dateOfLossRaw = str(formData, "dateOfLoss");
    const patch: Partial<typeof t.claims.$inferInsert> = {
      policyNumber: str(formData, "policyNumber") || null,
      dateOfLoss: dateOfLossRaw ? new Date(dateOfLossRaw) : null,
      lossDescription: str(formData, "lossDescription") || null,
      deductibleCents: dollarsToCents(formData, "deductible"),
      approvedAmountCents: dollarsToCents(formData, "approvedAmount"),
    };
    await tx.update(t.claims).set(patch).where(eq(t.claims.id, claimId));
    const changed: string[] = [];
    if ((patch.policyNumber ?? null) !== (claim.policyNumber ?? null)) changed.push("policyNumber");
    if ((patch.dateOfLoss?.getTime() ?? null) !== (claim.dateOfLoss ? new Date(claim.dateOfLoss).getTime() : null)) changed.push("dateOfLoss");
    if ((patch.lossDescription ?? null) !== (claim.lossDescription ?? null)) changed.push("lossDescription");
    if ((patch.deductibleCents ?? null) !== (claim.deductibleCents ?? null)) changed.push("deductibleCents");
    if ((patch.approvedAmountCents ?? null) !== (claim.approvedAmountCents ?? null)) changed.push("approvedAmountCents");
    return { claim, changed };
  });

  // PII rule: audit records WHICH fields changed + masked policy #, never the
  // full policy number or loss narrative.
  await audit(session.userId, "CLAIM_UPDATE", "Claim", claimId, {
    claimNumber: claim.claimNumber,
    changedFields: changed,
    policyNumber: maskPolicyNumber(str(formData, "policyNumber") || null),
  });
  if (changed.includes("approvedAmountCents")) {
    await logActivity({
      kind: "SYSTEM",
      body: `Claim ${claim.claimNumber}: approved amount set to ${money(dollarsToCents(formData, "approvedAmount"))}`,
      userId: session.userId,
      customerId: claim.customerId,
    });
  }
  revalidateClaims(claimId);
}

// ── Job linkage ──────────────────────────────────────────────────────────────

export async function linkJobToClaim(formData: FormData) {
  const session = await guard();
  const claimId = str(formData, "claimId");
  const jobId = str(formData, "jobId");
  if (!jobId) throw new Error("Choose a job to link.");

  const { claim, job } = await withTenant(session.organizationId, async (tx) => {
    const claim = await tx.query.claims.findFirst({ where: eq(t.claims.id, claimId) });
    if (!claim) throw new Error("Claim not found.");
    const job = await tx.query.jobs.findFirst({ where: and(eq(t.jobs.id, jobId), isNull(t.jobs.claimId)) });
    if (!job) throw new Error("Job not found or already linked to a claim.");
    await tx.update(t.jobs).set({ claimId }).where(eq(t.jobs.id, jobId));
    return { claim, job };
  });

  await audit(session.userId, "CLAIM_LINK_JOB", "Claim", claimId, {
    claimNumber: claim.claimNumber,
    jobNumber: job.number,
  });
  await logActivity({
    kind: "SYSTEM",
    body: `Claim ${claim.claimNumber}: job ${job.number} linked (${job.jobType})`,
    userId: session.userId,
    customerId: claim.customerId,
    jobId: job.id,
  });
  revalidateClaims(claimId);
}

export async function unlinkJobFromClaim(formData: FormData) {
  const session = await guard();
  const claimId = str(formData, "claimId");
  const jobId = str(formData, "jobId");

  const { claim, job } = await withTenant(session.organizationId, async (tx) => {
    const claim = await tx.query.claims.findFirst({ where: eq(t.claims.id, claimId) });
    if (!claim) throw new Error("Claim not found.");
    const job = await tx.query.jobs.findFirst({ where: and(eq(t.jobs.id, jobId), eq(t.jobs.claimId, claimId)) });
    if (!job) throw new Error("Job is not linked to this claim.");
    await tx.update(t.jobs).set({ claimId: null }).where(eq(t.jobs.id, jobId));
    return { claim, job };
  });

  await audit(session.userId, "CLAIM_UNLINK_JOB", "Claim", claimId, {
    claimNumber: claim.claimNumber,
    jobNumber: job.number,
  });
  await logActivity({
    kind: "SYSTEM",
    body: `Claim ${claim.claimNumber}: job ${job.number} unlinked`,
    userId: session.userId,
    customerId: claim.customerId,
    jobId: job.id,
  });
  revalidateClaims(claimId);
}

// ── Supplements ──────────────────────────────────────────────────────────────

export async function createSupplement(formData: FormData) {
  const session = await guard();
  const claimId = str(formData, "claimId");
  const description = str(formData, "description");
  const amountCents = dollarsToCents(formData, "amount");
  if (!description || amountCents == null) throw new Error("Description and amount are required.");

  const { claim, supplement } = await withTenant(session.organizationId, async (tx) => {
    const claim = await tx.query.claims.findFirst({ where: eq(t.claims.id, claimId) });
    if (!claim) throw new Error("Claim not found.");
    // Per-claim SUP-XX sequence.
    const existing = await tx
      .select({ n: t.claimSupplements.number })
      .from(t.claimSupplements)
      .where(eq(t.claimSupplements.claimId, claimId));
    let max = 0;
    for (const r of existing) {
      const m = /(\d+)$/.exec(r.n);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    const number = `SUP-${String(max + 1).padStart(2, "0")}`;
    const [supplement] = await tx
      .insert(t.claimSupplements)
      .values({ claimId, number, description, amountCents, status: "DRAFT" })
      .returning();
    return { claim, supplement };
  });

  await audit(session.userId, "SUPPLEMENT_CREATE", "ClaimSupplement", supplement.id, {
    claimNumber: claim.claimNumber,
    number: supplement.number,
    amountCents,
  });
  await logActivity({
    kind: "SYSTEM",
    body: `Claim ${claim.claimNumber}: supplement ${supplement.number} drafted — ${money(amountCents)} (${description})`,
    userId: session.userId,
    customerId: claim.customerId,
  });
  revalidateClaims(claimId);
}

export async function advanceSupplement(formData: FormData) {
  const session = await guard();
  const supplementId = str(formData, "supplementId");
  const to = str(formData, "to");

  const { claim, supplement } = await withTenant(session.organizationId, async (tx) => {
    const supplement = await tx.query.claimSupplements.findFirst({
      where: eq(t.claimSupplements.id, supplementId),
      with: { claim: true },
    });
    if (!supplement) throw new Error("Supplement not found.");
    const allowed = SUPPLEMENT_NEXT[supplement.status] ?? [];
    if (!allowed.includes(to)) throw new Error(`Cannot move supplement from ${supplement.status} to ${to}.`);
    const now = new Date();
    const patch: Partial<typeof t.claimSupplements.$inferInsert> = {
      status: to as typeof supplement.status,
    };
    if (to === "SUBMITTED") patch.submittedAt = now;
    if (to === "APPROVED" || to === "DENIED") patch.decidedAt = now;
    await tx.update(t.claimSupplements).set(patch).where(eq(t.claimSupplements.id, supplementId));
    return { claim: supplement.claim, supplement };
  });

  await audit(session.userId, "SUPPLEMENT_STATUS", "ClaimSupplement", supplementId, {
    claimNumber: claim.claimNumber,
    number: supplement.number,
    from: supplement.status,
    to,
  });
  await logActivity({
    kind: "STATUS",
    body: `Claim ${claim.claimNumber}: supplement ${supplement.number} ${supplement.status} → ${to} (${money(supplement.amountCents)})`,
    userId: session.userId,
    customerId: claim.customerId,
  });
  // Decision → notify the claim creator.
  if ((to === "APPROVED" || to === "DENIED") && claim.createdById && claim.createdById !== session.userId) {
    await notify(
      claim.createdById,
      `Supplement ${supplement.number} ${to === "APPROVED" ? "approved ✅" : "denied ❌"}`,
      `Claim ${claim.claimNumber} — ${money(supplement.amountCents)}: ${supplement.description}`,
      `/claims/${claim.id}`
    );
  }
  revalidateClaims(claim.id);
}

// ── Carriers & adjusters ─────────────────────────────────────────────────────

export async function createCarrier(formData: FormData) {
  const session = await guard();
  const name = str(formData, "name");
  if (!name) throw new Error("Carrier name is required.");

  const [carrier] = await withTenant(session.organizationId, (tx) =>
    tx
      .insert(t.carriers)
      .values({
        name,
        phone: str(formData, "phone") || null,
        email: str(formData, "email") || null,
        claimsPortalUrl: str(formData, "claimsPortalUrl") || null,
      })
      .returning()
  );

  await audit(session.userId, "CARRIER_CREATE", "Carrier", carrier.id, { name });
  revalidateClaims();
}

export async function createAdjuster(formData: FormData) {
  const session = await guard();
  const carrierId = str(formData, "carrierId");
  const name = str(formData, "name");
  if (!carrierId || !name) throw new Error("Carrier and adjuster name are required.");

  const { adjuster, carrier } = await withTenant(session.organizationId, async (tx) => {
    const carrier = await tx.query.carriers.findFirst({ where: eq(t.carriers.id, carrierId) });
    if (!carrier) throw new Error("Carrier not found.");
    const [adjuster] = await tx
      .insert(t.adjusters)
      .values({
        carrierId,
        name,
        phone: str(formData, "phone") || null,
        email: str(formData, "email") || null,
        notes: str(formData, "notes") || null,
      })
      .returning();
    return { adjuster, carrier };
  });

  await audit(session.userId, "ADJUSTER_CREATE", "Adjuster", adjuster.id, {
    name,
    carrier: carrier.name,
  });
  revalidateClaims();
}

// ── Carrier-format export ────────────────────────────────────────────────────

/** Generates the carrier package (rendered live on /claims/[id]/export),
 *  audits the export (PII leaves the system here) and drops a timeline entry. */
export async function exportClaimPackage(formData: FormData) {
  const session = await guard();
  const claimId = str(formData, "claimId");

  const summary = await withTenant(session.organizationId, async (tx) => {
    const claim = await tx.query.claims.findFirst({
      where: eq(t.claims.id, claimId),
      with: {
        supplements: true,
        jobs: { with: { photos: true } },
        estimates: { with: { options: { with: { items: true } } } },
      },
    });
    if (!claim) throw new Error("Claim not found.");
    const photoCount = claim.jobs.reduce((s, j) => s + j.photos.length, 0);
    const lineItemCount = claim.estimates
      .filter((e) => e.status === "APPROVED")
      .reduce((s, e) => {
        const selected = e.options.filter((o) => o.selected);
        const opts = selected.length > 0 ? selected : e.options;
        return s + opts.reduce((x, o) => x + o.items.length, 0);
      }, 0);
    return {
      claimNumber: claim.claimNumber,
      customerId: claim.customerId,
      policyNumber: claim.policyNumber,
      photoCount,
      lineItemCount,
      supplementCount: claim.supplements.length,
    };
  });

  // The export itself is the sensitive event — audit it even though it's a read.
  await audit(session.userId, "CLAIM_EXPORT", "Claim", claimId, {
    claimNumber: summary.claimNumber,
    policyNumber: maskPolicyNumber(summary.policyNumber), // PII: masked
    photos: summary.photoCount,
    lineItems: summary.lineItemCount,
    supplements: summary.supplementCount,
  });
  await logActivity({
    kind: "SYSTEM",
    body: `Claim ${summary.claimNumber}: carrier package exported (${summary.lineItemCount} line items, ${summary.photoCount} photos, ${summary.supplementCount} supplements)`,
    userId: session.userId,
    customerId: summary.customerId,
  });
  redirect(`/claims/${claimId}/export`);
}
