import Link from "next/link";
import { notFound } from "next/navigation";
import { t, withTenant } from "@/db";
import { desc, eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { addEquipment, addProperty, logCustomerActivity, updatePropertyMemory } from "@/lib/actions/office";
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
                  <div key={p.id} className="rounded-lg border border-slate-200 p-3">
                    <div className="text-sm font-semibold text-slate-800">
                      {p.label ? `${p.label} — ` : ""}
                      {p.address}, {p.city}, {p.state} {p.zip}
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

                    {p.equipment.length > 0 ? (
                      <div className="mt-2 border-t border-slate-100 pt-2">
                        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Equipment</div>
                        <ul className="space-y-1 text-xs text-slate-700">
                          {p.equipment.map((e) => {
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
