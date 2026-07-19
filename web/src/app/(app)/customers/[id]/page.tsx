import Link from "next/link";
import { notFound } from "next/navigation";
import { t, withTenant } from "@/db";
import { desc, eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { addEquipment, addProperty, logCustomerActivity, updatePropertyMemory } from "@/lib/actions/office";
import {
  archiveCustomer,
  archiveProperty,
  cancelMembership,
  removeEquipment,
  saveMembership,
  unarchiveCustomer,
  unarchiveProperty,
  updateCustomer,
  updateEquipment,
  updateProperty,
} from "@/lib/actions/customers";
import { enabledCustomFieldDefs, enabledEquipmentKinds } from "@/lib/trade-packs";
import { displayPairs } from "@/lib/custom-fields";
import { EquipmentForm } from "@/components/office/equipment-form";
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
  THead,
  TCell,
  TRow,
  Table,
  Textarea,
  estimateStatusTone,
  invoiceStatusTone,
  jobStatusTone,
  leadStageTone,
  statusLabel,
} from "@/components/ui";
import { ActivityTimeline } from "@/components/office/timeline";
import { fmtDate, fmtDateTime, lineTotal, money } from "@/lib/format";

export const dynamic = "force-dynamic";

const OPEN_JOB = new Set(["UNSCHEDULED", "SCHEDULED", "DISPATCHED", "EN_ROUTE", "IN_PROGRESS"]);

