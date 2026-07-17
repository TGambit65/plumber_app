import Link from "next/link";
import { notFound } from "next/navigation";
import { t, withTenant } from "@/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { fmtDate, fmtDateTime, lineTotal, money, timeAgo } from "@/lib/format";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Stat,
  Textarea,
  estimateStatusTone,
  jobStatusTone,
  statusLabel,
} from "@/components/ui";
import { Forbidden } from "@/components/sales/meta";
import {
  CLAIM_NEXT,
  SUPPLEMENT_NEXT,
  claimStatusTone,
  supplementStatusTone,
  type ClaimStatus,
} from "@/components/claims/meta";
import {
  advanceClaimStatus,
  advanceSupplement,
  createSupplement,
  exportClaimPackage,
  linkJobToClaim,
  unlinkJobFromClaim,
  updateClaimFacts,
} from "@/lib/actions/claims";

export const dynamic = "force-dynamic";

const ACTIVITY_ICON: Record<string, string> = {
  CALL: "📞",
  SMS: "💬",
  EMAIL: "✉️",
  NOTE: "📝",
  STATUS: "🔁",
  SYSTEM: "⚙️",
  ESTIMATE_VIEW: "👁",
  PAYMENT: "💳",
  REVIEW: "⭐",
};

const NEXT_LABEL: Record<string, { label: string; variant: "primary" | "secondary" | "success" | "danger" }> = {
  DOCUMENTING: { label: "📷 Start documenting", variant: "primary" },
  SUBMITTED: { label: "📤 Submit to carrier", variant: "primary" },
  SUPPLEMENT: { label: "➕ Supplement needed", variant: "secondary" },
  APPROVED: { label: "✓ Carrier approved", variant: "success" },
  DENIED: { label: "✗ Carrier denied", variant: "danger" },
  PAID: { label: "💵 Payment received", variant: "success" },
  CLOSED: { label: "🗄️ Close claim", variant: "secondary" },
};

function toDateInput(d: Date | string | null): string {
  if (!d) return "";
  return new Date(d).toISOString().slice(0, 10);
}

