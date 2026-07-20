import Link from "next/link";
import { t, withTenant } from "@/db";
import { desc, eq, gte } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageHeader,
  Stat,
  THead,
  TCell,
  TRow,
  Table,
  statusLabel,
} from "@/components/ui";
import { WeekBarChart, HBarList } from "@/components/office/charts";
import { lineTotal, money, timeAgo } from "@/lib/format";

export const dynamic = "force-dynamic";

const UNPAID = new Set(["SENT", "PARTIAL", "OVERDUE"]);

/** ISO week key + short label for a date. */
function isoWeek(d: Date): { key: string; label: string } {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { key: `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`, label: `W${week}` };
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: { from?: string; to?: string };
}) {
  const session = await requireSession();
  if (!can(session.role, "reports.company")) {
    return (
      <Card>
        <CardBody>
          <EmptyState
            title="403 — Admin / Owner only"
            hint="Company dashboards are restricted. Ask an owner if you need access."
          />
        </CardBody>
      </Card>
    );
  }

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const days30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const weeks8Start = new Date(now.getTime() - 8 * 7 * 24 * 60 * 60 * 1000);

  // M6: optional custom date range for the revenue tile + CSV export.
  const isDate = (v?: string) => Boolean(v && /^\d{4}-\d{2}-\d{2}$/.test(v));
  const rangeFrom = isDate(searchParams.from) ? new Date(searchParams.from!) : monthStart;
  const rangeTo = isDate(searchParams.to) ? new Date(`${searchParams.to}T23:59:59`) : now;
  const customRange = isDate(searchParams.from) || isDate(searchParams.to);

  const [payments, invoices, leads, jobs, users, timeEntries, photos, reviews, estimates, followUps, projects, membershipRows, auditRows] =
    await withTenant(session.organizationId, (tx) =>
      Promise.all([
        tx.query.payments.findMany(),
        tx.query.invoices.findMany({ with: { items: true, payments: true } }),
        tx.query.leads.findMany(),
        tx.query.jobs.findMany({ columns: { id: true, assignedToId: true, completedAt: true, status: true } }),
        tx.query.users.findMany({ orderBy: (u, { asc }) => [asc(u.name)] }),
        tx.query.timeEntries.findMany({ where: gte(t.timeEntries.startedAt, days30) }),
        tx.query.jobPhotos.findMany({ where: gte(t.jobPhotos.takenAt, days30), columns: { id: true, takenById: true } }),
        tx.query.activities.findMany({ where: eq(t.activities.kind, "REVIEW") }),
        tx.query.estimates.findMany({ with: { options: { with: { items: true } } } }),
        tx.query.followUps.findMany({ with: { lead: true, estimate: true } }),
        tx.query.projects.findMany({ columns: { id: true, status: true } }),
        tx.query.memberships.findMany({ columns: { id: true, status: true } }),
        can(session.role, "audit.view")
          ? tx
              .select({ log: t.auditLogs, user: t.users })
              .from(t.auditLogs)
              .leftJoin(t.users, eq(t.auditLogs.userId, t.users.id))
              .orderBy(desc(t.auditLogs.createdAt))
              .limit(8)
          : Promise.resolve([]),
      ])
    );

  // ── KPIs ──
  const revenueThisMonth = payments
    .filter((p) => new Date(p.receivedAt) >= rangeFrom && new Date(p.receivedAt) <= rangeTo)
    .reduce((s, p) => s + p.amountCents, 0);

  const invComputed = invoices.map((inv) => {
    const total = lineTotal(inv.items);
    const paid = inv.payments.reduce((s, p) => s + p.amountCents, 0);
    return { inv, total, paid, balance: total - paid };
  });
  const openAR = invComputed.filter((c) => UNPAID.has(c.inv.status)).reduce((s, c) => s + c.balance, 0);

  const pipelineValue = leads
    .filter((l) => l.stage !== "WON" && l.stage !== "LOST")
    .reduce((s, l) => s + (l.estValueCents ?? 0), 0);
  const won = leads.filter((l) => l.stage === "WON").length;
  const lost = leads.filter((l) => l.stage === "LOST").length;
  const closeRate = won + lost > 0 ? Math.round((won / (won + lost)) * 100) : 0;

  const paidInvoices = invComputed.filter((c) => c.inv.status === "PAID" && c.total > 0);
  const avgTicket = paidInvoices.length > 0 ? Math.round(paidInvoices.reduce((s, c) => s + c.total, 0) / paidInvoices.length) : 0;

  const jobsCompletedMonth = jobs.filter((j) => j.completedAt && new Date(j.completedAt) >= monthStart).length;
  const activeProjects = projects.filter((p) => p.status === "ACTIVE").length;
  const activeMemberships = membershipRows.filter((m) => m.status === "ACTIVE").length;

  // ── Revenue by ISO week (last 8) ──
  const weeks: { key: string; label: string; valueCents: number }[] = [];
  for (let i = 7; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 7 * 24 * 60 * 60 * 1000);
    const w = isoWeek(d);
    weeks.push({ key: w.key, label: w.label, valueCents: 0 });
  }
  for (const p of payments) {
    const at = new Date(p.receivedAt);
    if (at < weeks8Start) continue;
    const w = isoWeek(at);
    const bucket = weeks.find((x) => x.key === w.key);
    if (bucket) bucket.valueCents += p.amountCents;
  }

  // ── Lead sources ──
  const sourceMap = new Map<string, { count: number; value: number }>();
  for (const l of leads) {
    const cur = sourceMap.get(l.source) ?? { count: 0, value: 0 };
    cur.count += 1;
    cur.value += l.estValueCents ?? 0;
    sourceMap.set(l.source, cur);
  }
  const sourceRows = Array.from(sourceMap.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .map(([source, v]) => ({
      label: statusLabel(source),
      value: v.count,
      display: `${v.count} lead${v.count === 1 ? "" : "s"}`,
      hint: money(v.value),
    }));

  // ── Tech scoreboard ──
  const techs = users.filter((u) => u.role === "TECH");
  const techRows = techs.map((tech) => {
    const completed30 = jobs.filter(
      (j) => j.assignedToId === tech.id && j.completedAt && new Date(j.completedAt) >= days30
    ).length;
    const hours = timeEntries
      .filter((te) => te.userId === tech.id && te.endedAt)
      .reduce((s, te) => s + (new Date(te.endedAt as Date).getTime() - new Date(te.startedAt).getTime()) / 3600000, 0);
    const photoCount = photos.filter((p) => p.takenById === tech.id).length;
    const photosPerJob = completed30 > 0 ? photoCount / completed30 : 0;
    const reviewMentions = reviews.filter((r) => r.userId === tech.id).length;
    return { tech, completed30, hours, photosPerJob, reviewMentions };
  });

  // ── Sales scoreboard ──
  const salesUsers = users.filter((u) => u.role === "SALES_PM");
  const salesRows = salesUsers.map((su) => {
    const myLeads = leads.filter((l) => l.assignedToId === su.id);
    const myWon = myLeads.filter((l) => l.stage === "WON").length;
    const myLost = myLeads.filter((l) => l.stage === "LOST").length;
    const myEstimates = estimates.filter((e) => e.createdById === su.id);
    const approvedValue = myEstimates
      .filter((e) => e.status === "APPROVED")
      .reduce((s, e) => {
        const opt = e.options.find((o) => o.selected) ?? e.options[0];
        return s + (opt ? lineTotal(opt.items) : 0);
      }, 0);
    const optionsAvg =
      myEstimates.length > 0 ? myEstimates.reduce((s, e) => s + e.options.length, 0) / myEstimates.length : 0;
    const myFollowUps = followUps.filter(
      (f) => f.estimate?.createdById === su.id || f.lead?.assignedToId === su.id
    );
    const sent = myFollowUps.filter((f) => f.status === "SENT").length;
    return { user: su, won: myWon, lost: myLost, approvedValue, optionsAvg, sent, totalFollowUps: myFollowUps.length };
  });

  // ── AR aging ──
  const aging = { current: 0, d1_30: 0, d31_60: 0, d60plus: 0 };
  for (const c of invComputed) {
    if (!UNPAID.has(c.inv.status) || c.balance <= 0) continue;
    const due = c.inv.dueAt ? new Date(c.inv.dueAt) : null;
    const daysPast = due ? Math.floor((now.getTime() - due.getTime()) / 86400000) : 0;
    if (!due || daysPast <= 0) aging.current += c.balance;
    else if (daysPast <= 30) aging.d1_30 += c.balance;
    else if (daysPast <= 60) aging.d31_60 += c.balance;
    else aging.d60plus += c.balance;
  }

  return (
    <div>
      <PageHeader
        title="Company dashboard"
        subtitle="Owner overview — revenue, pipeline, crew performance, AR health."
        action={
          <form method="GET" action="/dashboard" className="flex flex-wrap items-end gap-1.5">
            <input
              type="date"
              name="from"
              defaultValue={isDate(searchParams.from) ? searchParams.from : ""}
              aria-label="From date"
              className="h-8 rounded-lg border border-slate-300 px-2 text-xs"
            />
            <input
              type="date"
              name="to"
              defaultValue={isDate(searchParams.to) ? searchParams.to : ""}
              aria-label="To date"
              className="h-8 rounded-lg border border-slate-300 px-2 text-xs"
            />
            <button type="submit" className="h-8 rounded-lg border border-slate-300 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
              Apply range
            </button>
            <a
              href={`/api/export/payments?from=${rangeFrom.toISOString().slice(0, 10)}&to=${rangeTo.toISOString().slice(0, 10)}`}
              className="h-8 rounded-lg bg-slate-800 px-2.5 text-xs font-medium leading-8 text-white hover:bg-slate-700"
              title="CSV of every payment in the range — invoice, customer, method, reference"
            >
              ⬇ Export CSV
            </a>
          </form>
        }
      />

      {/* KPI tiles */}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={customRange ? "Revenue in range" : "Revenue this month"} value={money(revenueThisMonth)} tone="good" hint="payments received" />
        <Stat label="Open AR" value={money(openAR)} tone={openAR > 0 ? "warn" : "good"} hint="unpaid invoice balances" />
        <Stat label="Pipeline value" value={money(pipelineValue)} hint="open leads" />
        <Stat label="Close rate" value={`${closeRate}%`} hint={`${won} won / ${lost} lost`} />
        <Stat label="Avg ticket" value={money(avgTicket)} hint="paid invoices" />
        <Stat label="Jobs completed" value={jobsCompletedMonth} hint="this month" />
        <Stat label="Active projects" value={activeProjects} />
        <Stat label="Memberships" value={activeMemberships} tone="good" hint="active plans" />
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Revenue by week" subtitle="Payments received, last 8 ISO weeks" />
          <CardBody>
            <WeekBarChart data={weeks.map((w) => ({ label: w.label, valueCents: w.valueCents }))} ariaLabel="Bar chart of weekly revenue for the last 8 ISO weeks" />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Lead sources" subtitle="Count and estimated value per source" />
          <CardBody>
            <HBarList rows={sourceRows} />
          </CardBody>
        </Card>
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Tech scoreboard" subtitle="Last 30 days" />
          <CardBody>
            {techRows.length === 0 ? (
              <EmptyState title="No technicians yet" />
            ) : (
              <Table>
                <THead cols={["Tech", "Jobs done", "Hours", "Photos/job", "Review mentions"]} />
                <tbody>
                  {techRows.map((r) => (
                    <TRow key={r.tech.id}>
                      <TCell>
                        <Link href={`/jobs?tech=${r.tech.id}`} className="font-medium text-blue-700 hover:underline" title="Drill through to this tech's jobs">
                          {r.tech.name}
                        </Link>
                      </TCell>
                      <TCell>{r.completed30}</TCell>
                      <TCell className="tabular-nums">{r.hours.toFixed(1)}h</TCell>
                      <TCell className="tabular-nums">{r.photosPerJob.toFixed(1)}</TCell>
                      <TCell>{r.reviewMentions > 0 ? `⭐ ${r.reviewMentions}` : "—"}</TCell>
                    </TRow>
                  ))}
                </tbody>
              </Table>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Sales scoreboard" subtitle="Pipeline discipline per salesperson / PM" />
          <CardBody>
            {salesRows.length === 0 ? (
              <EmptyState title="No sales users yet" />
            ) : (
              <Table>
                <THead cols={["Rep", "Won / Lost", "Approved value", "Options/est", "Follow-up compliance"]} />
                <tbody>
                  {salesRows.map((r) => (
                    <TRow key={r.user.id}>
                      <TCell>
                        <Link href={`/commissions?user=${r.user.id}`} className="font-medium text-blue-700 hover:underline" title="Drill through to this rep's commissions">
                          {r.user.name}
                        </Link>
                      </TCell>
                      <TCell>
                        <span className="text-emerald-600">{r.won}</span> / <span className="text-red-600">{r.lost}</span>
                      </TCell>
                      <TCell className="tabular-nums">{money(r.approvedValue)}</TCell>
                      <TCell className="tabular-nums">{r.optionsAvg.toFixed(1)}</TCell>
                      <TCell className="tabular-nums">
                        {r.totalFollowUps > 0 ? `${r.sent}/${r.totalFollowUps} sent` : "—"}
                      </TCell>
                    </TRow>
                  ))}
                </tbody>
              </Table>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="AR aging" subtitle="Unpaid balances by days past due" />
          <CardBody>
            <HBarList
              rows={[
                { label: "Current", value: aging.current, display: money(aging.current) },
                { label: "1–30 days", value: aging.d1_30, display: money(aging.d1_30) },
                { label: "31–60 days", value: aging.d31_60, display: money(aging.d31_60) },
                { label: "60+ days", value: aging.d60plus, display: money(aging.d60plus) },
              ]}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Recent audit log" subtitle="Sensitive actions — who did what" />
          <CardBody>
            {auditRows.length === 0 ? (
              <EmptyState title="No audit entries" />
            ) : (
              <ul className="space-y-2">
                {auditRows.map(({ log, user }) => (
                  <li key={log.id} className="flex items-baseline justify-between gap-3 border-b border-slate-100 pb-2 text-sm">
                    <span className="min-w-0">
                      <span className="font-medium text-slate-800">{user?.name ?? "System"}</span>{" "}
                      <span className="text-slate-500">
                        {log.action.toLowerCase().replaceAll("_", " ")} · {log.entity}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-slate-400">{timeAgo(log.createdAt)}</span>
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
