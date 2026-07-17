import Link from "next/link";
import { db, t } from "@/db";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { money, timeAgo, fmtTime } from "@/lib/format";
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, PageHeader, Stat, leadStageTone, statusLabel } from "@/components/ui";
import { Forbidden, SlaBadge, commissionStatusTone } from "@/components/sales/meta";
import { markFollowUpSent, skipFollowUp } from "@/lib/actions/sales";

export const dynamic = "force-dynamic";

const OPEN_STAGES = ["NEW", "CONTACTED", "ESTIMATE_SCHEDULED", "ESTIMATE_SENT", "FOLLOW_UP"] as const;

export default async function CockpitPage() {
  const session = await requireSession();
  if (!can(session.role, "pipeline.manage")) return <Forbidden />;

  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  const period = new Date().toISOString().slice(0, 7);

  const [followUpsDue, hotEstimates, myLeads, commissions] = await Promise.all([
    db.query.followUps.findMany({
      where: and(eq(t.followUps.status, "PENDING"), lte(t.followUps.dueAt, endOfToday)),
      with: { lead: true, estimate: { with: { customer: true } } },
      orderBy: [t.followUps.dueAt],
    }),
    db.query.estimates.findMany({
      where: and(gte(t.estimates.viewCount, 2), inArray(t.estimates.status, ["SENT", "VIEWED"])),
      with: { customer: true },
      orderBy: [desc(t.estimates.lastViewedAt)],
    }),
    db.query.leads.findMany({
      where: eq(t.leads.assignedToId, session.userId),
    }),
    db.query.commissionEntries.findMany({
      where: and(eq(t.commissionEntries.userId, session.userId), eq(t.commissionEntries.period, period)),
      orderBy: [desc(t.commissionEntries.createdAt)],
    }),
  ]);

  // Follow-ups relevant to me (my leads or my estimates)
  const myFollowUps = followUpsDue.filter(
    (f) => f.lead?.assignedToId === session.userId || f.estimate?.createdById === session.userId
  );

  const myHotEstimates = hotEstimates.filter((e) => e.createdById === session.userId);

  // SLA leads: assigned to me, not yet touched, with a respond-by timer
  const slaLeads = myLeads
    .filter((l) => !l.firstTouchAt && l.respondBy && !["WON", "LOST"].includes(l.stage))
    .sort((a, b) => new Date(a.respondBy!).getTime() - new Date(b.respondBy!).getTime());

  // Pipeline value by stage (my open leads)
  const openLeads = myLeads.filter((l) => (OPEN_STAGES as readonly string[]).includes(l.stage));
  const pipelineValue = openLeads.reduce((s, l) => s + (l.estValueCents ?? 0), 0);
  const byStage = OPEN_STAGES.map((stage) => {
    const rows = openLeads.filter((l) => l.stage === stage);
    return { stage, count: rows.length, value: rows.reduce((s, l) => s + (l.estValueCents ?? 0), 0) };
  });
  const maxStageValue = Math.max(1, ...byStage.map((s) => s.value));

  // Commission this period grouped by status
  const commissionTotal = commissions.reduce((s, c) => s + c.amountCents, 0);
  const commissionByStatus = (["PENDING", "APPROVED", "PAID"] as const).map((status) => ({
    status,
    total: commissions.filter((c) => c.status === status).reduce((s, c) => s + c.amountCents, 0),
    count: commissions.filter((c) => c.status === status).length,
  }));

  const hotCount = myHotEstimates.length + slaLeads.length;

  return (
    <div>
      <PageHeader
        title={`🎯 Sales cockpit`}
        subtitle={`Good ${new Date().getHours() < 12 ? "morning" : "afternoon"}, ${session.name.split(" ")[0]} — here's what moves the needle today.`}
      />

      {/* Stat tiles */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Pipeline value" value={money(pipelineValue)} hint={`${openLeads.length} open leads`} />
        <Stat
          label="Follow-ups due"
          value={myFollowUps.length}
          tone={myFollowUps.length > 0 ? "warn" : "good"}
          hint="due by end of today"
        />
        <Stat label="Hot leads" value={hotCount} tone={hotCount > 0 ? "bad" : "default"} hint="engaged or SLA at risk" />
        <Stat label="Commission this month" value={money(commissionTotal)} tone="good" hint={period} />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* Left: follow-ups + hot signals */}
        <div className="space-y-5">
          <Card>
            <CardHeader title="📬 Follow-ups due today" subtitle="One click marks the touch as sent" />
            <CardBody className="p-0">
              {myFollowUps.length === 0 ? (
                <div className="p-4">
                  <EmptyState title="All caught up" hint="No pending follow-ups due today." />
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {myFollowUps.map((f) => {
                    const overdue = new Date(f.dueAt).getTime() < Date.now();
                    const target = f.estimate
                      ? { href: `/estimates/${f.estimate.id}`, label: `${f.estimate.number} · ${f.estimate.customer.name}` }
                      : f.lead
                        ? { href: `/leads/${f.lead.id}`, label: f.lead.title }
                        : null;
                    return (
                      <li key={f.id} className="px-4 py-3">
                        <div className="flex items-start gap-2">
                          <Badge tone={f.channel === "SMS" ? "cyan" : f.channel === "EMAIL" ? "violet" : "blue"}>
                            {f.channel === "SMS" ? "💬" : f.channel === "EMAIL" ? "✉️" : "📞"} {f.channel}
                          </Badge>
                          <div className="min-w-0 flex-1">
                            <p className="line-clamp-2 text-sm text-slate-800 sm:truncate">{f.body}</p>
                            <p className="mt-0.5 text-xs text-slate-500">
                              {target ? (
                                <Link href={target.href} className="text-blue-600 hover:underline">
                                  {target.label}
                                </Link>
                              ) : null}
                              <span className={overdue ? "ml-2 font-medium text-red-600" : "ml-2"}>
                                due {fmtTime(f.dueAt)} {overdue ? "· overdue" : ""}
                              </span>
                            </p>
                          </div>
                        </div>
                        {/* Actions on their own row on phones — full-width thumb targets */}
                        <div className="mt-2 flex items-center gap-2">
                          <form action={markFollowUpSent} className="flex-1 sm:flex-none">
                            <input type="hidden" name="followUpId" value={f.id} />
                            <Button size="sm" variant="success" className="h-10 w-full sm:h-8 sm:w-auto">
                              ✓ Mark sent
                            </Button>
                          </form>
                          <form action={skipFollowUp}>
                            <input type="hidden" name="followUpId" value={f.id} />
                            <Button size="sm" variant="ghost" title="Skip this touch" className="h-10 sm:h-8">
                              Skip
                            </Button>
                          </form>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="🔥 Hot signals" subtitle="Engaged estimates & SLA timers — act now" />
            <CardBody className="p-0">
              {myHotEstimates.length === 0 && slaLeads.length === 0 ? (
                <div className="p-4">
                  <EmptyState title="No hot signals right now" />
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {myHotEstimates.map((e) => (
                    <li key={e.id} className="flex items-center gap-3 px-4 py-3">
                      <span className="text-lg">👁</span>
                      <div className="min-w-0 flex-1">
                        <Link href={`/estimates/${e.id}`} className="text-sm font-medium text-slate-800 hover:text-blue-600">
                          {e.customer.name} opened {e.number} — {e.viewCount}x
                        </Link>
                        <p className="text-xs text-slate-500">
                          last viewed {e.lastViewedAt ? timeAgo(e.lastViewedAt) : "—"} · call while it&apos;s top of mind
                        </p>
                      </div>
                      <Badge tone="amber">{e.viewCount} views</Badge>
                    </li>
                  ))}
                  {slaLeads.map((l) => (
                    <li key={l.id} className="flex items-center gap-3 px-4 py-3">
                      <span className="text-lg">⏱️</span>
                      <div className="min-w-0 flex-1">
                        <Link href={`/leads/${l.id}`} className="text-sm font-medium text-slate-800 hover:text-blue-600">
                          {l.title}
                        </Link>
                        <p className="text-xs text-slate-500">
                          {l.contactName} · {money(l.estValueCents)}
                        </p>
                      </div>
                      <SlaBadge respondBy={l.respondBy} firstTouchAt={l.firstTouchAt} />
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>

        {/* Right: pipeline by stage + commission */}
        <div className="space-y-5">
          <Card>
            <CardHeader
              title="📊 My pipeline by stage"
              subtitle={`${money(pipelineValue)} across ${openLeads.length} open leads`}
              action={
                <Link href="/pipeline" className="text-xs font-medium text-blue-600 hover:underline">
                  Open board →
                </Link>
              }
            />
            <CardBody>
              {openLeads.length === 0 ? (
                <EmptyState title="No open leads assigned to you" hint="New leads land here as they're assigned." />
              ) : (
                <div className="space-y-3">
                  {byStage.map((s) => (
                    <div key={s.stage}>
                      <div className="flex items-center justify-between text-xs">
                        <span className="flex items-center gap-2">
                          <Badge tone={leadStageTone[s.stage]}>{statusLabel(s.stage)}</Badge>
                          <span className="text-slate-500">{s.count}</span>
                        </span>
                        <span className="font-medium tabular-nums text-slate-700">{money(s.value)}</span>
                      </div>
                      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-slate-100">
                        <div
                          className="h-full rounded-full bg-blue-500"
                          style={{ width: `${Math.round((s.value / maxStageValue) * 100)}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="💵 Commission this period"
              subtitle={`What you've earned in ${period} — updated in real time`}
              action={
                <Link href="/earnings" className="text-xs font-medium text-blue-600 hover:underline">
                  Earnings →
                </Link>
              }
            />
            <CardBody className="p-0">
              <div className="grid grid-cols-3 divide-x divide-slate-100 border-b border-slate-100">
                {commissionByStatus.map((c) => (
                  <div key={c.status} className="px-4 py-3 text-center">
                    <div className="text-lg font-semibold tabular-nums text-slate-900">{money(c.total)}</div>
                    <Badge tone={commissionStatusTone[c.status]}>{statusLabel(c.status)}</Badge>
                  </div>
                ))}
              </div>
              {commissions.length === 0 ? (
                <div className="p-4">
                  <EmptyState title="No commission yet this period" hint="Close a deal — approved estimates earn 5% automatically." />
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {commissions.slice(0, 6).map((c) => (
                    <li key={c.id} className="flex items-center gap-3 px-4 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-slate-800">{c.description}</p>
                        <p className="text-xs text-slate-500">{timeAgo(c.createdAt)}</p>
                      </div>
                      <span className="text-sm font-semibold tabular-nums text-emerald-600">{money(c.amountCents)}</span>
                      <Badge tone={commissionStatusTone[c.status]}>{statusLabel(c.status)}</Badge>
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