export default async function ClaimDetailPage({ params }: { params: { id: string } }) {
  const session = await requireSession();
  if (!can(session.role, "claims.manage")) return <Forbidden />;

  const data = await withTenant(session.organizationId, async (tx) => {
    const claim = await tx.query.claims.findFirst({
      where: eq(t.claims.id, params.id),
      with: {
        customer: true,
        property: true,
        carrier: true,
        adjuster: true,
        createdBy: true,
        supplements: true,
        jobs: { with: { assignedTo: true, photos: { with: { takenBy: true } } } },
        estimates: { with: { options: { with: { items: true } } } },
      },
    });
    if (!claim) return null;
    const [linkableJobs, customerActivities] = await Promise.all([
      tx.query.jobs.findMany({
        where: and(eq(t.jobs.customerId, claim.customerId), isNull(t.jobs.claimId)),
        orderBy: [desc(t.jobs.createdAt)],
      }),
      tx.query.activities.findMany({
        where: eq(t.activities.customerId, claim.customerId),
        with: { user: true },
        orderBy: [desc(t.activities.createdAt)],
      }),
    ]);
    return { claim, linkableJobs, customerActivities };
  });
  if (!data) notFound();
  const { claim, linkableJobs } = data;

  // Claims have no activity FK — claim events are logged against the customer
  // with the claim number in the body; filter the customer timeline down.
  const activities = data.customerActivities.filter((a) => a.body.includes(claim.claimNumber));

  const nextStatuses = CLAIM_NEXT[claim.status as ClaimStatus] ?? [];
  const supplements = [...claim.supplements].sort((a, b) => a.number.localeCompare(b.number));
  const approvedSupplements = supplements.filter((s) => s.status === "APPROVED").reduce((s, x) => s + x.amountCents, 0);
  const photos = claim.jobs
    .flatMap((j) => j.photos.map((p) => ({ ...p, jobNumber: j.number })))
    .sort((a, b) => new Date(a.takenAt).getTime() - new Date(b.takenAt).getTime());

  return (
    <div>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            🛡️ {claim.claimNumber}
            <Badge tone={claimStatusTone[claim.status]}>{statusLabel(claim.status)}</Badge>
          </span>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              {claim.customer.name}
              {claim.property ? ` · ${claim.property.address}, ${claim.property.city}` : ""}
            </span>
            {claim.carrier ? (
              <Badge tone="slate">
                🏢 {claim.carrier.name}
                {claim.carrier.phone ? ` · ${claim.carrier.phone}` : ""}
              </Badge>
            ) : null}
            {claim.adjuster ? (
              <Badge tone="slate">
                👤 {claim.adjuster.name}
                {claim.adjuster.phone ? ` · ${claim.adjuster.phone}` : ""}
              </Badge>
            ) : null}
          </span>
        }
        action={
          <Link href="/claims" className="text-sm text-blue-600 hover:underline">
            ← Claims
          </Link>
        }
      />

      {/* Status advance buttons */}
      {nextStatuses.length > 0 ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {nextStatuses.map((to) => {
            const meta = NEXT_LABEL[to] ?? { label: `→ ${statusLabel(to)}`, variant: "secondary" as const };
            return (
              <form key={to} action={advanceClaimStatus}>
                <input type="hidden" name="claimId" value={claim.id} />
                <input type="hidden" name="to" value={to} />
                <Button size="sm" variant={meta.variant}>
                  {meta.label}
                </Button>
              </form>
            );
          })}
        </div>
      ) : null}

      {/* Stat row */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Approved amount" value={money(claim.approvedAmountCents)} tone={claim.approvedAmountCents != null ? "good" : "default"} hint="carrier scope approval" />
        <Stat label="Deductible" value={money(claim.deductibleCents)} hint="customer responsibility" />
        <Stat
          label="Approved supplements"
          value={money(approvedSupplements)}
          tone={approvedSupplements > 0 ? "good" : "default"}
          hint={`${supplements.length} filed total`}
        />
        <Stat label="Photo documentation" value={photos.length} hint={`across ${claim.jobs.length} linked job${claim.jobs.length === 1 ? "" : "s"}`} />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-3">
        {/* Main column */}
        <div className="space-y-5 xl:col-span-2">
          {/* Linked work */}
          <Card>
            <CardHeader title="🔧 Linked work" subtitle="Jobs & estimates tied to this claim — photos below come from these jobs" />
            <CardBody className="p-0">
              {claim.jobs.length === 0 ? (
                <div className="p-4">
                  <EmptyState title="No jobs linked yet" hint="Link the repair job so its photos document the claim." />
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {claim.jobs.map((j) => (
                    <li key={j.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                      <Link href={`/jobs/${j.id}`} className="text-sm font-medium text-slate-900 hover:text-blue-600">
                        {j.number}
                      </Link>
                      <span className="min-w-0 flex-1 truncate text-xs text-slate-500">
                        {j.jobType}
                        {j.assignedTo ? ` · ${j.assignedTo.name.split(" ")[0]}` : ""}
                      </span>
                      <Badge tone={jobStatusTone[j.status]}>{statusLabel(j.status)}</Badge>
                      <span className="text-xs text-slate-400">📷 {j.photos.length}</span>
                      <form action={unlinkJobFromClaim}>
                        <input type="hidden" name="claimId" value={claim.id} />
                        <input type="hidden" name="jobId" value={j.id} />
                        <Button size="sm" variant="ghost">
                          Unlink
                        </Button>
                      </form>
                    </li>
                  ))}
                </ul>
              )}
              <form action={linkJobToClaim} className="flex flex-wrap items-end gap-2 border-t border-slate-100 p-4">
                <input type="hidden" name="claimId" value={claim.id} />
                <div className="min-w-[240px] flex-1">
                  <Field label={`Link an existing job (${claim.customer.name}'s unlinked jobs)`}>
                    <Select name="jobId" required defaultValue="">
                      <option value="" disabled>
                        {linkableJobs.length === 0 ? "No unlinked jobs for this customer" : "Select job…"}
                      </option>
                      {linkableJobs.map((j) => (
                        <option key={j.id} value={j.id}>
                          {j.number} — {j.jobType} ({statusLabel(j.status)})
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <Button size="sm" variant="secondary" disabled={linkableJobs.length === 0}>
                  🔗 Link job
                </Button>
              </form>
              {/* Linked estimates */}
              <div className="border-t border-slate-100 p-4">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Linked estimates</div>
                {claim.estimates.length === 0 ? (
                  <p className="text-xs text-slate-400">
                    No estimates linked. Link an estimate to this claim from the estimate builder — APPROVED options feed the carrier export scope.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {claim.estimates.map((e) => {
                      const selected = e.options.filter((o) => o.selected);
                      const opts = selected.length > 0 ? selected : e.options;
                      const total = opts.reduce((s, o) => s + lineTotal(o.items), 0);
                      return (
                        <li key={e.id} className="flex flex-wrap items-center gap-2">
                          <Link href={`/estimates/${e.id}`} className="text-sm font-medium text-slate-900 hover:text-blue-600">
                            {e.number}
                          </Link>
                          <Badge tone={estimateStatusTone[e.status]}>{statusLabel(e.status)}</Badge>
                          <span className="text-xs text-slate-500">
                            {opts.reduce((s, o) => s + o.items.length, 0)} line items
                          </span>
                          <span className="ml-auto font-medium tabular-nums text-slate-800">{money(total)}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </CardBody>
          </Card>

          {/* Photo documentation */}
          <Card>
            <CardHeader
              title={`📷 Photo documentation (${photos.length})`}
              subtitle="Pulled from jobs linked to this claim — adjusters want before/problem/after coverage"
            />
            <CardBody>
              {photos.length === 0 ? (
                <EmptyState
                  title="No claim photos yet"
                  hint="Link a job and have techs capture BEFORE / PROBLEM / AFTER photos on it."
                />
              ) : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {photos.map((p) => (
                    <figure key={p.id} className="overflow-hidden rounded-lg border border-slate-200">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={p.url} alt={p.caption ?? p.kind} className="h-28 w-full bg-slate-100 object-cover" />
                      <figcaption className="space-y-0.5 px-2 py-1.5">
                        <div className="flex items-center gap-1.5">
                          <Badge tone={p.kind === "PROBLEM" ? "red" : p.kind === "AFTER" ? "green" : "slate"}>
                            {statusLabel(p.kind)}
                          </Badge>
                          <span className="text-[11px] text-slate-400">{p.jobNumber}</span>
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {p.caption ?? "—"} · {p.takenBy.name.split(" ")[0]}, {fmtDateTime(p.takenAt)}
                        </div>
                      </figcaption>
                    </figure>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>

          {/* Supplements */}
          <Card>
            <CardHeader
              title="➕ Supplements"
              subtitle="Additional scope found after submission — decisions notify the claim creator"
            />
            <CardBody className="p-0">
              {supplements.length === 0 ? (
                <div className="p-4">
                  <EmptyState title="No supplements filed" hint="Draft one below when hidden damage turns up." />
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {supplements.map((s) => (
                    <li key={s.id} className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-slate-900">{s.number}</span>
                        <Badge tone={supplementStatusTone[s.status]}>{statusLabel(s.status)}</Badge>
                        <span className="ml-auto font-semibold tabular-nums text-slate-800">{money(s.amountCents)}</span>
                      </div>
                      <p className="mt-1 text-sm text-slate-600">{s.description}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-slate-500">
                        {s.submittedAt ? <span>📤 submitted {fmtDate(s.submittedAt)}</span> : null}
                        {s.decidedAt ? <span>⚖️ decided {fmtDate(s.decidedAt)}</span> : null}
                      </div>
                      {(SUPPLEMENT_NEXT[s.status] ?? []).length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {s.status === "DRAFT" ? (
                            <form action={advanceSupplement}>
                              <input type="hidden" name="supplementId" value={s.id} />
                              <input type="hidden" name="to" value="SUBMITTED" />
                              <Button size="sm" variant="secondary">
                                📤 Submit to carrier
                              </Button>
                            </form>
                          ) : null}
                          {s.status === "SUBMITTED" ? (
                            <>
                              <form action={advanceSupplement}>
                                <input type="hidden" name="supplementId" value={s.id} />
                                <input type="hidden" name="to" value="APPROVED" />
                                <Button size="sm" variant="success">
                                  ✓ Approved
                                </Button>
                              </form>
                              <form action={advanceSupplement}>
                                <input type="hidden" name="supplementId" value={s.id} />
                                <input type="hidden" name="to" value="DENIED" />
                                <Button size="sm" variant="danger">
                                  ✗ Denied
                                </Button>
                              </form>
                            </>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              <form action={createSupplement} className="flex flex-wrap items-end gap-2 border-t border-slate-100 p-4">
                <input type="hidden" name="claimId" value={claim.id} />
                <div className="min-w-[220px] flex-1">
                  <Field label="New supplement — description">
                    <Input name="description" required placeholder="e.g. Subfloor rot found after cabinet removal" />
                  </Field>
                </div>
                <div className="w-32">
                  <Field label="Amount ($)">
                    <Input name="amount" required inputMode="decimal" placeholder="1850" />
                  </Field>
                </div>
                <Button size="sm">＋ Draft supplement</Button>
              </form>
            </CardBody>
          </Card>
        </div>

        {/* Side column */}
        <div className="space-y-5">
          {/* Key facts */}
          <Card>
            <CardHeader title="📄 Key facts" subtitle="Policy details are PII — edits are audit-logged (masked)" />
            <CardBody>
              <form action={updateClaimFacts} className="space-y-3">
                <input type="hidden" name="claimId" value={claim.id} />
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Policy number">
                    <Input name="policyNumber" defaultValue={claim.policyNumber ?? ""} placeholder="HO-…" />
                  </Field>
                  <Field label="Date of loss">
                    <Input name="dateOfLoss" type="date" defaultValue={toDateInput(claim.dateOfLoss)} />
                  </Field>
                  <Field label="Deductible ($)">
                    <Input
                      name="deductible"
                      inputMode="decimal"
                      defaultValue={claim.deductibleCents != null ? String(claim.deductibleCents / 100) : ""}
                    />
                  </Field>
                  <Field label="Approved amount ($)">
                    <Input
                      name="approvedAmount"
                      inputMode="decimal"
                      defaultValue={claim.approvedAmountCents != null ? String(claim.approvedAmountCents / 100) : ""}
                    />
                  </Field>
                </div>
                <Field label="Loss description">
                  <Textarea name="lossDescription" rows={4} defaultValue={claim.lossDescription ?? ""} />
                </Field>
                <div className="text-xs text-slate-500">
                  Opened {fmtDate(claim.createdAt)}
                  {claim.createdBy ? ` by ${claim.createdBy.name}` : ""}
                </div>
                <Button size="sm" variant="secondary" className="w-full">
                  💾 Save facts
                </Button>
              </form>
            </CardBody>
          </Card>

          {/* Carrier export */}
          <Card>
            <CardHeader title="📦 Carrier package" subtitle="Structured export: loss details, scope, supplements, photo manifest" />
            <CardBody className="space-y-2">
              <form action={exportClaimPackage}>
                <input type="hidden" name="claimId" value={claim.id} />
                <Button size="sm" className="w-full">
                  📤 Export carrier package
                </Button>
              </form>
              <p className="text-xs text-slate-500">
                Generates a carrier-format text package and opens the printable view. Every export is written to the
                audit trail (action <span className="font-mono">CLAIM_EXPORT</span>).
              </p>
            </CardBody>
          </Card>

          {/* Activity */}
          <Card>
            <CardHeader title="🕘 Claim activity" subtitle="Timeline entries referencing this claim number" />
            <CardBody>
              {activities.length === 0 ? (
                <EmptyState title="No activity yet" hint="Status changes, supplements and exports show up here." />
              ) : (
                <ul className="space-y-3">
                  {activities.map((a) => (
                    <li key={a.id} className="flex gap-2.5">
                      <span className="mt-0.5 text-sm">{ACTIVITY_ICON[a.kind] ?? "•"}</span>
                      <div className="min-w-0 flex-1 border-b border-slate-100 pb-2.5">
                        <p className="text-sm text-slate-800">{a.body}</p>
                        <p className="mt-0.5 text-xs text-slate-500">
                          {a.user ? `${a.user.name} · ` : ""}
                          {timeAgo(a.createdAt)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
