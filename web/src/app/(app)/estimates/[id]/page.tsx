import Link from "next/link";
import { notFound } from "next/navigation";
import { db, t } from "@/db";
import { eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { fmtDateTime, lineTotal, money, monthly, timeAgo } from "@/lib/format";
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
  estimateStatusTone,
  statusLabel,
} from "@/components/ui";
import { Forbidden } from "@/components/sales/meta";
import {
  addEstimateOption,
  addLineItem,
  approveEstimate,
  declineEstimate,
  markEstimateSent,
  markFollowUpSent,
  recordEstimateView,
  removeLineItem,
  skipFollowUp,
  updateLineItem,
} from "@/lib/actions/sales";
import { clsx } from "@/lib/clsx";

export const dynamic = "force-dynamic";

const TIER_LABEL: Record<string, string> = {
  GOOD: "Good",
  BETTER: "Better",
  BEST: "Best",
  CUSTOM: "Custom",
};

const TIER_TONE: Record<string, "slate" | "blue" | "violet" | "cyan"> = {
  GOOD: "slate",
  BETTER: "blue",
  BEST: "violet",
  CUSTOM: "cyan",
};

export default async function EstimateDetailPage({ params }: { params: { id: string } }) {
  const session = await requireSession();
  if (!can(session.role, "estimates.create")) return <Forbidden />;

  const est = await db.query.estimates.findFirst({
    where: eq(t.estimates.id, params.id),
    with: {
      customer: true,
      property: true,
      lead: true,
      job: true,
      createdBy: true,
      options: { with: { items: { with: { priceBookItem: true } } } },
      followUps: true,
    },
  });
  if (!est) notFound();

  const editable = ["DRAFT", "SENT", "VIEWED"].includes(est.status);
  const priceBook = editable
    ? await db.query.priceBookItems.findMany({ where: eq(t.priceBookItems.active, true), orderBy: [t.priceBookItems.category, t.priceBookItems.name] })
    : [];

  const options = [...est.options].sort((a, b) => a.sortOrder - b.sortOrder);
  const followUps = [...est.followUps].sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
  const pendingFollowUps = followUps.filter((f) => f.status === "PENDING");
  const defaultOption = options.find((o) => o.selected) ?? options.find((o) => o.tier === "BETTER") ?? options[0];

  return (
    <div>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            Estimate {est.number}
            <Badge tone={estimateStatusTone[est.status]}>{statusLabel(est.status)}</Badge>
            {est.financingOffered ? <Badge tone="cyan">💳 Financing offered</Badge> : null}
          </span>
        }
        subtitle={
          <span>
            {est.customer.name}
            {est.property ? ` · ${est.property.address}, ${est.property.city}` : ""} · by {est.createdBy.name}
            {est.lead ? (
              <>
                {" · "}
                <Link href={`/leads/${est.lead.id}`} className="text-blue-600 hover:underline">
                  lead: {est.lead.title}
                </Link>
              </>
            ) : null}
          </span>
        }
        action={
          <Link href="/estimates" className="text-sm text-blue-600 hover:underline">
            ← Estimates
          </Link>
        }
      />

      {/* Approved / declined banners */}
      {est.status === "APPROVED" ? (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
          <span className="text-xl">✅</span>
          <div className="text-sm text-emerald-800">
            <span className="font-semibold">Approved & e-signed by {est.signedName}</span> on {fmtDateTime(est.signedAt)}
            {defaultOption ? ` — "${defaultOption.name}" for ${money(lineTotal(defaultOption.items))}` : ""}
          </div>
          {est.job ? (
            <span className="ml-auto text-sm text-emerald-800">
              Job created: <span className="font-semibold">{est.job.number}</span> ({statusLabel(est.job.status)})
            </span>
          ) : null}
        </div>
      ) : null}
      {est.status === "DECLINED" ? (
        <div className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          ❌ This estimate was declined. Check the lead timeline for the reason — it will resurface in the 30-day rehash queue.
        </div>
      ) : null}

      {/* Engagement + lifecycle actions */}
      <Card className="mb-5">
        <CardBody className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500">Engagement</div>
            <div className="mt-0.5 text-lg font-semibold text-slate-900">
              👁 {est.viewCount} view{est.viewCount === 1 ? "" : "s"}
            </div>
            <div className="text-xs text-slate-500">
              {est.lastViewedAt ? `last viewed ${timeAgo(est.lastViewedAt)}` : "not viewed yet"}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500">Sent</div>
            <div className="mt-0.5 text-sm text-slate-800">{est.sentAt ? fmtDateTime(est.sentAt) : "Not sent yet"}</div>
            <div className="text-xs text-slate-500">
              {pendingFollowUps.length > 0
                ? `⚡ ${pendingFollowUps.length} automated touches pending`
                : est.sentAt
                  ? "follow-up sequence complete"
                  : "sending starts the 7-day sequence"}
            </div>
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            {est.status === "DRAFT" ? (
              <form action={markEstimateSent}>
                <input type="hidden" name="estimateId" value={est.id} />
                <Button>📤 Mark sent &amp; start follow-ups</Button>
              </form>
            ) : null}
            {["SENT", "VIEWED", "DRAFT"].includes(est.status) ? (
              <form action={recordEstimateView}>
                <input type="hidden" name="estimateId" value={est.id} />
                <Button variant="secondary" title="Demo hook: simulates the customer opening their proposal link">
                  👁 Record customer view
                </Button>
              </form>
            ) : null}
          </div>
        </CardBody>
      </Card>

      {/* Good / Better / Best presentation */}
      {options.length === 0 ? (
        <EmptyState title="No options yet" hint="Add a Good, Better, and Best option below." />
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
          {options.map((o) => {
            const total = lineTotal(o.items);
            const isBest = o.tier === "BEST";
            return (
              <Card
                key={o.id}
                className={clsx(
                  "relative flex flex-col",
                  isBest && "ring-2 ring-blue-500 shadow-md",
                  o.selected && est.status === "APPROVED" && "ring-2 ring-emerald-500"
                )}
              >
                {isBest ? (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-blue-600 px-3 py-0.5 text-[11px] font-semibold text-white shadow">
                    ★ Best value
                  </span>
                ) : null}
                {o.tier === "BETTER" && !o.selected ? (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-slate-700 px-3 py-0.5 text-[11px] font-semibold text-white shadow">
                    Most popular
                  </span>
                ) : null}
                <CardHeader
                  title={
                    <span className="flex items-center gap-2">
                      {o.name}
                      {o.selected ? <Badge tone="green">✓ Selected</Badge> : null}
                    </span>
                  }
                  subtitle={o.description ?? undefined}
                  action={<Badge tone={TIER_TONE[o.tier]}>{TIER_LABEL[o.tier]}</Badge>}
                />
                <CardBody className="flex flex-1 flex-col gap-2">
                  {/* Line items */}
                  {o.items.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-slate-400">
                      No line items yet — add from the price book below.
                    </p>
                  ) : (
                    <ul className="divide-y divide-slate-100">
                      {o.items.map((i) => (
                        <li key={i.id} className="py-2">
                          <div className="flex items-baseline justify-between gap-2 text-sm">
                            <span className="text-slate-800">{i.description}</span>
                            <span className="whitespace-nowrap font-medium tabular-nums text-slate-900">
                              {money(Math.round(i.qty * i.unitPriceCents))}
                            </span>
                          </div>
                          <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                            {editable ? (
                              <>
                                <form action={updateLineItem} className="flex items-center gap-1.5">
                                  <input type="hidden" name="itemId" value={i.id} />
                                  <input
                                    name="qty"
                                    defaultValue={i.qty}
                                    inputMode="decimal"
                                    aria-label="Quantity"
                                    className="h-7 w-14 rounded-md border border-slate-300 px-1.5 text-xs tabular-nums"
                                  />
                                  <span>×</span>
                                  <input
                                    name="price"
                                    defaultValue={(i.unitPriceCents / 100).toFixed(2)}
                                    inputMode="decimal"
                                    aria-label="Unit price ($)"
                                    className="h-7 w-20 rounded-md border border-slate-300 px-1.5 text-xs tabular-nums"
                                  />
                                  <button
                                    type="submit"
                                    title="Save qty/price"
                                    className="rounded-md border border-slate-200 px-1.5 py-0.5 text-xs text-slate-600 hover:bg-slate-50"
                                  >
                                    ✓
                                  </button>
                                </form>
                                <form action={removeLineItem}>
                                  <input type="hidden" name="itemId" value={i.id} />
                                  <button
                                    type="submit"
                                    title="Remove line item"
                                    className="rounded-md px-1.5 py-0.5 text-xs text-red-500 hover:bg-red-50"
                                  >
                                    ✕
                                  </button>
                                </form>
                              </>
                            ) : (
                              <span>
                                {i.qty} × {money(i.unitPriceCents)}
                              </span>
                            )}
                            {i.priceBookItem ? (
                              <span className="ml-auto text-[10px] uppercase tracking-wide text-slate-400">
                                {i.priceBookItem.code}
                              </span>
                            ) : null}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* Add from price book */}
                  {editable ? (
                    <form action={addLineItem} className="mt-1 space-y-1.5 rounded-lg bg-slate-50 p-2">
                      <input type="hidden" name="optionId" value={o.id} />
                      <Select name="priceBookItemId" required defaultValue="" className="h-8 text-xs">
                        <option value="" disabled>
                          ＋ Add from price book…
                        </option>
                        {priceBook.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.category} · {p.name} — {money(p.unitPriceCents)}
                          </option>
                        ))}
                      </Select>
                      <div className="flex items-center gap-1.5">
                        <input
                          name="qty"
                          defaultValue="1"
                          inputMode="decimal"
                          aria-label="Quantity"
                          className="h-8 w-14 rounded-md border border-slate-300 bg-white px-1.5 text-xs"
                        />
                        <input
                          name="priceOverride"
                          placeholder="$ override"
                          inputMode="decimal"
                          aria-label="Price override ($)"
                          className="h-8 w-24 rounded-md border border-slate-300 bg-white px-1.5 text-xs"
                        />
                        <Button size="sm" className="ml-auto">
                          Add item
                        </Button>
                      </div>
                    </form>
                  ) : null}

                  {/* Total + financing framing */}
                  <div className="mt-auto border-t border-slate-100 pt-3 text-center">
                    <div className={clsx("text-2xl font-bold tabular-nums", isBest ? "text-blue-700" : "text-slate-900")}>
                      {money(total)}
                    </div>
                    {est.financingOffered && total > 0 ? (
                      <div className="mt-0.5 text-sm font-medium text-emerald-600">
                        or {monthly(total)}/mo with financing
                      </div>
                    ) : null}
                  </div>
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}

      {/* Add option */}
      {editable ? (
        <form action={addEstimateOption} className="mt-4 flex flex-wrap items-end gap-2">
          <input type="hidden" name="estimateId" value={est.id} />
          <div className="w-36">
            <Field label="Tier">
              <Select name="tier" defaultValue="CUSTOM">
                <option value="GOOD">Good</option>
                <option value="BETTER">Better</option>
                <option value="BEST">Best</option>
                <option value="CUSTOM">Custom</option>
              </Select>
            </Field>
          </div>
          <div className="w-64">
            <Field label="Option name">
              <Input name="name" placeholder="e.g. Premium package" />
            </Field>
          </div>
          <Button variant="secondary">＋ Add option</Button>
        </form>
      ) : null}

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* Approve & e-sign / decline */}
        {editable ? (
          <Card>
            <CardHeader
              title="✍️ Approve & e-sign"
              subtitle="Pick the option the customer chose, have them sign, and we do the rest — commission, job, notifications."
            />
            <CardBody>
              <form action={approveEstimate} className="space-y-3">
                <input type="hidden" name="estimateId" value={est.id} />
                <div className="space-y-2">
                  {options.map((o) => {
                    const total = lineTotal(o.items);
                    return (
                      <label
                        key={o.id}
                        className="flex cursor-pointer items-center gap-3 rounded-lg border border-slate-200 px-3 py-2 hover:bg-slate-50"
                      >
                        <input
                          type="radio"
                          name="optionId"
                          value={o.id}
                          defaultChecked={defaultOption?.id === o.id}
                          required
                          className="h-4 w-4 accent-blue-600"
                        />
                        <span className="flex-1 text-sm text-slate-800">
                          <Badge tone={TIER_TONE[o.tier]} className="mr-2">
                            {TIER_LABEL[o.tier]}
                          </Badge>
                          {o.name}
                        </span>
                        <span className="text-sm font-semibold tabular-nums">{money(total)}</span>
                      </label>
                    );
                  })}
                </div>
                <Field label="Customer signature (type full name)">
                  <Input name="signedName" required placeholder={est.customer.name} />
                </Field>
                <Button variant="success" className="w-full">
                  ✍️ Approve &amp; e-sign
                </Button>
                <p className="text-center text-[11px] text-slate-400">
                  Creates a 5% commission entry for {est.createdBy.name.split(" ")[0]}, books the job, and stops the
                  follow-up sequence.
                </p>
              </form>
              <form action={declineEstimate} className="mt-4 flex items-end gap-2 border-t border-slate-100 pt-4">
                <input type="hidden" name="estimateId" value={est.id} />
                <div className="flex-1">
                  <Field label="Decline with reason">
                    <Input name="reason" required placeholder="e.g. price too high, going DIY" />
                  </Field>
                </div>
                <Button variant="danger">Decline</Button>
              </form>
            </CardBody>
          </Card>
        ) : (
          <Card>
            <CardHeader title="Outcome" />
            <CardBody className="text-sm text-slate-700">
              {est.status === "APPROVED" ? (
                <p>
                  Signed by <span className="font-medium">{est.signedName}</span> on {fmtDateTime(est.signedAt)}.
                  Commission entry created for {est.createdBy.name}.
                </p>
              ) : (
                <p>This estimate is {statusLabel(est.status).toLowerCase()} — no further actions available.</p>
              )}
              {est.notes ? <p className="mt-2 rounded-lg bg-slate-50 p-3 text-slate-600">{est.notes}</p> : null}
            </CardBody>
          </Card>
        )}

        {/* Follow-up automation */}
        <Card>
          <CardHeader
            title="⚡ Follow-up automation"
            subtitle="Default 7-day cadence: 5 SMS + 2 email. Auto-stops on approval or decline."
          />
          <CardBody className="p-0">
            {followUps.length === 0 ? (
              <div className="p-4">
                <EmptyState title="No sequence yet" hint="Mark the estimate sent to start the 7-day cadence." />
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {followUps.map((f) => (
                  <li key={f.id} className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <Badge tone={f.channel === "SMS" ? "cyan" : f.channel === "EMAIL" ? "violet" : "blue"}>
                        {f.channel === "SMS" ? "💬" : f.channel === "EMAIL" ? "✉️" : "📞"} {f.channel}
                      </Badge>
                      <Badge tone={f.status === "PENDING" ? "amber" : f.status === "SENT" ? "green" : "slate"}>
                        {statusLabel(f.status)}
                      </Badge>
                      <span className="ml-auto text-xs text-slate-500">
                        {f.status === "SENT" && f.sentAt ? `sent ${timeAgo(f.sentAt)}` : fmtDateTime(f.dueAt)}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-slate-600">{f.body}</p>
                    {f.status === "PENDING" ? (
                      <div className="mt-1.5 flex gap-2">
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

      {est.notes && editable ? (
        <Card className="mt-5">
          <CardHeader title="Notes" />
          <CardBody className="text-sm text-slate-700">{est.notes}</CardBody>
        </Card>
      ) : null}
    </div>
  );
}
