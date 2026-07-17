import Link from "next/link";
import { notFound } from "next/navigation";
import { db, t, withTenant } from "@/db";
import { eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { Card } from "@/components/ui";
import { Forbidden } from "@/components/sales/meta";
import { buildClaimPackage, countPhotos, type ClaimPackageInput } from "@/components/claims/package";

export const dynamic = "force-dynamic";

export default async function ClaimExportPage({ params }: { params: { id: string } }) {
  const session = await requireSession();
  if (!can(session.role, "claims.manage")) return <Forbidden />;

  const claim = await withTenant(session.organizationId, (tx) =>
    tx.query.claims.findFirst({
      where: eq(t.claims.id, params.id),
      with: {
        customer: true,
        property: true,
        carrier: true,
        adjuster: true,
        supplements: true,
        jobs: { with: { photos: { with: { takenBy: true } } } },
        estimates: { with: { options: { with: { items: { with: { priceBookItem: true } } } } } },
      },
    })
  );
  if (!claim) notFound();

  // organizations is a global table (not org-scoped) — read on the base client.
  const org = await db.query.organizations.findFirst({
    where: eq(t.organizations.id, session.organizationId),
  });

  const input: ClaimPackageInput = {
    organizationName: org?.name ?? "Trade-Ops",
    preparedBy: session.name,
    claim: {
      claimNumber: claim.claimNumber,
      status: claim.status,
      policyNumber: claim.policyNumber,
      dateOfLoss: claim.dateOfLoss,
      lossDescription: claim.lossDescription,
      deductibleCents: claim.deductibleCents,
      approvedAmountCents: claim.approvedAmountCents,
      createdAt: claim.createdAt,
    },
    customer: {
      name: claim.customer.name,
      company: claim.customer.company,
      phone: claim.customer.phone,
      email: claim.customer.email,
    },
    property: claim.property
      ? { address: claim.property.address, city: claim.property.city, state: claim.property.state, zip: claim.property.zip }
      : null,
    carrier: claim.carrier
      ? {
          name: claim.carrier.name,
          phone: claim.carrier.phone,
          email: claim.carrier.email,
          claimsPortalUrl: claim.carrier.claimsPortalUrl,
        }
      : null,
    adjuster: claim.adjuster
      ? { name: claim.adjuster.name, phone: claim.adjuster.phone, email: claim.adjuster.email }
      : null,
    jobs: claim.jobs.map((j) => ({
      number: j.number,
      jobType: j.jobType,
      status: j.status,
      completedAt: j.completedAt,
      photos: j.photos.map((p) => ({
        kind: p.kind,
        caption: p.caption,
        takenAt: p.takenAt,
        takenByName: p.takenBy.name,
        url: p.url,
      })),
    })),
    estimates: claim.estimates.map((e) => ({
      number: e.number,
      status: e.status,
      options: e.options.map((o) => ({
        name: o.name,
        tier: o.tier,
        selected: o.selected,
        items: o.items.map((i) => ({
          code: i.priceBookItem?.code ?? null,
          description: i.description,
          qty: i.qty,
          unitPriceCents: i.unitPriceCents,
        })),
      })),
    })),
    supplements: claim.supplements.map((s) => ({
      number: s.number,
      description: s.description,
      amountCents: s.amountCents,
      status: s.status,
      submittedAt: s.submittedAt,
      decidedAt: s.decidedAt,
    })),
  };

  const text = buildClaimPackage(input);
  const photoCount = countPhotos(input);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 print:hidden">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">📦 Carrier package — {claim.claimNumber}</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {photoCount} photos · {claim.supplements.length} supplements · regenerated live from claim data
          </p>
        </div>
        <Link href={`/claims/${claim.id}`} className="text-sm text-blue-600 hover:underline">
          ← Back to claim
        </Link>
      </div>

      <div className="mb-3 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-800 print:hidden">
        💡 Use your browser&apos;s <span className="font-semibold">Print</span> (Ctrl/Cmd+P) to save as PDF, or
        select-all inside the box below and copy the text straight into the carrier portal. This view was recorded in
        the audit trail when exported.
      </div>

      <Card className="print:border-0 print:shadow-none">
        <pre className="overflow-x-auto whitespace-pre-wrap p-4 font-mono text-[11px] leading-relaxed text-slate-800 sm:text-xs">
          {text}
        </pre>
      </Card>
    </div>
  );
}
