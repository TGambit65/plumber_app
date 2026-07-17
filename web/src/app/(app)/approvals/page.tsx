import Link from "next/link";
import { t, withTenant } from "@/db";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { and, desc, eq, ne } from "drizzle-orm";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Input,
  Label,
  PageHeader,
  Select,
  Stat,
  Textarea,
  type BadgeTone,
} from "@/components/ui";
import { fmtDateTime, timeAgo } from "@/lib/format";
import {
  approveOutbound,
  queueCustomerMessage,
  queueLicensedSignoff,
  rejectOutbound,
} from "@/lib/actions/approvals";

export const dynamic = "force-dynamic";

const KIND_META: Record<string, { emoji: string; label: string; tone: BadgeTone }> = {
  ESTIMATE_SEND: { emoji: "📄", label: "Estimate send", tone: "blue" },
  FOLLOW_UP_TOUCH: { emoji: "🔁", label: "Follow-up touch", tone: "cyan" },
  CUSTOMER_MESSAGE: { emoji: "💬", label: "Customer message", tone: "violet" },
  LICENSED_SIGNOFF: { emoji: "🔏", label: "Licensed sign-off", tone: "amber" },
};

const KIND_ORDER = ["LICENSED_SIGNOFF", "ESTIMATE_SEND", "FOLLOW_UP_TOUCH", "CUSTOMER_MESSAGE"] as const;

type OutboundRow = typeof t.outboundMessages.$inferSelect & {
  requestedBy: typeof t.users.$inferSelect | null;
  approvedBy: typeof t.users.$inferSelect | null;
  customer: typeof t.customers.$inferSelect | null;
  estimate: typeof t.estimates.$inferSelect | null;
  followUp: typeof t.followUps.$inferSelect | null;
  job: typeof t.jobs.$inferSelect | null;
  permit: typeof t.permits.$inferSelect | null;
};

function targetLabel(row: OutboundRow): string | null {
  if (row.estimate) return `Estimate ${row.estimate.number}`;
  if (row.followUp) return `Follow-up · ${row.followUp.channel}`;
  if (row.permit) return `Permit ${row.permit.permitNumber ?? row.permit.jurisdiction}`;
  if (row.job) return `Job ${row.job.number}`;
  return null;
}

