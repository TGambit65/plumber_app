/* Carrier-format claim package builder — plain text, monospace-friendly.
 * Shared by the export server action (for counts/summary) and the
 * /claims/[id]/export page (renders the live package). */
import { fmtDate, fmtDateTime, money } from "@/lib/format";

export type ClaimPackageInput = {
  organizationName: string;
  preparedBy: string;
  claim: {
    claimNumber: string;
    status: string;
    policyNumber: string | null;
    dateOfLoss: Date | null;
    lossDescription: string | null;
    deductibleCents: number | null;
    approvedAmountCents: number | null;
    createdAt: Date;
  };
  customer: { name: string; company: string | null; phone: string | null; email: string | null };
  property: { address: string; city: string; state: string; zip: string } | null;
  carrier: { name: string; phone: string | null; email: string | null; claimsPortalUrl: string | null } | null;
  adjuster: { name: string; phone: string | null; email: string | null } | null;
  jobs: {
    number: string;
    jobType: string;
    status: string;
    completedAt: Date | null;
    photos: { kind: string; caption: string | null; takenAt: Date; takenByName: string; url: string }[];
  }[];
  estimates: {
    number: string;
    status: string;
    options: {
      name: string;
      tier: string;
      selected: boolean;
      items: { code: string | null; description: string; qty: number; unitPriceCents: number }[];
    }[];
  }[];
  supplements: {
    number: string;
    description: string;
    amountCents: number;
    status: string;
    submittedAt: Date | null;
    decidedAt: Date | null;
  }[];
};

const W = 76;
const RULE = "=".repeat(W);
const THIN = "-".repeat(W);

function section(title: string): string {
  return `\n${title}\n${THIN}`;
}

function kv(label: string, value: string | null | undefined): string {
  return `  ${(label + ":").padEnd(18)}${value && value.trim() ? value : "—"}`;
}

/** Line items to include: selected options of APPROVED estimates
 *  (falls back to all options if none is marked selected). */
export function approvedLineItems(input: ClaimPackageInput) {
  const rows: { estimateNumber: string; optionName: string; code: string | null; description: string; qty: number; unitPriceCents: number }[] = [];
  for (const est of input.estimates) {
    if (est.status !== "APPROVED") continue;
    const selected = est.options.filter((o) => o.selected);
    const options = selected.length > 0 ? selected : est.options;
    for (const opt of options) {
      for (const item of opt.items) {
        rows.push({
          estimateNumber: est.number,
          optionName: opt.name,
          code: item.code,
          description: item.description,
          qty: item.qty,
          unitPriceCents: item.unitPriceCents,
        });
      }
    }
  }
  return rows;
}

export function countPhotos(input: ClaimPackageInput): number {
  return input.jobs.reduce((s, j) => s + j.photos.length, 0);
}

