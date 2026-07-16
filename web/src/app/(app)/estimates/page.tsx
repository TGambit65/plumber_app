import Link from "next/link";
import { db, t } from "@/db";
import { desc } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { lineTotal, money, timeAgo, fmtDate } from "@/lib/format";
import {
  Badge,
  Card,
  EmptyState,
  PageHeader,
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

  const estimates = await db.query.estimates.findMany({
    with: {
      customer: true,
      createdBy: true,
      options: { with: { items: true } },
      followUps: true,
    },
    orderBy: [desc(t.estimates.createdAt)],
  });

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

      <Card>
        {estimates.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No estimates yet" hint="Convert a lead to start a good-better-best proposal." />
          </div>
        ) : (
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
        )}
      </Card>
    </div>
  );
}