export default async function CustomerDetailPage({ params }: { params: { id: string } }) {
  const session = await requireSession();

  const { customer, leads } = await withTenant(session.organizationId, async (tx) => {
    const found = await tx.query.customers.findFirst({
      where: eq(t.customers.id, params.id),
      with: {
        membership: true,
        properties: { with: { equipment: true } },
        jobs: { with: { property: true, assignedTo: true }, orderBy: (j, { desc: d }) => [d(j.createdAt)] },
        estimates: { with: { options: { with: { items: true } } }, orderBy: (e, { desc: d }) => [d(e.createdAt)] },
        invoices: { with: { items: true, payments: true }, orderBy: (i, { desc: d }) => [d(i.createdAt)] },
        activities: { with: { user: true }, orderBy: (a, { desc: d }) => [d(a.createdAt)] },
      },
    });
    if (!found) return { customer: null, leads: [] as Awaited<ReturnType<typeof tx.query.leads.findMany>> };
    const foundLeads = await tx.query.leads.findMany({
      where: eq(t.leads.customerId, found.id),
      orderBy: desc(t.leads.createdAt),
    });
    return { customer: found, leads: foundLeads };
  });
  if (!customer) notFound();

  const canEdit = can(session.role, "customers.edit");
  // Pack-scoped equipment composition: kinds + custom-field defs from the
  // org's ENABLED trade packs only (constraint 1).
  const [equipmentKinds, customFieldDefs] = await Promise.all([
    enabledEquipmentKinds(session.organizationId),
    enabledCustomFieldDefs(session.organizationId),
  ]);
  const openJobs = customer.jobs.filter((j) => OPEN_JOB.has(j.status));
  const pastJobs = customer.jobs.filter((j) => !OPEN_JOB.has(j.status));

  return (
    <div>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {customer.name}
            <Badge tone={customer.type === "COMMERCIAL" ? "violet" : "blue"}>
              {customer.type === "COMMERCIAL" ? "Commercial" : "Residential"}
            </Badge>
            {customer.membership ? <Badge tone="green">★ {customer.membership.plan}</Badge> : null}
          </span>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-3">
            {customer.company ? <span>{customer.company}</span> : null}
            {customer.phone ? (
              <a href={`tel:${customer.phone}`} className="text-blue-600 hover:underline">
                📞 {customer.phone}
              </a>
            ) : null}
            {customer.email ? (
              <a href={`mailto:${customer.email}`} className="text-blue-600 hover:underline">
                ✉️ {customer.email}
              </a>
            ) : null}
            <span className="text-slate-400">Customer since {fmtDate(customer.createdAt)}</span>
          </span>
        }
      />

      {customer.archivedAt ? (
        <Card className="mb-4 border-slate-300 bg-slate-50">
          <CardBody className="flex flex-wrap items-center gap-3 text-sm text-slate-700">
            <span>📦 This customer is archived — hidden from lists and booking pickers.</span>
            {canEdit ? (
              <form action={unarchiveCustomer}>
                <input type="hidden" name="customerId" value={customer.id} />
                <Button type="submit" size="sm" variant="secondary">
                  ♻️ Restore customer
                </Button>
              </form>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {customer.smsOptOut ? (
        <Card className="mb-4 border-amber-200 bg-amber-50/60">
          <CardBody className="text-sm text-amber-900">
            🔕 SMS opt-out is SET — every transactional text to this customer is skipped. Clear it in “Edit customer”.
          </CardBody>
        </Card>
      ) : null}

      {/* M1: edit + archive the customer record */}
      {canEdit ? (
        <Card className="mb-4">
          <CardBody className="space-y-3">
            <details className="rounded-lg border border-slate-200">
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-slate-700">✏️ Edit customer</summary>
              <form action={updateCustomer} className="grid gap-3 border-t border-slate-100 p-3 sm:grid-cols-3">
                <input type="hidden" name="customerId" value={customer.id} />
                <Field label="Name">
                  <Input name="name" required defaultValue={customer.name} />
                </Field>
                <Field label="Company">
                  <Input name="company" defaultValue={customer.company ?? ""} />
                </Field>
                <Field label="Type">
                  <Select name="type" defaultValue={customer.type}>
                    <option value="RESIDENTIAL">Residential</option>
                    <option value="COMMERCIAL">Commercial</option>
                  </Select>
                </Field>
                <Field label="Phone">
                  <Input name="phone" defaultValue={customer.phone ?? ""} />
                </Field>
                <Field label="Email">
                  <Input name="email" type="email" defaultValue={customer.email ?? ""} />
                </Field>
                <label className="flex items-end gap-2 pb-2 text-sm text-slate-700">
                  <input type="checkbox" name="smsOptOut" defaultChecked={customer.smsOptOut} className="h-4 w-4" />
                  🔕 SMS opt-out (no texts)
                </label>
                <div className="sm:col-span-3">
                  <Field label="Notes">
                    <Textarea name="notes" rows={2} defaultValue={customer.notes ?? ""} />
                  </Field>
                </div>
                <div className="sm:col-span-3">
                  <Button type="submit" size="sm">
                    Save customer
                  </Button>
                </div>
              </form>
            </details>
            {!customer.archivedAt ? (
              <form action={archiveCustomer}>
                <input type="hidden" name="customerId" value={customer.id} />
                <Button
                  type="submit"
                  size="sm"
                  variant="ghost"
                  title="Hides the customer from lists & pickers. Blocked while open jobs or unpaid invoices exist. Reversible."
                >
                  📦 Archive customer
                </Button>
              </form>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {customer.notes ? (
        <Card className="mb-4">
          <CardBody className="text-sm text-slate-700">📌 {customer.notes}</CardBody>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Left 2/3: properties, jobs, estimates, invoices, leads */}
        <div className="space-y-4 lg:col-span-2">
          {/* Properties */}
          <Card>
            <CardHeader title="Properties" subtitle="Property memory — gate codes, shutoffs, pets, parking — plus installed equipment." />
            <CardBody className="space-y-3">
              {customer.properties.length === 0 ? (
                <EmptyState title="No properties on file" hint="Add one below to start booking jobs." />
              ) : (
                customer.properties.map((p) => (
                  <div key={p.id} className={`rounded-lg border border-slate-200 p-3 ${p.archivedAt ? "opacity-60" : ""}`}>
                    <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-800">
                      <span>
                        {p.label ? `${p.label} — ` : ""}
                        {p.address}, {p.city}, {p.state} {p.zip}
                      </span>
                      {p.archivedAt ? <Badge tone="slate">📦 Archived</Badge> : null}
                      {p.archivedAt && canEdit ? (
                        <form action={unarchiveProperty}>
                          <input type="hidden" name="propertyId" value={p.id} />
                          <input type="hidden" name="customerId" value={customer.id} />
                          <button type="submit" className="text-xs font-medium text-blue-600 hover:underline">
                            ♻️ Restore
                          </button>
                        </form>
                      ) : null}
                    </div>
                    <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                      <div>
                        <dt className="inline font-medium text-slate-500">🔑 Gate code: </dt>
                        <dd className="inline text-slate-700">{p.gateCode ?? "—"}</dd>
                      </div>
                      <div>
                        <dt className="inline font-medium text-slate-500">🚰 Shutoff: </dt>
                        <dd className="inline text-slate-700">{p.shutoffLocation ?? "—"}</dd>
                      </div>
                      <div>
                        <dt className="inline font-medium text-slate-500">🐾 Pets: </dt>
                        <dd className="inline text-slate-700">{p.petNotes ?? "—"}</dd>
                      </div>
                      <div>
                        <dt className="inline font-medium text-slate-500">🅿️ Parking: </dt>
                        <dd className="inline text-slate-700">{p.parkingNotes ?? "—"}</dd>
                      </div>
                      <div className="sm:col-span-2">
                        <dt className="inline font-medium text-slate-500">🚪 Access: </dt>
                        <dd className="inline text-slate-700">{p.accessNotes ?? "—"}</dd>
                      </div>
                    </dl>

                    {p.equipment.filter((e) => !e.archivedAt).length > 0 ? (
                      <div className="mt-2 border-t border-slate-100 pt-2">
                        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Equipment</div>
                        <ul className="space-y-1 text-xs text-slate-700">
                          {p.equipment.filter((e) => !e.archivedAt).map((e) => {
                            const pairs = displayPairs(customFieldDefs, "equipment", e.kind, e.customFields);
                            return (
                              <li key={e.id}>
                                🔩 <span className="font-medium">{e.kind}</span>
                                {e.brand ? ` — ${e.brand}` : ""}
                                {e.model ? ` ${e.model}` : ""}
                                {e.serial ? <span className="text-slate-400"> · S/N {e.serial}</span> : ""}
                                {e.installedAt ? <span className="text-slate-400"> · installed {fmtDate(e.installedAt)}</span> : ""}
                                {e.notes ? <div className="ml-5 text-slate-500">{e.notes}</div> : null}
                                {pairs.length > 0 ? (
                                  <div className="ml-5 mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-slate-500">
                                    {pairs.map((cf) => (
                                      <span key={cf.key}>
                                        <span className="text-slate-400">{cf.label}:</span> {cf.value}
                                      </span>
                                    ))}
                                  </div>
                                ) : null}
                                {canEdit ? (
                                  <details className="ml-5 mt-0.5">
                                    <summary className="cursor-pointer text-[11px] font-medium text-blue-600">Edit / remove</summary>
                                    <form action={updateEquipment} className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
                                      <input type="hidden" name="equipmentId" value={e.id} />
                                      <input type="hidden" name="customerId" value={customer.id} />
                                      <Input name="brand" placeholder="Brand" defaultValue={e.brand ?? ""} aria-label="Brand" />
                                      <Input name="model" placeholder="Model" defaultValue={e.model ?? ""} aria-label="Model" />
                                      <Input name="serial" placeholder="Serial #" defaultValue={e.serial ?? ""} aria-label="Serial" />
                                      <Input
                                        name="installedAt"
                                        type="date"
                                        defaultValue={e.installedAt ? e.installedAt.toISOString().slice(0, 10) : ""}
                                        aria-label="Installed date"
                                      />
                                      <div className="sm:col-span-2">
                                        <Input name="notes" placeholder="Notes" defaultValue={e.notes ?? ""} aria-label="Notes" />
                                      </div>
                                      <div className="flex gap-2 sm:col-span-2">
                                        <Button type="submit" size="sm" variant="secondary">
                                          Save equipment
                                        </Button>
                                      </div>
                                    </form>
                                    <form action={removeEquipment} className="mt-1.5">
                                      <input type="hidden" name="equipmentId" value={e.id} />
                                      <input type="hidden" name="customerId" value={customer.id} />
                                      <button
                                        type="submit"
                                        className="text-[11px] font-medium text-red-600 hover:underline"
                                        title="Removes it from the property record (kept for history)"
                                      >
                                        🗑 Remove equipment
                                      </button>
                                    </form>
                                  </details>
                                ) : null}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ) : null}

                    {canEdit ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs font-medium text-blue-600">＋ Add equipment</summary>
                        <EquipmentForm
                          customerId={customer.id}
                          propertyId={p.id}
                          kinds={equipmentKinds}
                          defs={customFieldDefs}
                          action={addEquipment}
                        />
                      </details>
                    ) : null}

                    {canEdit && !p.archivedAt ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs font-medium text-blue-600">Edit address / label</summary>
                        <form action={updateProperty} className="mt-2 grid gap-2 sm:grid-cols-2">
                          <input type="hidden" name="propertyId" value={p.id} />
                          <input type="hidden" name="customerId" value={customer.id} />
                          <Field label="Label (optional)">
                            <Input name="label" defaultValue={p.label ?? ""} />
                          </Field>
                          <Field label="Address">
                            <Input name="address" required defaultValue={p.address} />
                          </Field>
                          <Field label="City">
                            <Input name="city" required defaultValue={p.city} />
                          </Field>
                          <div className="grid grid-cols-2 gap-2">
                            <Field label="State">
                              <Input name="state" required maxLength={2} defaultValue={p.state} />
                            </Field>
                            <Field label="ZIP">
                              <Input name="zip" required defaultValue={p.zip} />
                            </Field>
                          </div>
                          <div className="flex items-center gap-3 sm:col-span-2">
                            <Button type="submit" size="sm">
                              Save address
                            </Button>
                            <span className="text-[11px] text-slate-400">Changing the address re-geocodes the property.</span>
                          </div>
                        </form>
                        <form action={archiveProperty} className="mt-2">
                          <input type="hidden" name="propertyId" value={p.id} />
                          <input type="hidden" name="customerId" value={customer.id} />
                          <button
                            type="submit"
                            className="text-xs font-medium text-red-600 hover:underline"
                            title="Blocked while open jobs reference this property. Reversible."
                          >
                            📦 Archive property
                          </button>
                        </form>
                      </details>
                    ) : null}

                    {canEdit ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs font-medium text-blue-600">Edit property memory</summary>
                        <form action={updatePropertyMemory} className="mt-2 grid gap-2 sm:grid-cols-2">
                          <input type="hidden" name="propertyId" value={p.id} />
                          <input type="hidden" name="customerId" value={customer.id} />
                          <Field label="Gate code">
                            <Input name="gateCode" defaultValue={p.gateCode ?? ""} />
                          </Field>
                          <Field label="Shutoff location">
                            <Input name="shutoffLocation" defaultValue={p.shutoffLocation ?? ""} />
                          </Field>
                          <Field label="Pet notes">
                            <Input name="petNotes" defaultValue={p.petNotes ?? ""} />
                          </Field>
                          <Field label="Parking notes">
                            <Input name="parkingNotes" defaultValue={p.parkingNotes ?? ""} />
                          </Field>
                          <div className="sm:col-span-2">
                            <Field label="Access notes">
                              <Textarea name="accessNotes" rows={2} defaultValue={p.accessNotes ?? ""} />
                            </Field>
                          </div>
                          <div className="sm:col-span-2">
                            <Button type="submit" size="sm">
                              Save property memory
                            </Button>
                          </div>
                        </form>
                      </details>
                    ) : null}
                  </div>
                ))
              )}

              {canEdit ? (
                <details className="rounded-lg border border-dashed border-slate-300 p-3">
                  <summary className="cursor-pointer text-sm font-medium text-blue-600">＋ Add property</summary>
                  <form action={addProperty} className="mt-3 grid gap-2 sm:grid-cols-2">
                    <input type="hidden" name="customerId" value={customer.id} />
                    <Field label="Label (optional)">
                      <Input name="label" placeholder="e.g. Rental unit" />
                    </Field>
                    <Field label="Address">
                      <Input name="address" required placeholder="123 Main St" />
                    </Field>
                    <Field label="City">
                      <Input name="city" required />
                    </Field>
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="State">
                        <Input name="state" required maxLength={2} placeholder="OH" />
                      </Field>
                      <Field label="ZIP">
                        <Input name="zip" required placeholder="45201" />
                      </Field>
                    </div>
                    <div className="sm:col-span-2">
                      <Button type="submit" size="sm">
                        Add property
                      </Button>
                    </div>
                  </form>
                </details>
              ) : null}
            </CardBody>
          </Card>

          {/* Jobs */}
          <Card>
            <CardHeader title="Open jobs" subtitle={`${openJobs.length} in flight`} />
            <CardBody>
              {openJobs.length === 0 ? (
                <EmptyState title="No open jobs" hint="Book one from the dispatch board." />
              ) : (
                <Table>
                  <THead cols={["Number", "Type", "Property", "Tech", "Scheduled", "Status"]} />
                  <tbody>
                    {openJobs.map((j) => (
                      <TRow key={j.id}>
                        <TCell>
                          <Link href={`/jobs/${j.id}`} className="font-medium text-blue-700 hover:underline">
                            {j.number}
                          </Link>
                        </TCell>
                        <TCell>{j.jobType}</TCell>
                        <TCell>{j.property.address}</TCell>
                        <TCell>{j.assignedTo?.name ?? <span className="text-slate-400">Unassigned</span>}</TCell>
                        <TCell>{j.scheduledAt ? fmtDateTime(j.scheduledAt) : "—"}</TCell>
                        <TCell>
                          <Badge tone={jobStatusTone[j.status]}>{statusLabel(j.status)}</Badge>
                        </TCell>
                      </TRow>
                    ))}
                  </tbody>
                </Table>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Past jobs" subtitle={`${pastJobs.length} completed or cancelled`} />
            <CardBody>
              {pastJobs.length === 0 ? (
                <EmptyState title="No job history yet" />
              ) : (
                <Table>
                  <THead cols={["Number", "Type", "Tech", "Completed", "Status"]} />
                  <tbody>
                    {pastJobs.map((j) => (
                      <TRow key={j.id}>
                        <TCell>
                          <Link href={`/jobs/${j.id}`} className="font-medium text-blue-700 hover:underline">
                            {j.number}
                          </Link>
                        </TCell>
                        <TCell>{j.jobType}</TCell>
                        <TCell>{j.assignedTo?.name ?? "—"}</TCell>
                        <TCell>{j.completedAt ? fmtDateTime(j.completedAt) : "—"}</TCell>
                        <TCell>
                          <Badge tone={jobStatusTone[j.status]}>{statusLabel(j.status)}</Badge>
                        </TCell>
                      </TRow>
                    ))}
                  </tbody>
                </Table>
              )}
            </CardBody>
          </Card>

          {/* Estimates */}
          <Card>
            <CardHeader title="Estimates" />
            <CardBody>
              {customer.estimates.length === 0 ? (
                <EmptyState title="No estimates" hint="Sales builds estimates from leads or jobs." />
              ) : (
                <Table>
                  <THead cols={["Number", "Status", "Value", "Sent", "Views"]} />
                  <tbody>
                    {customer.estimates.map((e) => {
                      const opt = e.options.find((o) => o.selected) ?? e.options[0];
                      const value = opt ? lineTotal(opt.items) : 0;
                      return (
                        <TRow key={e.id}>
                          <TCell>
                            <span className="font-medium">{e.number}</span>
                          </TCell>
                          <TCell>
                            <Badge tone={estimateStatusTone[e.status]}>{statusLabel(e.status)}</Badge>
                          </TCell>
                          <TCell>{value > 0 ? money(value) : "—"}</TCell>
                          <TCell>{e.sentAt ? fmtDate(e.sentAt) : "—"}</TCell>
                          <TCell>{e.viewCount}</TCell>
                        </TRow>
                      );
                    })}
                  </tbody>
                </Table>
              )}
            </CardBody>
          </Card>

          {/* Invoices */}
          <Card>
            <CardHeader title="Invoices" />
            <CardBody>
              {customer.invoices.length === 0 ? (
                <EmptyState title="No invoices" />
              ) : (
                <Table>
                  <THead cols={["Number", "Issued", "Total", "Paid", "Balance", "Status"]} />
                  <tbody>
                    {customer.invoices.map((inv) => {
                      const total = lineTotal(inv.items);
                      const paid = inv.payments.reduce((s, p) => s + p.amountCents, 0);
                      const balance = total - paid;
                      return (
                        <TRow key={inv.id}>
                          <TCell>
                            <Link href="/invoices" className="font-medium text-blue-700 hover:underline">
                              {inv.number}
                            </Link>
                          </TCell>
                          <TCell>{inv.issuedAt ? fmtDate(inv.issuedAt) : "—"}</TCell>
                          <TCell>{money(total)}</TCell>
                          <TCell>{money(paid)}</TCell>
                          <TCell className={balance > 0 && inv.status !== "VOID" ? "font-medium text-red-600" : undefined}>
                            {money(inv.status === "VOID" ? 0 : balance)}
                          </TCell>
                          <TCell>
                            <Badge tone={invoiceStatusTone[inv.status]}>{statusLabel(inv.status)}</Badge>
                          </TCell>
                        </TRow>
                      );
                    })}
                  </tbody>
                </Table>
              )}
            </CardBody>
          </Card>

          {/* Leads */}
          <Card>
            <CardHeader title="Leads" subtitle="Sales opportunities tied to this customer" />
            <CardBody>
              {leads.length === 0 ? (
                <EmptyState title="No leads for this customer" />
              ) : (
                <Table>
                  <THead cols={["Title", "Source", "Stage", "Est. value", "Created"]} />
                  <tbody>
                    {leads.map((l) => (
                      <TRow key={l.id}>
                        <TCell>
                          <span className="font-medium">{l.title}</span>
                          {l.techFlagged ? <Badge tone="cyan" className="ml-1">Tech-flagged</Badge> : null}
                        </TCell>
                        <TCell>{statusLabel(l.source)}</TCell>
                        <TCell>
                          <Badge tone={leadStageTone[l.stage]}>{statusLabel(l.stage)}</Badge>
                        </TCell>
                        <TCell>{l.estValueCents != null ? money(l.estValueCents) : "—"}</TCell>
                        <TCell>{fmtDate(l.createdAt)}</TCell>
                      </TRow>
                    ))}
                  </tbody>
                </Table>
              )}
            </CardBody>
          </Card>
        </div>

        {/* Right 1/3: timeline */}
        <div className="space-y-4">
          {/* M1: membership management */}
          <Card>
            <CardHeader
              title="★ Membership"
              subtitle={customer.membership ? `${customer.membership.plan} · ${statusLabel(customer.membership.status)}` : "No plan on file"}
            />
            <CardBody className="space-y-3">
              {customer.membership ? (
                <p className="text-xs text-slate-500">
                  {customer.membership.status === "ACTIVE" ? "Renews" : "Was set to renew"}{" "}
                  {customer.membership.renewsAt ? fmtDate(customer.membership.renewsAt) : "— no date set"}
                </p>
              ) : null}
              {canEdit ? (
                <>
                  <details className="rounded-lg border border-slate-200">
                    <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-slate-700">
                      {customer.membership ? "✏️ Edit membership" : "＋ Add membership"}
                    </summary>
                    <form action={saveMembership} className="space-y-2 border-t border-slate-100 p-3">
                      <input type="hidden" name="customerId" value={customer.id} />
                      <Field label="Plan">
                        <Input
                          name="plan"
                          required
                          defaultValue={customer.membership?.plan ?? ""}
                          placeholder="e.g. Zebra Care Gold"
                        />
                      </Field>
                      <Field label="Status">
                        <Select name="status" defaultValue={customer.membership?.status ?? "ACTIVE"}>
                          <option value="ACTIVE">Active</option>
                          <option value="PAUSED">Paused</option>
                          <option value="CANCELLED">Cancelled</option>
                        </Select>
                      </Field>
                      <Field label="Renews on">
                        <Input
                          name="renewsAt"
                          type="date"
                          defaultValue={customer.membership?.renewsAt ? customer.membership.renewsAt.toISOString().slice(0, 10) : ""}
                        />
                      </Field>
                      <Button type="submit" size="sm">
                        Save membership
                      </Button>
                    </form>
                  </details>
                  {customer.membership && customer.membership.status !== "CANCELLED" ? (
                    <form action={cancelMembership}>
                      <input type="hidden" name="customerId" value={customer.id} />
                      <Button type="submit" size="sm" variant="ghost">
                        Cancel membership
                      </Button>
                    </form>
                  ) : null}
                </>
              ) : null}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Add to timeline" />
            <CardBody>
              <form action={logCustomerActivity} className="space-y-2">
                <input type="hidden" name="customerId" value={customer.id} />
                <Field label="Type">
                  <Select name="kind" defaultValue="NOTE">
                    <option value="NOTE">📝 Note</option>
                    <option value="CALL">📞 Log call</option>
                  </Select>
                </Field>
                <Field label="Details">
                  <Textarea name="body" rows={3} required placeholder="What happened?" />
                </Field>
                <Button type="submit" size="sm">
                  Add entry
                </Button>
              </form>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Activity timeline" subtitle="Calls, texts, payments, reviews and system events" />
            <CardBody>
              <ActivityTimeline activities={customer.activities} />
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