export function buildClaimPackage(input: ClaimPackageInput): string {
  const { claim, customer, property, carrier, adjuster } = input;
  const lines: string[] = [];

  lines.push(RULE);
  lines.push("  CARRIER CLAIM PACKAGE");
  lines.push(`  Claim ${claim.claimNumber} · Status: ${claim.status}`);
  lines.push(`  Prepared by ${input.organizationName} (${input.preparedBy})`);
  lines.push(`  Generated ${fmtDateTime(new Date())}`);
  lines.push(RULE);

  lines.push(section("1. INSURED"));
  lines.push(kv("Name", customer.name + (customer.company ? ` (${customer.company})` : "")));
  lines.push(kv("Phone", customer.phone));
  lines.push(kv("Email", customer.email));
  lines.push(
    kv(
      "Loss location",
      property ? `${property.address}, ${property.city}, ${property.state} ${property.zip}` : null
    )
  );

  lines.push(section("2. CARRIER / ADJUSTER"));
  lines.push(kv("Carrier", carrier?.name ?? null));
  lines.push(kv("Carrier phone", carrier?.phone ?? null));
  lines.push(kv("Carrier email", carrier?.email ?? null));
  lines.push(kv("Claims portal", carrier?.claimsPortalUrl ?? null));
  lines.push(kv("Adjuster", adjuster?.name ?? null));
  lines.push(kv("Adjuster phone", adjuster?.phone ?? null));
  lines.push(kv("Adjuster email", adjuster?.email ?? null));

  lines.push(section("3. LOSS DETAILS"));
  lines.push(kv("Claim number", claim.claimNumber));
  lines.push(kv("Policy number", claim.policyNumber));
  lines.push(kv("Date of loss", claim.dateOfLoss ? fmtDate(claim.dateOfLoss) : null));
  lines.push(kv("Claim opened", fmtDate(claim.createdAt)));
  lines.push(kv("Deductible", claim.deductibleCents != null ? money(claim.deductibleCents) : null));
  lines.push(kv("Approved amount", claim.approvedAmountCents != null ? money(claim.approvedAmountCents) : null));
  lines.push("  Loss description:");
  if (claim.lossDescription) {
    for (const l of claim.lossDescription.split("\n")) lines.push(`    ${l}`);
  } else {
    lines.push("    —");
  }

  lines.push(section("4. SCOPE OF WORK — LINE ITEMS (approved estimate options)"));
  const items = approvedLineItems(input);
  if (items.length === 0) {
    lines.push("  No APPROVED estimate is linked to this claim yet.");
    const pending = input.estimates.filter((e) => e.status !== "APPROVED");
    for (const e of pending) lines.push(`  (Estimate ${e.number} linked — status ${e.status}, excluded from scope)`);
  } else {
    lines.push(
      `  ${"CODE".padEnd(14)}${"QTY".padStart(6)}  ${"UNIT".padStart(11)}  ${"TOTAL".padStart(11)}  DESCRIPTION`
    );
    let subtotal = 0;
    for (const it of items) {
      const total = Math.round(it.qty * it.unitPriceCents);
      subtotal += total;
      lines.push(
        `  ${(it.code ?? "—").padEnd(14)}${String(it.qty).padStart(6)}  ${money(it.unitPriceCents).padStart(11)}  ${money(total).padStart(11)}  ${it.description}`
      );
    }
    lines.push(`  ${" ".repeat(14 + 6 + 2 + 11)}  ${"-".repeat(11)}`);
    lines.push(`  ${"SCOPE SUBTOTAL".padEnd(14 + 6 + 2 + 11)}  ${money(subtotal).padStart(11)}`);
  }

  lines.push(section("5. SUPPLEMENTS"));
  if (input.supplements.length === 0) {
    lines.push("  None filed.");
  } else {
    for (const s of input.supplements) {
      lines.push(`  ${s.number.padEnd(8)}${s.status.padEnd(11)}${money(s.amountCents).padStart(11)}  ${s.description}`);
      const dates: string[] = [];
      if (s.submittedAt) dates.push(`submitted ${fmtDate(s.submittedAt)}`);
      if (s.decidedAt) dates.push(`decided ${fmtDate(s.decidedAt)}`);
      if (dates.length) lines.push(`  ${" ".repeat(8)}${dates.join(" · ")}`);
    }
    const approved = input.supplements.filter((s) => s.status === "APPROVED").reduce((x, s) => x + s.amountCents, 0);
    const pending = input.supplements.filter((s) => s.status === "DRAFT" || s.status === "SUBMITTED").reduce((x, s) => x + s.amountCents, 0);
    lines.push(`  Approved supplement total: ${money(approved)} · Pending: ${money(pending)}`);
  }

  lines.push(section("6. WORK PERFORMED (linked jobs)"));
  if (input.jobs.length === 0) {
    lines.push("  No jobs linked to this claim.");
  } else {
    for (const j of input.jobs) {
      lines.push(
        `  ${j.number.padEnd(10)}${j.status.padEnd(14)}${j.jobType}${j.completedAt ? ` — completed ${fmtDate(j.completedAt)}` : ""}`
      );
    }
  }

  const photoCount = countPhotos(input);
  lines.push(section(`7. PHOTO MANIFEST (${photoCount} photo${photoCount === 1 ? "" : "s"})`));
  if (photoCount === 0) {
    lines.push("  No photo documentation on linked jobs.");
  } else {
    const all = input.jobs
      .flatMap((j) => j.photos.map((p) => ({ ...p, jobNumber: j.number })))
      .sort((a, b) => new Date(a.takenAt).getTime() - new Date(b.takenAt).getTime());
    for (const p of all) {
      lines.push(
        `  [${p.kind.padEnd(7)}] ${fmtDateTime(p.takenAt).padEnd(22)} ${p.jobNumber.padEnd(9)} ${p.caption ?? "(no caption)"}`
      );
      lines.push(`  ${" ".repeat(10)}by ${p.takenByName} · file: ${p.url}`);
    }
  }

  lines.push("");
  lines.push(RULE);
  lines.push("  END OF PACKAGE — this export is logged in the audit trail.");
  lines.push(RULE);

  return lines.join("\n");
}
