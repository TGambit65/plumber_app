import Link from "next/link";
import { notFound } from "next/navigation";
import { t, withTenant } from "@/db";
import { asc, desc, eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { markInvoiceSent, recordPayment } from "@/lib/actions/office";
import {
  addInvoiceLine,
  removeInvoiceLine,
  sendInvoiceReminder,
  updateInvoiceDates,
  updateInvoiceLine,
  voidAndDuplicateInvoice,
} from "@/lib/actions/money";
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
  invoiceStatusTone,
  statusLabel,
} from "@/components/ui";
import { fmtDate, fmtDateTime, lineTotal, money, timeAgo } from "@/lib/format";

export const dynamic = "force-dynamic";

const UNPAID = new Set<string>(["SENT", "PARTIAL", "OVERDUE"]);

/** M3: the invoice finally gets its own page — lines, payments, corrections. */
export default async function InvoiceDetailPage({ params }: { params: { id: string } }) {
  const session = await requireSession();

  const { inv, priceBook, auditRows } = await withTenant(session.organizationId, async (tx) => {
    const inv = await tx.query.invoices.findFirst({
      where: eq(t.invoices.id, params.id),
      with: {
        customer: true,
        job: true,
        project: true,
        items: true,
        payments: { orderBy: asc(t.payments.receivedAt) },
      },
    });
    const priceBook =
      inv?.status === "DRAFT"
        ? await tx.query.priceBookItems.findMany({
            where: eq(t.priceBookItems.active, true),
            orderBy: [t.priceBookItems.category, t.priceBookItems.name],
          })
        : [];
    const auditRows = inv
      ? await tx
          .select({ log: t.auditLogs, user: t.users })
          .from(t.auditLogs)
          .leftJoin(t.users, eq(t.auditLogs.userId, t.users.id))
          .where(eq(t.auditLogs.entityId, inv.id))
          .orderBy(desc(t.auditLogs.createdAt))
          .limit(10)
      : [];
    return { inv, priceBook, auditRows };
  });
  if (!inv) notFound();

  const total = lineTotal(inv.items);
  const paid = inv.payments.reduce((s, p) => s + p.amountCents, 0);
  const balance = total - paid;
  const isDraft = inv.status === "DRAFT";
  const canTakePayment = can(session.role, "payments.take");
  const canEdit = can(session.role, "invoices.create");
  const isAdmin = session.role === "ADMIN";
  const toDateInput = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            Invoice {inv.number}
            <Badge tone={invoiceStatusTone[inv.status]}>{statusLabel(inv.status)}</Badge>
          </span>
        }
        subtitle={
          <span>
            <Link href={`/customers/${inv.customerId}`} className="text-blue-600 hover:underline">
              {inv.customer.name}
            </Link>
            {inv.job ? (
              <>
                {" · "}
                <Link href={`/jobs/${inv.job.id}`} className="text-blue-600 hover:underline">
                  🔧 {inv.job.number}
                </Link>
              </>
            ) : null}
            {inv.project ? (
              <>
                {" · "}
                <Link href={`/projects/${inv.project.id}`} className="text-blue-600 hover:underline">
                  🏗️ {inv.project.name}
                </Link>
              </>
            ) : null}
          </span>
        }
        action={
          <Link href="/invoices" className="text-sm text-blue-600 hover:underline">
            ← Invoices & AR
          </Link>
        }
      />

      <div className="mb-5 grid grid-cols-3 gap-3">
        <Stat label="Total" value={money(total)} />
        <Stat label="Paid" value={money(paid)} tone={paid > 0 ? "good" : "default"} />
        <Stat
          label="Balance"
          value={inv.status === "VOID" ? "—" : money(balance)}
          tone={inv.status === "VOID" ? "default" : balance > 0 ? "warn" : "good"}
        />
      </div>

      {/* Lifecycle actions */}
      <Card className="mb-5">
        <CardBody className="flex flex-wrap items-center gap-3">
          <div className="text-sm text-slate-600">
            Issued {inv.issuedAt ? fmtDate(inv.issuedAt) : "—"} · Due{" "}
            <span className={inv.status === "OVERDUE" ? "font-semibold text-red-600" : undefined}>
              {inv.dueAt ? fmtDate(inv.dueAt) : "—"}
            </span>
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            {isDraft && canEdit ? (
              <form action={markInvoiceSent}>
                <input type="hidden" name="invoiceId" value={inv.id} />
                <Button type="submit" size="sm">
                  📤 Mark sent
                </Button>
              </form>
            ) : null}
            {UNPAID.has(inv.status) && canEdit ? (
              <form action={sendInvoiceReminder}>
                <input type="hidden" name="invoiceId" value={inv.id} />
                <Button type="submit" size="sm" variant="secondary" title="Queues a payment reminder for approval (never sends silently)">
                  ✉️ Send payment reminder
                </Button>
              </form>
            ) : null}
            {isAdmin && inv.status !== "VOID" && inv.status !== "PAID" ? (
              <form action={voidAndDuplicateInvoice}>
                <input type="hidden" name="invoiceId" value={inv.id} />
                <Button type="submit" size="sm" variant="danger" title="Voids this invoice and copies its lines into a new DRAFT — the correction path">
                  ♻️ Void &amp; duplicate as draft
                </Button>
              </form>
            ) : null}
          </div>
          {isDraft && canEdit ? (
            <form action={updateInvoiceDates} className="flex w-full flex-wrap items-end gap-2 border-t border-slate-100 pt-3">
              <input type="hidden" name="invoiceId" value={inv.id} />
              <div className="w-40">
                <Field label="Issued on">
                  <Input name="issuedAt" type="date" defaultValue={toDateInput(inv.issuedAt)} />
                </Field>
              </div>
              <div className="w-40">
                <Field label="Due on">
                  <Input name="dueAt" type="date" defaultValue={toDateInput(inv.dueAt)} />
                </Field>
              </div>
              <Button type="submit" size="sm" variant="secondary">
                Save dates
              </Button>
              <span className="text-[11px] text-slate-400">Dates lock once the invoice is sent.</span>
            </form>
          ) : null}
        </CardBody>
      </Card>

      {/* Line items */}
      <Card className="mb-5">
        <CardHeader
          title="Line items"
          subtitle={isDraft ? "Editable while DRAFT — once sent, money is immutable (void & duplicate to correct)" : "Locked — this invoice has been issued"}
        />
        <CardBody className="p-0">
          {inv.items.length === 0 ? (
            <div className="p-4">
              <EmptyState title="No lines yet" hint="Add from the price book or a custom line below." />
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {inv.items.map((i) => (
                <li key={i.id} className="px-4 py-2.5">
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="text-slate-800">{i.description}</span>
                    <span className="font-medium tabular-nums text-slate-900">{money(Math.round(i.qty * i.unitPriceCents))}</span>
                  </div>
                  {isDraft && canEdit ? (
                    <div className="mt-1 flex items-center gap-1.5 text-xs">
                      <form action={updateInvoiceLine} className="flex items-center gap-1.5">
                        <input type="hidden" name="lineId" value={i.id} />
                        <input name="qty" defaultValue={i.qty} inputMode="decimal" aria-label="Quantity" className="h-7 w-14 rounded-md border border-slate-300 px-1.5 text-xs tabular-nums" />
                        <span>×</span>
                        <input name="price" defaultValue={(i.unitPriceCents / 100).toFixed(2)} inputMode="decimal" aria-label="Unit price ($)" className="h-7 w-20 rounded-md border border-slate-300 px-1.5 text-xs tabular-nums" />
                        <button type="submit" title="Save qty/price" className="rounded-md border border-slate-200 px-1.5 py-0.5 text-xs text-slate-600 hover:bg-slate-50">✓</button>
                      </form>
                      <form action={removeInvoiceLine}>
                        <input type="hidden" name="lineId" value={i.id} />
                        <button type="submit" title="Remove line" className="rounded-md px-1.5 py-0.5 text-xs text-red-500 hover:bg-red-50">✕</button>
                      </form>
                    </div>
                  ) : (
                    <div className="mt-0.5 text-xs text-slate-500">
                      {i.qty} × {money(i.unitPriceCents)}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {isDraft && canEdit ? (
            <div className="space-y-2 border-t border-slate-100 p-4">
              <form action={addInvoiceLine} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="invoiceId" value={inv.id} />
                <div className="min-w-[220px] flex-1">
                  <Field label="Add from price book">
                    <Select name="priceBookItemId" defaultValue="">
                      <option value="" disabled>
                        Choose item…
                      </option>
                      {priceBook.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.category} · {p.name} — {money(p.unitPriceCents)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <div className="w-20">
                  <Field label="Qty">
                    <Input name="qty" defaultValue="1" inputMode="decimal" />
                  </Field>
                </div>
                <div className="w-28">
                  <Field label="$ override">
                    <Input name="price" inputMode="decimal" placeholder="book price" />
                  </Field>
                </div>
                <Button type="submit" size="sm" variant="secondary">
                  ＋ Add item
                </Button>
              </form>
              <form action={addInvoiceLine} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="invoiceId" value={inv.id} />
                <div className="min-w-[220px] flex-1">
                  <Field label="Or a custom line">
                    <Input name="description" placeholder="e.g. After-hours service fee" />
                  </Field>
                </div>
                <div className="w-20">
                  <Field label="Qty">
                    <Input name="qty" defaultValue="1" inputMode="decimal" />
                  </Field>
                </div>
                <div className="w-28">
                  <Field label="Price ($)">
                    <Input name="price" inputMode="decimal" placeholder="150" />
                  </Field>
                </div>
                <Button type="submit" size="sm" variant="secondary">
                  ＋ Add custom
                </Button>
              </form>
            </div>
          ) : null}
        </CardBody>
      </Card>

      <div className="grid gap-5 md:grid-cols-2">
        {/* Payments */}
        <Card>
          <CardHeader title="Payments" subtitle="Every payment records who/when/how — plus a check # or transaction reference" />
          <CardBody className="p-0">
            {inv.payments.length === 0 ? (
              <div className="p-4">
                <EmptyState title="No payments yet" />
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {inv.payments.map((p) => (
                  <li key={p.id} className="flex items-center gap-2 px-4 py-2.5 text-sm">
                    <Badge tone="green">{statusLabel(p.method)}</Badge>
                    <span className="text-slate-700">{fmtDateTime(p.receivedAt)}</span>
                    {p.reference ? <span className="text-xs text-slate-500">ref: {p.reference}</span> : null}
                    <span className="ml-auto font-semibold tabular-nums">{money(p.amountCents)}</span>
                  </li>
                ))}
              </ul>
            )}
            {canTakePayment && UNPAID.has(inv.status) && balance > 0 ? (
              <form action={recordPayment} className="flex flex-wrap items-end gap-2 border-t border-slate-100 p-4">
                <input type="hidden" name="invoiceId" value={inv.id} />
                <div className="w-28">
                  <Field label="Amount ($)">
                    <Input name="amount" type="number" step="0.01" min="0.01" max={(balance / 100).toFixed(2)} defaultValue={(balance / 100).toFixed(2)} required />
                  </Field>
                </div>
                <div className="w-28">
                  <Field label="Method">
                    <Select name="method" defaultValue="CARD">
                      <option value="CARD">Card</option>
                      <option value="ACH">ACH</option>
                      <option value="CASH">Cash</option>
                      <option value="CHECK">Check</option>
                      <option value="FINANCING">Financing</option>
                    </Select>
                  </Field>
                </div>
                <div className="w-36">
                  <Field label="Reference (optional)">
                    <Input name="reference" placeholder="check # / txn id" />
                  </Field>
                </div>
                <Button type="submit" size="sm" variant="success">
                  Record payment
                </Button>
              </form>
            ) : null}
          </CardBody>
        </Card>

        {/* Audit trail */}
        <Card>
          <CardHeader title="Audit trail" subtitle="Every lifecycle event on this invoice" />
          <CardBody>
            {auditRows.length === 0 ? (
              <EmptyState title="No audit events yet" />
            ) : (
              <ul className="space-y-2 text-sm">
                {auditRows.map(({ log, user }) => (
                  <li key={log.id} className="flex items-baseline gap-2">
                    <Badge tone="slate">{log.action}</Badge>
                    <span className="text-xs text-slate-500">
                      {user?.name ?? "system"} · {timeAgo(log.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