export default async function ApprovalsPage() {
  const session = await requireSession();
  if (!can(session.role, "approvals.manage")) {
    return (
      <EmptyState
        title="403 — Approvals are for office & owner"
        hint="Customer-facing sends you request will surface here for an approver to release."
      />
    );
  }

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const data = await withTenant(session.organizationId, async (tx) => {
    const messages = (await tx.query.outboundMessages.findMany({
      with: {
        requestedBy: true,
        approvedBy: true,
        customer: true,
        estimate: true,
        followUp: true,
        job: true,
        permit: true,
      },
      orderBy: [desc(t.outboundMessages.createdAt)],
    })) as OutboundRow[];
    // Certs the current viewer personally holds — for licensed eligibility.
    const myCerts = await tx.query.certifications.findMany({
      where: eq(t.certifications.userId, session.userId),
    });
    // Compose-form option sources.
    const customers = await tx
      .select({ id: t.customers.id, name: t.customers.name, email: t.customers.email, phone: t.customers.phone })
      .from(t.customers)
      .orderBy(t.customers.name);
    const permits = await tx.query.permits.findMany({ with: { project: true }, orderBy: [desc(t.permits.id)] });
    const jobs = await tx
      .select({ id: t.jobs.id, number: t.jobs.number, jobType: t.jobs.jobType })
      .from(t.jobs)
      .where(and(ne(t.jobs.status, "COMPLETED"), ne(t.jobs.status, "CANCELLED")))
      .orderBy(desc(t.jobs.createdAt))
      .limit(50);
    return { messages, myCerts, customers, permits, jobs };
  });

  const { messages, myCerts, customers, permits, jobs } = data;

  /** Whether the viewer may approve a licensed sign-off requiring `certName`. */
  const viewerEligible = (certName: string | null): boolean => {
    if (session.role === "ADMIN") return true;
    if (!certName) return true;
    return myCerts.some((c) => c.name === certName && (!c.expiresAt || c.expiresAt > now));
  };

  const pending = messages.filter((m) => m.status === "PENDING_APPROVAL");
  const decided = messages
    .filter((m) => m.status === "APPROVED_SENT" || m.status === "REJECTED")
    .sort((a, b) => (b.decidedAt?.getTime() ?? 0) - (a.decidedAt?.getTime() ?? 0))
    .slice(0, 25);

  const sentToday = messages.filter(
    (m) => m.status === "APPROVED_SENT" && m.decidedAt && m.decidedAt >= startOfToday
  ).length;
  const rejectedCount = messages.filter((m) => m.status === "REJECTED").length;
  const licensedPending = pending.filter((m) => m.kind === "LICENSED_SIGNOFF").length;

  const pendingByKind = KIND_ORDER.map((kind) => ({
    kind,
    items: pending.filter((m) => m.kind === kind),
  })).filter((g) => g.items.length > 0);

  return (
    <div>
      <PageHeader
        title="✉️ Approvals"
        subtitle="Nothing customer-facing goes out without a sign-off. Automate the routine; route licensed work to a licensed human."
      />

      {/* ── Stat row ── */}
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Pending" value={pending.length} hint="awaiting a decision" tone={pending.length > 0 ? "warn" : "good"} />
        <Stat label="Sent today" value={sentToday} hint="approved & released" tone="good" />
        <Stat label="Rejected" value={rejectedCount} hint="all-time" />
        <Stat
          label="Licensed pending"
          value={licensedPending}
          hint="need a licensed approver"
          tone={licensedPending > 0 ? "warn" : "default"}
        />
      </div>

      {/* ── Pending queue ── */}
      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Pending queue</h2>
        {pending.length === 0 ? (
          <EmptyState title="Nothing waiting for approval" hint="Queued estimates, touches, messages & sign-offs land here." />
        ) : (
          <div className="space-y-6">
            {pendingByKind.map((group) => {
              const meta = KIND_META[group.kind];
              return (
                <div key={group.kind}>
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-700">
                      {meta.emoji} {meta.label}
                    </span>
                    <Badge tone={meta.tone}>{group.items.length}</Badge>
                  </div>
                  <div className="grid gap-3 lg:grid-cols-2">
                    {group.items.map((row) => {
                      const target = targetLabel(row);
                      const licensed = row.kind === "LICENSED_SIGNOFF";
                      const eligible = viewerEligible(row.requiredCertName);
                      return (
                        <Card key={row.id}>
                          <CardBody className="space-y-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge tone={meta.tone}>
                                {meta.emoji} {meta.label}
                              </Badge>
                              {target ? <Badge tone="slate">{target}</Badge> : null}
                              {licensed ? (
                                <Badge tone="red">🔏 requires: {row.requiredCertName ?? "admin"}</Badge>
                              ) : null}
                              <span className="ml-auto text-xs text-slate-400">{timeAgo(row.createdAt)}</span>
                            </div>

                            <div className="text-xs text-slate-500">
                              <span className="font-medium text-slate-700">{row.requestedBy?.name ?? "Someone"}</span>
                              {row.customer ? <> · to {row.customer.name}</> : null}
                              {row.recipient ? <> · {row.recipient}</> : null}
                            </div>

                            {row.subject ? (
                              <div className="text-sm font-medium text-slate-900">{row.subject}</div>
                            ) : null}
                            <p className="line-clamp-4 whitespace-pre-wrap text-sm text-slate-600">{row.body}</p>

                            {licensed ? (
                              eligible ? (
                                <div className="rounded-md bg-emerald-50 px-2.5 py-1.5 text-xs text-emerald-700">
                                  ✅ You are eligible to sign this off
                                  {session.role === "ADMIN" ? " (admin)" : ` (you hold "${row.requiredCertName}")`}.
                                </div>
                              ) : (
                                <div className="rounded-md bg-red-50 px-2.5 py-1.5 text-xs text-red-700">
                                  ⛔ You can't approve this — it needs a valid “{row.requiredCertName}” holder or an admin.
                                </div>
                              )
                            ) : null}

                            <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
                              <form action={approveOutbound}>
                                <input type="hidden" name="id" value={row.id} />
                                <Button type="submit" variant="success" size="sm" disabled={licensed && !eligible}>
                                  ✓ Approve &amp; send
                                </Button>
                              </form>
                              <details className="group">
                                <summary className="inline-flex cursor-pointer list-none items-center rounded-lg px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100">
                                  Reject…
                                </summary>
                                <form action={rejectOutbound} className="mt-2 flex items-end gap-2">
                                  <input type="hidden" name="id" value={row.id} />
                                  <div className="flex-1">
                                    <Label htmlFor={`reason-${row.id}`}>Reason (required)</Label>
                                    <Input
                                      id={`reason-${row.id}`}
                                      name="reason"
                                      required
                                      placeholder="Why is this being rejected?"
                                    />
                                  </div>
                                  <Button type="submit" variant="danger" size="sm">
                                    Reject
                                  </Button>
                                </form>
                              </details>
                            </div>
                          </CardBody>
                        </Card>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Compose ── */}
      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Queue something new</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="💬 Customer message" subtitle="Drafted here, released after approval" />
            <CardBody>
              <form action={queueCustomerMessage} className="space-y-3">
                <Field label="Customer">
                  <Select name="customerId" required defaultValue="">
                    <option value="" disabled>
                      Choose customer…
                    </option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.email ? ` · ${c.email}` : c.phone ? ` · ${c.phone}` : ""}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Subject (optional)">
                  <Input name="subject" placeholder="Quick update on your job" />
                </Field>
                <Field label="Message">
                  <Textarea name="body" rows={3} required placeholder="Hi! Wanted to let you know…" />
                </Field>
                <Button type="submit" className="w-full">
                  Queue for approval
                </Button>
              </form>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="🔏 Licensed sign-off" subtitle="Routes to a licensed human (or admin)" />
            <CardBody>
              <form action={queueLicensedSignoff} className="space-y-3">
                <Field label="Permit (optional)">
                  <Select name="permitId" defaultValue="">
                    <option value="">— none —</option>
                    {permits.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.permitNumber ?? p.jurisdiction}
                        {p.project ? ` · ${p.project.name}` : ""}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Job (optional — if no permit)">
                  <Select name="jobId" defaultValue="">
                    <option value="">— none —</option>
                    {jobs.map((j) => (
                      <option key={j.id} value={j.id}>
                        {j.number} · {j.jobType}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Required certification">
                  <Input name="requiredCertName" required placeholder="Journeyman Plumber License" />
                </Field>
                <Field label="What's being signed off">
                  <Textarea name="body" rows={2} required placeholder="Certify rough-in meets code for permit inspection." />
                </Field>
                <Button type="submit" className="w-full">
                  Queue for licensed approval
                </Button>
              </form>
            </CardBody>
          </Card>
        </div>
      </section>

      {/* ── Recent decisions ── */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Recent decisions</h2>
        <Card>
          <CardBody className="p-0">
            {decided.length === 0 ? (
              <div className="p-4">
                <EmptyState title="No decisions yet" hint="Approvals & rejections will show here with who & when." />
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {decided.map((row) => {
                  const meta = KIND_META[row.kind];
                  const approved = row.status === "APPROVED_SENT";
                  return (
                    <li key={row.id} className="flex flex-wrap items-center gap-2 px-4 py-3">
                      <span className="text-sm">{meta.emoji}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={approved ? "green" : "red"}>{approved ? "Approved & sent" : "Rejected"}</Badge>
                          <span className="text-sm font-medium text-slate-800">{meta.label}</span>
                          {row.customer ? <span className="text-xs text-slate-500">· {row.customer.name}</span> : null}
                        </div>
                        <div className="mt-0.5 text-xs text-slate-500">
                          {row.approvedBy?.name ?? "—"} · {fmtDateTime(row.decidedAt)}
                          {row.requestedBy ? ` · requested by ${row.requestedBy.name}` : ""}
                          {!approved && row.rejectReason ? ` — “${row.rejectReason}”` : ""}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardBody>
        </Card>
      </section>

      <p className="mt-6 text-center">
        <Link href="/dashboard" className="text-xs text-slate-400 hover:text-slate-600">
          ← Back to dashboard
        </Link>
      </p>
    </div>
  );
}
