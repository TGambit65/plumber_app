import Link from "next/link";
import { db, t } from "@/db";
import { and, eq, lt } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { markInvoiceSent, recordPayment, voidInvoice } from "@/lib/actions/office";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  PageHeader,
  Select,
  Stat,
  THead,
  TCell,
  TRow,
  Table,
  buttonClass,
  invoiceStatusTone,
  statusLabel,
} from "@/components/ui";
import { fmtDate, lineTotal, money } from "@/lib/format";

export const dynamic = "force-dynamic";

const STATUSES = ["DRAFT", "SENT", "PARTIAL", "PAID", "OVERDUE", "VOID"] as const;
type InvoiceStatus = (typeof STATUSES)[number];
const UNPAID = new Set<string>(["SENT", "PARTIAL", "OVERDUE"]);

export default async function InvoicesPage({ searchParams }: { searchParams: { status?: string; q?: string } }) {
  const session = await requireSession();

  // Cheap sweep: mark any SENT invoice past due as OVERDUE before querying.
  await db
    .update(t.invoices)
    .set({ status: "OVERDUE" })
    .where(and(eq(t.invoices.status, "SENT"), lt(t.invoices.dueAt, new Date())));

  const statusFilter = (STATUSES as readonly string[]).includes(searchParams.status ?? "")
    ? (searchParams.status as InvoiceStatus)
    : undefined;

  const invoices = await db.query.invoices.findMany({
    with: { customer: true, job: true, project: true, items: true, payments: true },
    orderBy: (i, { desc: d }) => [d(i.createdAt)],
  });

  const computed = invoices.map((inv) => {
    const total = lineTotal(inv.items);
    const paid = inv.payments.reduce((s, p) => s + p.amountCents, 0);
    return { inv, total, paid, balance: total - paid };
  });

  // Stats over all invoices (pre-filter)
  const outstanding = computed.filter((c) => UNPAID.has(c.inv.status)).reduce((s, c) => s + c.balance, 0);
  const overdueRows = computed.filter((c) => c.inv.status === "OVERDUE");
  const overdueTotal = overdueRows.reduce((s, c) => s + c.balance, 0);
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const paidThisMonth = computed.reduce(
    (s, c) => s + c.inv.payments.filter((p) => new Date(p.receivedAt) >= monthStart).reduce((a, p) => a + p.amountCents, 0),
    0
  );
  const billable = computed.filter((c) => c.inv.status !== "DRAFT" && c.inv.status !== "VOID");
  const billedTotal = billable.reduce((s, c) => s + c.total, 0);
  const collected = billable.reduce((s, c) => s + Math.min(c.paid, c.total), 0);
  const collectedRate = billedTotal > 0 ? Math.round((collected / billedTotal) * 100) : 0;

  const q = searchParams.q?.trim().toLowerCase();
  const rows = computed.filter(
    (c) =>
      (!statusFilter || c.inv.status === statusFilter) &&
      (!q || c.inv.number.toLowerCase().includes(q) || c.inv.customer.name.toLowerCase().includes(q))
  );
  const canTakePayment = can(session.role, "payments.take");
  const isAdmin = session.role === "ADMIN";

  return (
    <div>
      <PageHeader title="Invoices & AR" subtitle="Accounts receivable — record payments, chase overdue balances." />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Outstanding" value={money(outstanding)} tone={outstanding > 0 ? "warn" : "good"} hint="sent · partial · overdue" />
        <Stat label="Overdue" value={money(overdueTotal)} tone={overdueRows.length > 0 ? "bad" : "good"} hint={`${overdueRows.length} invoice${overdueRows.length === 1 ? "" : "s"}`} />
        <Stat label="Paid this month" value={money(paidThisMonth)} tone="good" />
        <Stat label="Collected rate" value={`${collectedRate}%`} hint="of billed total" />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <Link href="/invoices" className={buttonClass(statusFilter ? "ghost" : "secondary", "sm")}>
          All
        </Link>
        {STATUSES.map((s) => (
          <Link key={s} href={`/invoices?status=${s}`} className={buttonClass(statusFilter === s ? "secondary" : "ghost", "sm")}>
            {statusLabel(s)}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyState title="No invoices here" hint={statusFilter ? `Nothing in ${statusLabel(statusFilter)}.` : "Invoices appear as jobs and projects are billed."} />
      ) : (
        <Card>
          <Table>
            <THead cols={["Number", "Customer", "Ref", "Issued", "Due", "Total", "Paid", "Balance", "Status", "Actions"]} />
            <tbody>
              {rows.map(({ inv, total, paid, balance }) => (
                <TRow key={inv.id} className={inv.status === "OVERDUE" ? "bg-red-50/60" : undefined}>
                  <TCell>
                    <span className="font-medium">{inv.number}</span>
                  </TCell>
                  <TCell>
                    <Link href={`/customers/${inv.customerId}`} className="text-blue-700 hover:underline">
                      {inv.customer.name}
                    </Link>
                  </TCell>
                  <TCell>
                    {inv.job ? (
                      <Link href={`/jobs/${inv.job.id}`} className="text-xs text-blue-700 hover:underline">
                        🔧 {inv.job.number}
                      </Link>
                    ) : inv.project ? (
                      <span className="text-xs text-slate-500">🏗️ {inv.project.name}</span>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </TCell>
                  <TCell>{inv.issuedAt ? fmtDate(inv.issuedAt) : "—"}</TCell>
                  <TCell className={inv.status === "OVERDUE" ? "font-medium text-red-600" : undefined}>
                    {inv.dueAt ? fmtDate(inv.dueAt) : "—"}
                  </TCell>
                  <TCell className="tabular-nums">{money(total)}</TCell>
                  <TCell className="tabular-nums">{money(paid)}</TCell>
                  <TCell className="tabular-nums font-medium">{inv.status === "VOID" ? "—" : money(balance)}</TCell>
                  <TCell>
                    <Badge tone={invoiceStatusTone[inv.status]}>{statusLabel(inv.status)}</Badge>
                  </TCell>
                  <TCell>
                    <div className="flex flex-col gap-1.5">
                      {canTakePayment && UNPAID.has(inv.status) && balance > 0 ? (
                        <form action={recordPayment} className="flex items-center gap-1">
                          <input type="hidden" name="invoiceId" value={inv.id} />
                          <Input
                            name="amount"
                            type="number"
                            step="0.01"
                            min="0.01"
                            max={(balance / 100).toFixed(2)}
                            defaultValue={(balance / 100).toFixed(2)}
                            aria-label="Payment amount"
                            className="h-8 w-24 text-xs"
                            required
                          />
                          <Select name="method" defaultValue="CARD" aria-label="Payment method" className="h-8 w-24 text-xs">
                            <option value="CARD">Card</option>
                            <option value="ACH">ACH</option>
                            <option value="CASH">Cash</option>
                            <option value="CHECK">Check</option>
                            <option value="FINANCING">Financing</option>
                          </Select>
                          <Button type="submit" size="sm" variant="success">
                            Record
                          </Button>
                        </form>
                      ) : null}
                      <div className="flex gap-1.5">
                        {inv.status === "DRAFT" ? (
                          <form action={markInvoiceSent}>
                            <input type="hidden" name="invoiceId" value={inv.id} />
                            <Button type="submit" size="sm" variant="secondary">
                              Mark sent
                            </Button>
                          </form>
                        ) : null}
                        {isAdmin && inv.status !== "VOID" && inv.status !== "PAID" ? (
                          <form action={voidInvoice}>
                            <input type="hidden" name="invoiceId" value={inv.id} />
                            <Button type="submit" size="sm" variant="danger">
                              Void
                            </Button>
                          </form>
                        ) : null}
                      </div>
                    </div>
                  </TCell>
                </TRow>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}
