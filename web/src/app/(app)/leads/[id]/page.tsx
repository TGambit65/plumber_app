import Link from "next/link";
import { notFound } from "next/navigation";
import { t, withTenant } from "@/db";
import { eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { fmtDateTime, money, timeAgo, lineTotal } from "@/lib/format";
import {
  Avatar,
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
  Textarea,
  estimateStatusTone,
  leadStageTone,
  statusLabel,
} from "@/components/ui";
import { Forbidden, SlaBadge, SourceBadge } from "@/components/sales/meta";
import {
  addLeadNote,
  convertLeadToEstimate,
  markFollowUpSent,
  setLeadStage,
  skipFollowUp,
} from "@/lib/actions/sales";

export const dynamic = "force-dynamic";

const STAGES = ["NEW", "CONTACTED", "ESTIMATE_SCHEDULED", "ESTIMATE_SENT", "FOLLOW_UP", "WON"] as const;

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

export default async function LeadDetailPage({ params }: { params: { id: string } }) {
  const session = await requireSession();
  if (!can(session.role, "leads.create")) return <Forbidden />;

  const { lead, customers } = await withTenant(session.organizationId, async (tx) => {
    const lead = await tx.query.leads.findFirst({
      where: eq(t.leads.id, params.id),
      with: {
        customer: true,
        property: true,
        assignedTo: true,
        createdBy: true,
        followUps: true,
        estimates: { with: { options: { with: { items: true } } } },
        activities: { with: { user: true } },
      },
    });
    const customers =
      !lead || lead.customerId ? [] : await tx.query.customers.findMany({ orderBy: [t.customers.name] });
    return { lead, customers };
  });
  if (!lead) notFound();

  const canManage = can(session.role, "pipeline.manage");

  const activities = [...lead.activities].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  const followUps = [...lead.followUps].sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());

  return (
    <div>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {lead.title}
            <Badge tone={leadStageTone[lead.stage]}>{statusLabel(lead.stage)}</Badge>
            <SourceBadge source={lead.source} />
          </span>
        }
        subtitle={
          <span>
            Created {timeAgo(lead.createdAt)}
            {lead.createdBy ? ` by ${lead.createdBy.name}` : ""} ·{" "}
            <SlaBadge respondBy={lead.respondBy} firstTouchAt={lead.firstTouchAt} />
          </span>
        }
        action={
          <Link href="/leads" className="text-sm text-blue-600 hover:underline">
            ← Lead inbox
          </Link>
        }
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* Main column */}
        <div className="space-y-5 lg:col-span-2">
          {/* Info card */}
          <Card>
            <CardHeader title="Lead details" />
            <CardBody className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
              <div>
                <div className="text-xs text-slate-500">Contact</div>
                <div className="font-medium text-slate-900">{lead.contactName}</div>
                <div className="text-xs text-slate-500">{lead.phone ?? "—"}</div>
                <div className="text-xs text-slate-500">{lead.email ?? "—"}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Est. value</div>
                <div className="font-semibold tabular-nums text-slate-900">{money(lead.estValueCents)}</div>
                {lead.techFlagged ? (
                  <Badge tone="violet" className="mt-1">
                    🔧 Tech-flagged · {money(lead.spiffCents)} spiff
                  </Badge>
                ) : null}
              </div>
              <div>
                <div className="text-xs text-slate-500">Assigned rep</div>
                {lead.assignedTo ? (
                  <div className="mt-0.5 flex items-center gap-1.5">
                    <Avatar name={lead.assignedTo.name} size="sm" />
                    <span>{lead.assignedTo.name}</span>
                  </div>
                ) : (
                  <div className="text-slate-400">Unassigned</div>
                )}
              </div>
              <div>
                <div className="text-xs text-slate-500">Customer</div>
                {lead.customer ? (
                  <Link href={`/customers/${lead.customer.id}`} className="text-blue-600 hover:underline">
                    {lead.customer.name}
                  </Link>
                ) : (
                  <span className="text-slate-400">Not linked yet</span>
                )}
                {lead.property ? (
                  <div className="text-xs text-slate-500">
                    {lead.property.address}, {lead.property.city}
                  </div>
                ) : null}
              </div>
              <div>
                <div className="text-xs text-slate-500">First touch</div>
                <div>{lead.firstTouchAt ? fmtDateTime(lead.firstTouchAt) : "—"}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Last contact</div>
                <div>{lead.lastContactAt ? timeAgo(lead.lastContactAt) : "—"}</div>
              </div>
              {lead.description ? (
                <p className="col-span-2 rounded-lg bg-slate-50 p-3 text-slate-700 sm:col-span-3">{lead.description}</p>
              ) : null}
              {lead.stage === "LOST" && lead.lostReason ? (
                <p className="col-span-2 rounded-lg bg-red-50 p-3 text-red-700 sm:col-span-3">
                  Lost reason: {lead.lostReason}
                </p>
              ) : null}
            </CardBody>
          </Card>

          {/* Stage controls */}
          {canManage ? (
            <Card>
              <CardHeader title="Move stage" subtitle="Marking Contacted stamps the first-touch time" />
              <CardBody className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  {STAGES.filter((s) => s !== lead.stage).map((s) => (
                    <form key={s} action={setLeadStage}>
                      <input type="hidden" name="leadId" value={lead.id} />
                      <input type="hidden" name="stage" value={s} />
                      <Button size="sm" variant={s === "WON" ? "success" : "secondary"}>
                        {s === "WON" ? "🏆 " : ""}
                        {statusLabel(s)}
                      </Button>
                    </form>
                  ))}
                </div>
                {lead.stage !== "LOST" ? (
                  <form action={setLeadStage} className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3">
                    <input type="hidden" name="leadId" value={lead.id} />
                    <input type="hidden" name="stage" value="LOST" />
                    <div className="w-64">
                      <Field label="Lost reason (required)">
                        <Input name="lostReason" required placeholder="e.g. went with competitor" />
                      </Field>
                    </div>
                    <Button size="sm" variant="danger">
                      Mark lost
                    </Button>
                  </form>
                ) : null}
              </CardBody>
            </Card>
          ) : null}

          {/* Linked estimates */}
          <Card>
            <CardHeader
              title="📝 Estimates"
              action={
                can(session.role, "estimates.create") ? (
                  lead.customerId ? (
                    <form action={convertLeadToEstimate}>
                      <input type="hidden" name="leadId" value={lead.id} />
                      <Button size="sm">＋ Convert to estimate</Button>
                    </form>
                  ) : null
                ) : null
              }
            />
            <CardBody className="p-0">
              {lead.estimates.length === 0 ? (
                <div className="p-4">
                  <EmptyState title="No estimates yet" hint="Convert this lead into a good-better-best proposal." />
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {lead.estimates.map((e) => {
                    const opt =
                      e.options.find((o) => o.selected) ??
                      [...e.options].sort((a, b) => a.sortOrder - b.sortOrder)[0];
                    return (
                      <li key={e.id} className="flex items-center gap-3 px-4 py-3">
                        <Link href={`/estimates/${e.id}`} className="font-medium text-blue-600 hover:underline">
                          {e.number}
                        </Link>
                        <Badge tone={estimateStatusTone[e.status]}>{statusLabel(e.status)}</Badge>
                        <span className="text-xs text-slate-500">
                          {e.options.length} options · {e.viewCount > 0 ? `👁 ${e.viewCount}x` : "not viewed"}
                        </span>
                        <span className="ml-auto text-sm font-semibold tabular-nums">
                          {opt ? money(lineTotal(opt.items)) : "—"}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {!lead.customerId && can(session.role, "estimates.create") ? (
                <form action={convertLeadToEstimate} className="flex flex-wrap items-end gap-2 border-t border-slate-100 p-4">
                  <input type="hidden" name="leadId" value={lead.id} />
                  <div className="w-64">
                    <Field label="Create estimate against customer">
                      <Select name="customerId" required defaultValue="">
                        <option value="" disabled>
                          Choose customer…
                        </option>
                        {customers.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  <Button size="sm">＋ Convert to estimate</Button>
                </form>
              ) : null}
            </CardBody>
          </Card>

          {/* Activity timeline + note */}
          <Card>
            <CardHeader title="🕘 Activity timeline" />
            <CardBody>
              <form action={addLeadNote} className="mb-4 flex items-start gap-2">
                <input type="hidden" name="leadId" value={lead.id} />
                <Textarea name="body" rows={2} required placeholder="Add a note to the timeline…" className="flex-1" />
                <Button size="sm">Add note</Button>
              </form>
              {activities.length === 0 ? (
                <EmptyState title="No activity yet" />
              ) : (
                <ul className="space-y-3">
                  {activities.map((a) => (
                    <li key={a.id} className="flex gap-3">
                      <span className="mt-0.5 text-base">{ACTIVITY_ICON[a.kind] ?? "•"}</span>
                      <div className="min-w-0 flex-1 border-b border-slate-100 pb-3">
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

        {/* Side column: follow-ups */}
        <div className="space-y-5">
          <Card>
            <CardHeader title="📬 Follow-ups" subtitle="Touches queued for this lead" />
            <CardBody className="p-0">
              {followUps.length === 0 ? (
                <div className="p-4">
                  <EmptyState title="No follow-ups queued" />
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {followUps.map((f) => (
                    <li key={f.id} className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Badge tone={f.channel === "SMS" ? "cyan" : f.channel === "EMAIL" ? "violet" : "blue"}>
                          {f.channel}
                        </Badge>
                        <Badge tone={f.status === "PENDING" ? "amber" : f.status === "SENT" ? "green" : "slate"}>
                          {statusLabel(f.status)}
                        </Badge>
                        <span className="ml-auto text-xs text-slate-500">
                          {f.status === "SENT" && f.sentAt ? `sent ${timeAgo(f.sentAt)}` : `due ${fmtDateTime(f.dueAt)}`}
                        </span>
                      </div>
                      <p className="mt-1.5 text-sm text-slate-700">{f.body}</p>
                      {f.status === "PENDING" ? (
                        <div className="mt-2 flex gap-2">
                          <form action={markFollowUpSent}>
                            <input type="hidden" name="followUpId" value={f.id} />
                            <Button size="sm" variant="success">
                              ✓ Mark sent
                            </Button>
                          </form>
                          <form action={skipFollowUp}>
                            <input type="hidden" name="followUpId" value={f.id} />
                            <Button size="sm" variant="ghost">
                              Skip
                            </Button>
                          </form>
                        </div>
                      ) : null}
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
