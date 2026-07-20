import Link from "next/link";
import { t, withTenant } from "@/db";
import { asc, desc, isNull } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { lineTotal, money, timeAgo, fmtDate } from "@/lib/format";
import { createStandaloneEstimate, sweepExpiredEstimates } from "@/lib/actions/money";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Table,
  TCell,
  THead,
  TRow,
  estimateStatusTone,
  statusLabel,
} from "@/components/ui";
import { Forbidden } from "@/components/sales/meta";

export const dynamic = "force-dynamic";

export default async function EstimatesPage() {
  const session = await requireSession();
  if (!can(session.role, "estimates.create")) return <Forbidden />;

  // M3: lazy auto-expire — SENT/VIEWED past their 30-day shelf life flip to EXPIRED.
  await sweepExpiredEstimates(session.organizationId);

  const [estimates, customers] = await withTenant(session.organizationId, (tx) =>
    Promise.all([
      tx.query.estimates.findMany({
        with: {
          customer: true,
          createdBy: true,
          options: { with: { items: true } },
          followUps: true,
        },
        orderBy: [desc(t.estimates.createdAt)],
      }),
      tx.query.customers.findMany({
        where: isNull(t.customers.archivedAt),
        with: { properties: { where: isNull(t.properties.archivedAt) } },
        orderBy: asc(t.customers.name),
      }),
    ])
  );

  const openValue = estimates
    .filter((e) => ["SENT", "VIEWED", "DRAFT"].includes(e.status))
    .reduce((s, e) => {
      const opt = e.options.find((o) => o.selected) ?? [...e.options].sort((a, b) => a.sortOrder - b.sortOrder)[0];
      return s + (opt ? lineTotal(opt.items) : 0);
    }, 0);

  return (
    <div>
      <PageHeader
        title="📝 Estimates"
        subtitle={`${estimates.length} proposals · ${money(openValue)} awaiting decision`}
      />

      {/* M3: standalone estimate — no lead required */}
      <Card className="mb-4">
        <CardBody>
          <details>
            <summary className="cursor-pointer text-sm font-medium text-blue-600">＋ New estimate (no lead required)</summary>
            <form action={createStandaloneEstimate} className="mt-3 grid gap-3 md:grid-cols-3">
              <Field label="Customer">
                <Select name="customerId" required defaultValue="">
                  <option value="" disabled>
                    Select customer…
                  </option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Property (optional)">
                <Select name="propertyId" defaultValue="">
                  <option value="">—</option>
                  {customers.flatMap((c) =>
                    c.properties.map((p) => (
                      <option key={p.id} value={p.id}>
                        {c.name} — {p.address}
                      </option>
                    ))
                  )}
                </Select>
              </Field>
              <Field label="What's it for?">
                <Input name="notes" placeholder="e.g. Water heater replacement options" />
              </Field>
              <div>
                <Button type="submit">Create draft estimate</Button>
              </div>
            </form>
          </details>
        </CardBody>
      </Card>

      <Card>
        {estimates.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No estimates yet" hint="Convert a lead to start a good-better-best proposal." />
          </div>
        ) : (
          <>
          {/* Mobile: card list */}
          <ul className="divide-y divide-slate-100 md:hidden">
            {estimates.map((e) => {
              const opt =
                e.options.find((o) => o.selected) ?? [...e.options].sort((a, b) => a.sortOrder - b.sortOrder)[0];
              const total = opt ? lineTotal(opt.items) : 0;
              const pending = e.followUps.filter((f) => f.status === "PENDING").length;
              return (
                <li key={e.id}>
                  <Link href={`/estimates/${e.id}`} className="block px-4 py-3 active:bg-slate-50">
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-medium text-blue-600">{e.number}</span>
                      <span className="shrink-0 font-semibold tabular-nums">{money(total)}</span>
                    </div>
                    <div className="mt-0.5 text-sm text-slate-700">{e.customer.name}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Badge tone={estimateStatusTone[e.status]}>{statusLabel(e.status)}</Badge>
                      {e.viewCount >= 2 ? <Badge tone="amber">👁 {e.viewCount}x viewed</Badge> : null}
                      {pending > 0 ? <Badge tone="amber">⚡ {pending} pending</Badge> : null}
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      {e.sentAt ? `sent ${fmtDate(e.sentAt)}` : `created ${fmtDate(e.createdAt)}`} ·{" "}
                      {e.createdBy.name.split(" ")[0]}
                      {e.lastViewedAt ? ` · viewed ${timeAgo(e.lastViewedAt)}` : ""}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
          {/* Desktop: full table */}
          <div className="hidden md:block">
          <Table>
            <THead cols={["Estimate", "Customer", "Status", "Total", "Engagement", "Follow-up automation", "Rep"]} />
            <tbody>
              {estimates.map((e) => {
                const opt =
                  e.options.find((o) => o.selected) ?? [...e.options].sort((a, b) => a.sortOrder - b.sortOrder)[0];
                const total = opt ? lineTotal(opt.items) : 0;
                const pending = e.followUps.filter((f) => f.status === "PENDING").length;
                return (
                  <TRow key={e.id}>
                    <TCell>
                      <Link href={`/estimates/${e.id}`} className="font-medium text-blue-600 hover:underline">
                        {e.number}
                      </Link>
                      <div className="text-xs text-slate-500">
                        {e.sentAt ? `sent ${fmtDate(e.sentAt)}` : `created ${fmtDate(e.createdAt)}`}
                      </div>
                    </TCell>
                    <TCell>{e.customer.name}</TCell>
                    <TCell>
                      <Badge tone={estimateStatusTone[e.status]}>{statusLabel(e.status)}</Badge>
                    </TCell>
                    <TCell>
                      <span className="font-semibold tabular-nums">{money(total)}</span>
                      {opt ? <div className="text-xs text-slate-500">{opt.name}</div> : null}
                    </TCell>
                    <TCell>
                      {e.viewCount > 0 ? (
                        <div>
                          <span className={e.viewCount >= 2 ? "font-medium text-amber-600" : "text-slate-700"}>
                            👁 {e.viewCount}x
                          </span>
                          {e.lastViewedAt ? (
                            <div className="text-xs text-slate-500">viewed {timeAgo(e.lastViewedAt)}</div>
                          ) : null}
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">not viewed</span>
                      )}
                    </TCell>
                    <TCell>
                      {pending > 0 ? (
                        <Badge tone="amber">⚡ {pending} pending</Badge>
                      ) : e.followUps.length > 0 ? (
                        <Badge tone="slate">sequence done</Badge>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </TCell>
                    <TCell>
                      <span className="text-xs">{e.createdBy.name.split(" ")[0]}</span>
                    </TCell>
                  </TRow>
                );
              })}
            </tbody>
          </Table>
          </div>
          </>
        )}
      </Card>
    </div>
  );
}
