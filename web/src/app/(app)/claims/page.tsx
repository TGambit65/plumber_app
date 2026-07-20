import Link from "next/link";
import { t, withTenant } from "@/db";
import { desc } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { fmtDate, money } from "@/lib/format";
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
  Table,
  TCell,
  THead,
  TRow,
  Textarea,
  statusLabel,
} from "@/components/ui";
import { Forbidden } from "@/components/sales/meta";
import { CLAIM_STATUSES, OPEN_CLAIM_STATUSES, claimStatusTone } from "@/components/claims/meta";
import { createAdjuster, createCarrier, createClaim, updateAdjuster, updateCarrier } from "@/lib/actions/claims";
import { clsx } from "@/lib/clsx";

export const dynamic = "force-dynamic";

export default async function ClaimsPage({ searchParams }: { searchParams: { status?: string } }) {
  const session = await requireSession();
  if (!can(session.role, "claims.manage")) return <Forbidden />;

  const statusFilter = (CLAIM_STATUSES as readonly string[]).includes(searchParams.status ?? "")
    ? searchParams.status
    : undefined;

  const [allClaims, carriers, customers] = await withTenant(session.organizationId, (tx) =>
    Promise.all([
      tx.query.claims.findMany({
        with: { customer: true, property: true, carrier: true, adjuster: true, supplements: true, jobs: true },
        orderBy: [desc(t.claims.createdAt)],
      }),
      tx.query.carriers.findMany({ with: { adjusters: true }, orderBy: [t.carriers.name] }),
      tx.query.customers.findMany({ with: { properties: true }, orderBy: [t.customers.name] }),
    ])
  );

  const claims = statusFilter ? allClaims.filter((c) => c.status === statusFilter) : allClaims;

  // Stats (across ALL claims, not the filtered view)
  const openClaims = allClaims.filter((c) => (OPEN_CLAIM_STATUSES as string[]).includes(c.status));
  const totalApproved = allClaims.reduce((s, c) => s + (c.approvedAmountCents ?? 0), 0);
  const pendingSupplements = allClaims
    .flatMap((c) => c.supplements)
    .filter((s) => s.status === "DRAFT" || s.status === "SUBMITTED").length;
  const notClosed = allClaims.filter((c) => c.status !== "CLOSED");
  const avgDaysOpen =
    notClosed.length > 0
      ? Math.round(
          notClosed.reduce((s, c) => s + (Date.now() - new Date(c.createdAt).getTime()) / 86_400_000, 0) /
            notClosed.length
        )
      : 0;

  const properties = customers.flatMap((c) => c.properties.map((p) => ({ ...p, customerName: c.name })));

  const countByStatus: Record<string, number> = {};
  for (const c of allClaims) countByStatus[c.status] = (countByStatus[c.status] ?? 0) + 1;

  return (
    <div>
      <PageHeader
        title="🛡️ Insurance claims"
        subtitle="Carrier claims, supplements & documentation — every change is audit-logged"
      />

      {/* Stat row */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Open claims" value={openClaims.length} hint="awaiting carrier resolution" />
        <Stat label="Total approved" value={money(totalApproved)} tone={totalApproved > 0 ? "good" : "default"} hint="across all claims" />
        <Stat
          label="Pending supplements"
          value={pendingSupplements}
          tone={pendingSupplements > 0 ? "warn" : "default"}
          hint="draft or awaiting decision"
        />
        <Stat label="Avg days open" value={avgDaysOpen} hint="claims not yet closed" />
      </div>

      {/* Status filter chips */}
      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        <Link
          href="/claims"
          className={clsx(
            "rounded-full px-3 py-1 text-xs font-medium transition-colors",
            !statusFilter ? "bg-slate-900 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
          )}
        >
          All ({allClaims.length})
        </Link>
        {CLAIM_STATUSES.map((s) => (
          <Link
            key={s}
            href={`/claims?status=${s}`}
            className={clsx(
              "rounded-full px-3 py-1 text-xs font-medium transition-colors",
              statusFilter === s
                ? "bg-slate-900 text-white"
                : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
            )}
          >
            {statusLabel(s)} ({countByStatus[s] ?? 0})
          </Link>
        ))}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-5 xl:grid-cols-3">
        {/* Claims list */}
        <div className="xl:col-span-2">
          <Card>
            {claims.length === 0 ? (
              <div className="p-4">
                <EmptyState
                  title={statusFilter ? `No ${statusLabel(statusFilter)} claims` : "No claims yet"}
                  hint={statusFilter ? "Try clearing the status filter." : "Open your first claim with the form on the right."}
                />
              </div>
            ) : (
              <>
                {/* Mobile: card list */}
                <ul className="divide-y divide-slate-100 md:hidden">
                  {claims.map((c) => (
                    <li key={c.id}>
                      <Link href={`/claims/${c.id}`} className="block px-4 py-3 active:bg-slate-50">
                        <div className="flex items-start justify-between gap-2">
                          <span className="font-medium text-slate-900">{c.claimNumber}</span>
                          <Badge tone={claimStatusTone[c.status]}>{statusLabel(c.status)}</Badge>
                        </div>
                        <div className="mt-1 text-xs text-slate-500">
                          {c.customer.name}
                          {c.property ? ` · ${c.property.address}` : ""}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                          <span>🏢 {c.carrier?.name ?? "No carrier"}</span>
                          <span>📅 loss {fmtDate(c.dateOfLoss)}</span>
                          <span>ded. {money(c.deductibleCents)}</span>
                          {c.approvedAmountCents != null ? (
                            <span className="font-medium text-emerald-700">✓ {money(c.approvedAmountCents)}</span>
                          ) : null}
                          <span>🔧 {c.jobs.length} job{c.jobs.length === 1 ? "" : "s"}</span>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
                {/* Desktop: table */}
                <div className="hidden md:block">
                  <Table>
                    <THead cols={["Claim #", "Status", "Customer / property", "Carrier / adjuster", "Date of loss", "Deductible", "Approved", "Jobs"]} />
                    <tbody>
                      {claims.map((c) => (
                        <TRow key={c.id}>
                          <TCell>
                            <Link href={`/claims/${c.id}`} className="font-medium text-slate-900 hover:text-blue-600">
                              {c.claimNumber}
                            </Link>
                          </TCell>
                          <TCell>
                            <Badge tone={claimStatusTone[c.status]}>{statusLabel(c.status)}</Badge>
                          </TCell>
                          <TCell>
                            <div className="text-slate-800">{c.customer.name}</div>
                            <div className="text-xs text-slate-500">
                              {c.property ? `${c.property.address}, ${c.property.city}` : "—"}
                            </div>
                          </TCell>
                          <TCell>
                            <div className="text-slate-800">{c.carrier?.name ?? "—"}</div>
                            <div className="text-xs text-slate-500">{c.adjuster ? `👤 ${c.adjuster.name}` : "no adjuster"}</div>
                          </TCell>
                          <TCell>{fmtDate(c.dateOfLoss)}</TCell>
                          <TCell>
                            <span className="tabular-nums">{money(c.deductibleCents)}</span>
                          </TCell>
                          <TCell>
                            {c.approvedAmountCents != null ? (
                              <span className="font-medium tabular-nums text-emerald-700">{money(c.approvedAmountCents)}</span>
                            ) : (
                              <span className="text-xs text-slate-400">pending</span>
                            )}
                          </TCell>
                          <TCell>
                            <span className="tabular-nums">{c.jobs.length}</span>
                          </TCell>
                        </TRow>
                      ))}
                    </tbody>
                  </Table>
                </div>
              </>
            )}
          </Card>
        </div>

        {/* Side column: new claim + carriers */}
        <div className="space-y-5">
          <Card>
            <CardHeader title="＋ New claim" subtitle="Policy details are PII — creation is audit-logged" />
            <CardBody>
              {customers.length === 0 ? (
                <EmptyState title="No customers yet" hint="Add a customer before opening a claim." />
              ) : (
                <form action={createClaim} className="space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Claim number *">
                      <Input name="claimNumber" required placeholder="NW-2026-…" />
                    </Field>
                    <Field label="Policy number">
                      <Input name="policyNumber" placeholder="HO-…" />
                    </Field>
                  </div>
                  <Field label="Customer *">
                    <Select name="customerId" required defaultValue="">
                      <option value="" disabled>
                        Select customer…
                      </option>
                      {customers.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Property">
                    <Select name="propertyId" defaultValue="">
                      <option value="">No property</option>
                      {properties.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.customerName} — {p.address}, {p.city}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Carrier">
                      <Select name="carrierId" defaultValue="">
                        <option value="">No carrier</option>
                        {carriers.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Adjuster">
                      <Select name="adjusterId" defaultValue="">
                        <option value="">No adjuster</option>
                        {carriers.flatMap((c) =>
                          c.adjusters.map((a) => (
                            <option key={a.id} value={a.id}>
                              {c.name} — {a.name}
                            </option>
                          ))
                        )}
                      </Select>
                    </Field>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Date of loss">
                      <Input name="dateOfLoss" type="date" />
                    </Field>
                    <Field label="Deductible ($)">
                      <Input name="deductible" inputMode="decimal" placeholder="1000" />
                    </Field>
                  </div>
                  <Field label="Loss description">
                    <Textarea name="lossDescription" rows={3} placeholder="What happened, where, and the resulting damage…" />
                  </Field>
                  <Button className="w-full">🛡️ Open claim</Button>
                </form>
              )}
            </CardBody>
          </Card>

          {/* Carriers & adjusters management */}
          <Card>
            <CardHeader title="🏢 Carriers & adjusters" subtitle={`${carriers.length} carrier${carriers.length === 1 ? "" : "s"} on file`} />
            <CardBody className="p-0">
              {carriers.length === 0 ? (
                <div className="p-4">
                  <EmptyState title="No carriers yet" hint="Add the insurance companies you work with." />
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {carriers.map((c) => (
                    <li key={c.id} className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-slate-900">{c.name}</span>
                        {c.claimsPortalUrl ? (
                          <a
                            href={c.claimsPortalUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs text-blue-600 hover:underline"
                          >
                            portal ↗
                          </a>
                        ) : null}
                      </div>
                      <div className="text-xs text-slate-500">
                        {[c.phone, c.email].filter(Boolean).join(" · ") || "no contact info"}
                      </div>
                      {c.adjusters.length > 0 ? (
                        <ul className="mt-1.5 space-y-1">
                          {c.adjusters.map((a) => (
                            <li key={a.id} className="text-xs text-slate-600">
                              👤 {a.name}
                              {a.phone ? ` · ${a.phone}` : ""}
                              {a.notes ? <span className="text-slate-400"> — {a.notes}</span> : null}
                              {/* M5: adjuster edit */}
                              <details className="ml-4">
                                <summary className="cursor-pointer text-[11px] font-medium text-blue-600">✏️ Edit adjuster</summary>
                                <form action={updateAdjuster} className="mt-1 flex flex-wrap items-end gap-1.5">
                                  <input type="hidden" name="adjusterId" value={a.id} />
                                  <Input name="name" required defaultValue={a.name} aria-label="Name" className="h-8 w-32 text-xs" />
                                  <Input name="phone" defaultValue={a.phone ?? ""} placeholder="phone" aria-label="Phone" className="h-8 w-28 text-xs" />
                                  <Input name="email" defaultValue={a.email ?? ""} placeholder="email" aria-label="Email" className="h-8 w-36 text-xs" />
                                  <Input name="notes" defaultValue={a.notes ?? ""} placeholder="notes" aria-label="Notes" className="h-8 w-32 text-xs" />
                                  <Button type="submit" size="sm" variant="secondary">Save</Button>
                                </form>
                              </details>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="mt-1 text-xs text-slate-400">No adjusters on file</div>
                      )}
                      {/* M5: carrier edit — a typo'd portal URL is no longer permanent */}
                      <details className="mt-1.5">
                        <summary className="cursor-pointer text-[11px] font-medium text-blue-600">✏️ Edit carrier</summary>
                        <form action={updateCarrier} className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
                          <input type="hidden" name="carrierId" value={c.id} />
                          <Input name="name" required defaultValue={c.name} aria-label="Name" className="h-8 text-xs" />
                          <Input name="phone" defaultValue={c.phone ?? ""} placeholder="phone" aria-label="Phone" className="h-8 text-xs" />
                          <Input name="email" defaultValue={c.email ?? ""} placeholder="email" aria-label="Email" className="h-8 text-xs" />
                          <Input name="claimsPortalUrl" defaultValue={c.claimsPortalUrl ?? ""} placeholder="claims portal URL" aria-label="Portal URL" className="h-8 text-xs" />
                          <div className="sm:col-span-2">
                            <Button type="submit" size="sm" variant="secondary">Save carrier</Button>
                          </div>
                        </form>
                      </details>
                    </li>
                  ))}
                </ul>
              )}
              {/* Add carrier */}
              <form action={createCarrier} className="space-y-2 border-t border-slate-100 p-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Add carrier</div>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Name *">
                    <Input name="name" required placeholder="Allstate" />
                  </Field>
                  <Field label="Phone">
                    <Input name="phone" placeholder="800-…" />
                  </Field>
                  <Field label="Email">
                    <Input name="email" type="email" placeholder="claims@…" />
                  </Field>
                  <Field label="Claims portal URL">
                    <Input name="claimsPortalUrl" placeholder="https://…" />
                  </Field>
                </div>
                <Button size="sm" variant="secondary">
                  ＋ Add carrier
                </Button>
              </form>
              {/* Add adjuster */}
              {carriers.length > 0 ? (
                <form action={createAdjuster} className="space-y-2 border-t border-slate-100 p-4">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Add adjuster</div>
                  <Field label="Carrier *">
                    <Select name="carrierId" required defaultValue="">
                      <option value="" disabled>
                        Select carrier…
                      </option>
                      {carriers.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Name *">
                      <Input name="name" required placeholder="Adjuster name" />
                    </Field>
                    <Field label="Phone">
                      <Input name="phone" placeholder="555-…" />
                    </Field>
                    <Field label="Email">
                      <Input name="email" type="email" placeholder="name@…" />
                    </Field>
                    <Field label="Notes">
                      <Input name="notes" placeholder="Preferences, quirks…" />
                    </Field>
                  </div>
                  <Button size="sm" variant="secondary">
                    ＋ Add adjuster
                  </Button>
                </form>
              ) : null}
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
