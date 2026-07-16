import Link from "next/link";
import { redirect } from "next/navigation";
import { db, t } from "@/db";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { asc, desc, eq } from "drizzle-orm";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageHeader,
  Select,
  Stat,
  Table,
  TCell,
  THead,
  TRow,
  type BadgeTone,
} from "@/components/ui";
import { money, fmtDate } from "@/lib/format";
import { rejectCommission, setCommissionStatus } from "@/lib/actions/shared";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, BadgeTone> = {
  PENDING: "amber",
  APPROVED: "blue",
  PAID: "green",
};

const KIND_LABEL: Record<string, string> = {
  PERCENT_REVENUE: "% of revenue",
  PERCENT_MARGIN: "% of margin",
  SPIFF: "Flat spiff",
};

export default async function CommissionsPage({
  searchParams,
}: {
  searchParams: { user?: string; status?: string };
}) {
  const session = await requireSession();
  if (!can(session.role, "commissions.view.all")) redirect("/earnings");

  const [entries, rules, users] = await Promise.all([
    db.query.commissionEntries.findMany({
      with: { user: true },
      orderBy: [desc(t.commissionEntries.createdAt)],
    }),
    db.select().from(t.commissionRules).where(eq(t.commissionRules.active, true)),
    db.select().from(t.users).where(eq(t.users.active, true)).orderBy(asc(t.users.name)),
  ]);

  const currentPeriod = new Date().toISOString().slice(0, 7);
  const pendingTotal = entries.filter((e) => e.status === "PENDING").reduce((s, e) => s + e.amountCents, 0);
  const approvedTotal = entries.filter((e) => e.status === "APPROVED").reduce((s, e) => s + e.amountCents, 0);
  const paidThisPeriod = entries
    .filter((e) => e.status === "PAID" && e.period === currentPeriod)
    .reduce((s, e) => s + e.amountCents, 0);

  const userFilter = (searchParams.user ?? "").trim();
  const statusFilter = ["PENDING", "APPROVED", "PAID"].includes(searchParams.status ?? "")
    ? searchParams.status
    : "";
  const filtered = entries.filter(
    (e) => (!userFilter || e.userId === userFilter) && (!statusFilter || e.status === statusFilter)
  );

  // Per-user summary
  const byUser = new Map<string, { name: string; pending: number; approved: number; paid: number }>();
  for (const e of entries) {
    const row = byUser.get(e.userId) ?? { name: e.user.name, pending: 0, approved: 0, paid: 0 };
    if (e.status === "PENDING") row.pending += e.amountCents;
    else if (e.status === "APPROVED") row.approved += e.amountCents;
    else row.paid += e.amountCents;
    byUser.set(e.userId, row);
  }
  const summary = Array.from(byUser.entries())
    .map(([userId, r]) => ({ userId, ...r, total: r.pending + r.approved + r.paid }))
    .sort((a, b) => b.total - a.total);

  return (
    <div className="space-y-5">
      <PageHeader
        title="💵 Commissions"
        subtitle="Company-wide commissions & spiffs — approve, pay, and reconcile by period"
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Pending approval" value={money(pendingTotal)} tone={pendingTotal > 0 ? "warn" : "default"} hint={`${entries.filter((e) => e.status === "PENDING").length} entries`} />
        <Stat label="Approved, unpaid" value={money(approvedTotal)} hint="Pays with next payroll" />
        <Stat label={`Paid — ${currentPeriod}`} value={money(paidThisPeriod)} tone="good" />
      </div>

      <Card>
        <CardHeader
          title="Entries"
          subtitle={`${filtered.length} of ${entries.length} shown`}
          action={
            <form method="GET" action="/commissions" className="flex items-center gap-2">
              <Select name="user" defaultValue={userFilter} className="h-8 w-40 text-xs">
                <option value="">All users</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
              <Select name="status" defaultValue={statusFilter} className="h-8 w-32 text-xs">
                <option value="">All statuses</option>
                <option value="PENDING">Pending</option>
                <option value="APPROVED">Approved</option>
                <option value="PAID">Paid</option>
              </Select>
              <Button type="submit" size="sm" variant="secondary">
                Filter
              </Button>
            </form>
          }
        />
        <CardBody className="p-0">
          {filtered.length === 0 ? (
            <div className="p-4">
              <EmptyState title="No commission entries match" hint="Clear the filters or wait for new sales." />
            </div>
          ) : (
            <Table>
              <THead cols={["User", "Description", "Period", "Amount", "Status", "Created", "Actions"]} />
              <tbody>
                {filtered.map((e) => (
                  <TRow key={e.id}>
                    <TCell className="font-medium text-slate-900">{e.user.name}</TCell>
                    <TCell className="max-w-md">{e.description}</TCell>
                    <TCell className="tabular-nums">{e.period}</TCell>
                    <TCell className="tabular-nums font-semibold">{money(e.amountCents)}</TCell>
                    <TCell>
                      <Badge tone={STATUS_TONE[e.status] ?? "slate"}>{e.status}</Badge>
                    </TCell>
                    <TCell className="text-xs text-slate-500">{fmtDate(e.createdAt)}</TCell>
                    <TCell>
                      <div className="flex flex-wrap gap-1.5">
                        {e.status === "PENDING" ? (
                          <form action={setCommissionStatus}>
                            <input type="hidden" name="id" value={e.id} />
                            <input type="hidden" name="status" value="APPROVED" />
                            <Button type="submit" size="sm" variant="success">
                              Approve
                            </Button>
                          </form>
                        ) : null}
                        {e.status === "APPROVED" ? (
                          <form action={setCommissionStatus}>
                            <input type="hidden" name="id" value={e.id} />
                            <input type="hidden" name="status" value="PAID" />
                            <Button type="submit" size="sm" variant="secondary">
                              Mark paid
                            </Button>
                          </form>
                        ) : null}
                        {e.status !== "PAID" ? (
                          <form action={rejectCommission}>
                            <input type="hidden" name="id" value={e.id} />
                            <Button type="submit" size="sm" variant="ghost">
                              Reject
                            </Button>
                          </form>
                        ) : null}
                      </div>
                    </TCell>
                  </TRow>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Per-user summary" subtitle="All periods" />
          <CardBody className="p-0">
            {summary.length === 0 ? (
              <div className="p-4">
                <EmptyState title="No commission activity yet" />
              </div>
            ) : (
              <Table>
                <THead cols={["User", "Pending", "Approved", "Paid", "Total"]} />
                <tbody>
                  {summary.map((r) => (
                    <TRow key={r.userId}>
                      <TCell>
                        <Link href={`/commissions?user=${r.userId}`} className="font-medium text-blue-600 hover:underline">
                          {r.name}
                        </Link>
                      </TCell>
                      <TCell className="tabular-nums">{money(r.pending)}</TCell>
                      <TCell className="tabular-nums">{money(r.approved)}</TCell>
                      <TCell className="tabular-nums">{money(r.paid)}</TCell>
                      <TCell className="tabular-nums font-semibold">{money(r.total)}</TCell>
                    </TRow>
                  ))}
                </tbody>
              </Table>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="📐 Active commission rules"
            action={
              <Link href="/settings?tab=commissions" className="text-xs font-medium text-blue-600 hover:underline">
                Manage rules →
              </Link>
            }
          />
          <CardBody>
            {rules.length === 0 ? (
              <EmptyState title="No active rules" hint="Configure rules in Settings → Commissions." />
            ) : (
              <ul className="divide-y divide-slate-100">
                {rules.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div>
                      <p className="text-sm font-medium text-slate-800">{r.name}</p>
                      <p className="text-xs text-slate-500">
                        {KIND_LABEL[r.kind] ?? r.kind}
                        {r.role ? ` · ${r.role}` : ""}
                        {r.category ? ` · ${r.category}` : ""}
                      </p>
                    </div>
                    <Badge tone="blue">{r.kind === "SPIFF" ? money(r.rate) : `${r.rate}%`}</Badge>
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
