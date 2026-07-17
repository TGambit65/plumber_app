import Link from "next/link";
import { t, withTenant } from "@/db";
import { requireSession } from "@/lib/auth";
import { and, asc, desc, eq, gte, lt, notInArray } from "drizzle-orm";
import { fmtDate, fmtTime, money } from "@/lib/format";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageHeader,
  Stat,
  Table,
  TCell,
  THead,
  TRow,
  buttonClass,
  type BadgeTone,
} from "@/components/ui";

export const dynamic = "force-dynamic";

const commissionTone: Record<string, BadgeTone> = {
  PENDING: "amber",
  APPROVED: "blue",
  PAID: "green",
};

export default async function EarningsPage() {
  const session = await requireSession();
  const period = new Date().toISOString().slice(0, 7); // "2026-07"

  const startOfWeek = new Date();
  startOfWeek.setHours(0, 0, 0, 0);
  startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay()); // Sunday

  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  const startTomorrow = new Date(startToday);
  startTomorrow.setDate(startTomorrow.getDate() + 1);

  const [entries, weekEntries, activeJobs] = await withTenant(session.organizationId, (tx) =>
    Promise.all([
      tx.query.commissionEntries.findMany({
        where: eq(t.commissionEntries.userId, session.userId),
        orderBy: desc(t.commissionEntries.createdAt),
      }),
      tx.query.timeEntries.findMany({
        where: and(eq(t.timeEntries.userId, session.userId), gte(t.timeEntries.startedAt, startOfWeek)),
        with: { job: true },
        orderBy: asc(t.timeEntries.startedAt),
      }),
      tx.query.jobs.findMany({
        where: and(
          eq(t.jobs.assignedToId, session.userId),
          gte(t.jobs.scheduledAt, startToday),
          lt(t.jobs.scheduledAt, startTomorrow),
          notInArray(t.jobs.status, ["COMPLETED", "CANCELLED"])
        ),
        orderBy: asc(t.jobs.scheduledAt),
        limit: 1,
      }),
    ])
  );

  const thisPeriod = entries.filter((e) => e.period === period);
  const sum = (status: string) =>
    thisPeriod.filter((e) => e.status === status).reduce((s, e) => s + e.amountCents, 0);

  const totalWeekMs = weekEntries.reduce((s, te) => {
    const end = te.endedAt ?? new Date();
    return s + (end.getTime() - te.startedAt.getTime());
  }, 0);
  const totalHours = (totalWeekMs / 3600000).toFixed(1);

  const currentJob = activeJobs[0];
  const isTech = session.role === "TECH";

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="💵 My earnings"
        subtitle={`Commission & spiff transparency — ${new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" })}`}
      />

      {/* Period tiles */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Pending this period" value={money(sum("PENDING"))} tone="warn" hint="Awaiting approval" />
        <Stat label="Approved this period" value={money(sum("APPROVED"))} tone="default" hint="Pays with next payroll" />
        <Stat label="Paid this period" value={money(sum("PAID"))} tone="good" hint="Already in your check" />
      </div>

      {/* Spiff explainer */}
      <Card className="mt-4 border-amber-200 bg-amber-50/50">
        <CardBody className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-slate-900">🚩 Spot something? Flag it.</div>
            <p className="mt-0.5 text-sm text-slate-600">
              Flag an opportunity on any job — <span className="font-semibold">$50 spiff</span> when it becomes a
              lead, more if it sells. Water heater sales you flag pay $75.
            </p>
          </div>
          {isTech ? (
            <Link
              href={currentJob ? `/jobs/${currentJob.id}` : "/my-day"}
              className={buttonClass("primary", "lg")}
            >
              ⚠ Flag one from your current job
            </Link>
          ) : null}
        </CardBody>
      </Card>

      {/* Entries */}
      <Card className="mt-4">
        <CardHeader title="Commission & spiff entries" subtitle="Every dollar, visible in real time" />
        <CardBody className="p-0">
          {entries.length === 0 ? (
            <div className="p-4">
              <EmptyState title="No commission entries yet" hint="Flag an opportunity or close a sale to get started." />
            </div>
          ) : (
            <Table>
              <THead cols={["Description", "Amount", "Status", "Date"]} />
              <tbody>
                {entries.map((e) => (
                  <TRow key={e.id}>
                    <TCell>{e.description}</TCell>
                    <TCell className="font-semibold tabular-nums">{money(e.amountCents)}</TCell>
                    <TCell>
                      <Badge tone={commissionTone[e.status]}>{e.status.charAt(0) + e.status.slice(1).toLowerCase()}</Badge>
                    </TCell>
                    <TCell className="whitespace-nowrap text-slate-500">{fmtDate(e.createdAt)}</TCell>
                  </TRow>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>

      {/* Time this week */}
      <Card className="mt-4">
        <CardHeader
          title="My time this week"
          subtitle={`Since ${fmtDate(startOfWeek)}`}
          action={<Badge tone="blue">{totalHours} hrs total</Badge>}
        />
        <CardBody className="p-0">
          {weekEntries.length === 0 ? (
            <div className="p-4">
              <EmptyState title="No time logged this week" hint="Clocks start automatically from job status buttons." />
            </div>
          ) : (
            <Table>
              <THead cols={["Day", "Job", "Kind", "Start – End", "Hours"]} />
              <tbody>
                {weekEntries.map((te) => {
                  const end = te.endedAt ?? new Date();
                  const hrs = ((end.getTime() - te.startedAt.getTime()) / 3600000).toFixed(1);
                  return (
                    <TRow key={te.id}>
                      <TCell className="whitespace-nowrap">{fmtDate(te.startedAt)}</TCell>
                      <TCell>
                        {te.job ? (
                          <Link href={`/jobs/${te.job.id}`} className="text-blue-600 hover:text-blue-800">
                            {te.job.number} · {te.job.jobType}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </TCell>
                      <TCell>{te.kind === "TRAVEL" ? "🚗 Travel" : "🔧 Work"}</TCell>
                      <TCell className="whitespace-nowrap tabular-nums">
                        {fmtTime(te.startedAt)} – {te.endedAt ? fmtTime(te.endedAt) : <Badge tone="green">running</Badge>}
                      </TCell>
                      <TCell className="tabular-nums">{hrs}</TCell>
                    </TRow>
                  );
                })}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
