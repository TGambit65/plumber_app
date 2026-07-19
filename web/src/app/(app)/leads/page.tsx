import Link from "next/link";
import { t, withTenant } from "@/db";
import { desc, eq, isNull, isNotNull } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { money } from "@/lib/format";
import {
  Avatar,
  Badge,
  Card,
  EmptyState,
  PageHeader,
  Select,
  Table,
  TCell,
  THead,
  TRow,
  buttonClass,
  leadStageTone,
  statusLabel,
} from "@/components/ui";
import { Forbidden, SOURCE_META, SlaBadge, SourceBadge } from "@/components/sales/meta";
import { NewLeadPanel } from "@/components/sales/new-lead-form";

export const dynamic = "force-dynamic";

const STAGES = ["NEW", "CONTACTED", "ESTIMATE_SCHEDULED", "ESTIMATE_SENT", "FOLLOW_UP", "WON", "LOST"];

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: { stage?: string; source?: string; archived?: string };
}) {
  const session = await requireSession();
  if (!can(session.role, "leads.create")) return <Forbidden />;

  const stageFilter = STAGES.includes(searchParams.stage ?? "") ? searchParams.stage : undefined;
  const sourceFilter = Object.keys(SOURCE_META).includes(searchParams.source ?? "") ? searchParams.source : undefined;

  const [allLeads, reps] = await withTenant(session.organizationId, (tx) =>
    Promise.all([
      tx.query.leads.findMany({
        // M1: archived leads hidden by default; ?archived=1 shows ONLY them.
        where: searchParams.archived === "1" ? isNotNull(t.leads.archivedAt) : isNull(t.leads.archivedAt),
        with: { assignedTo: true, customer: true },
        orderBy: [desc(t.leads.createdAt)],
      }),
      tx.query.users.findMany({ where: eq(t.users.active, true), orderBy: [t.users.name] }),
    ])
  );

  const leads = allLeads.filter(
    (l) => (!stageFilter || l.stage === stageFilter) && (!sourceFilter || l.source === sourceFilter)
  );
  const openValue = leads
    .filter((l) => !["WON", "LOST"].includes(l.stage))
    .reduce((s, l) => s + (l.estValueCents ?? 0), 0);

  const salesReps = reps.filter((r) => r.role === "SALES_PM" || r.role === "ADMIN");

  return (
    <div>
      <PageHeader
        title="📥 Lead inbox"
        subtitle={`${leads.length} leads · ${money(openValue)} open value — every source in one queue`}
        action={<NewLeadPanel reps={salesReps.map((r) => ({ id: r.id, name: r.name }))} />}
      />

      {/* Filters via searchParams */}
      <form className="mb-4 flex flex-wrap items-end gap-2">
        <div className="w-44">
          <label className="mb-1 block text-xs font-medium text-slate-600">Stage</label>
          <Select name="stage" defaultValue={stageFilter ?? ""}>
            <option value="">All stages</option>
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-44">
          <label className="mb-1 block text-xs font-medium text-slate-600">Source</label>
          <Select name="source" defaultValue={sourceFilter ?? ""}>
            <option value="">All sources</option>
            {Object.entries(SOURCE_META).map(([v, m]) => (
              <option key={v} value={v}>
                {m.icon} {m.label}
              </option>
            ))}
          </Select>
        </div>
        <button type="submit" className={buttonClass("secondary", "md")}>
          Filter
        </button>
        <Link
          href={searchParams.archived === "1" ? "/leads" : "/leads?archived=1"}
          className="rounded-full border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
        >
          {searchParams.archived === "1" ? "← Back to active leads" : "📦 Show archived"}
        </Link>
        {(stageFilter || sourceFilter) && (
          <Link href="/leads" className={buttonClass("ghost", "md")}>
            Clear
          </Link>
        )}
      </form>

      <Card>
        {leads.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No leads match" hint="Try clearing filters, or create a new lead." />
          </div>
        ) : (
          <>
          {/* Mobile: card list with thumb-sized rows */}
          <ul className="divide-y divide-slate-100 md:hidden">
            {leads.map((l) => (
              <li key={l.id}>
                <Link href={`/leads/${l.id}`} className="block px-4 py-3 active:bg-slate-50">
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium text-slate-900">{l.title}</span>
                    <span className="shrink-0 font-medium tabular-nums text-slate-700">{money(l.estValueCents)}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <Badge tone={leadStageTone[l.stage]}>{statusLabel(l.stage)}</Badge>
                    <SourceBadge source={l.source} />
                    <SlaBadge respondBy={l.respondBy} firstTouchAt={l.firstTouchAt} />
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    {l.contactName} · {l.phone ?? l.email ?? "no contact info"}
                    {l.assignedTo ? ` · ${l.assignedTo.name.split(" ")[0]}` : " · Unassigned"}
                    {l.techFlagged && l.spiffCents ? ` · 💰 ${money(l.spiffCents)} spiff` : ""}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          {/* Desktop: full table */}
          <div className="hidden md:block">
          <Table>
            <THead cols={["Lead", "Stage", "Source", "Contact", "Est. value", "Rep", "SLA"]} />
            <tbody>
              {leads.map((l) => (
                <TRow key={l.id}>
                  <TCell>
                    <Link href={`/leads/${l.id}`} className="font-medium text-slate-900 hover:text-blue-600">
                      {l.title}
                    </Link>
                    {l.customer ? <div className="text-xs text-slate-500">👤 {l.customer.name}</div> : null}
                  </TCell>
                  <TCell>
                    <Badge tone={leadStageTone[l.stage]}>{statusLabel(l.stage)}</Badge>
                  </TCell>
                  <TCell>
                    <SourceBadge source={l.source} />
                    {l.techFlagged && l.spiffCents ? (
                      <div className="mt-1 text-[11px] font-medium text-violet-600">
                        💰 {money(l.spiffCents)} tech spiff
                      </div>
                    ) : null}
                  </TCell>
                  <TCell>
                    <div className="text-slate-800">{l.contactName}</div>
                    <div className="text-xs text-slate-500">{l.phone ?? l.email ?? "—"}</div>
                  </TCell>
                  <TCell>
                    <span className="font-medium tabular-nums">{money(l.estValueCents)}</span>
                  </TCell>
                  <TCell>
                    {l.assignedTo ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Avatar name={l.assignedTo.name} size="sm" />
                        <span className="text-xs">{l.assignedTo.name.split(" ")[0]}</span>
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400">Unassigned</span>
                    )}
                  </TCell>
                  <TCell>
                    <SlaBadge respondBy={l.respondBy} firstTouchAt={l.firstTouchAt} />
                  </TCell>
                </TRow>
              ))}
            </tbody>
          </Table>
          </div>
          </>
        )}
      </Card>
    </div>
  );
}
