import Link from "next/link";
import { db, t } from "@/db";
import { desc, eq } from "drizzle-orm";
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
  searchParams: { stage?: string; source?: string };
}) {
  const session = await requireSession();
  if (!can(session.role, "leads.create")) return <Forbidden />;

  const stageFilter = STAGES.includes(searchParams.stage ?? "") ? searchParams.stage : undefined;
  const sourceFilter = Object.keys(SOURCE_META).includes(searchParams.source ?? "") ? searchParams.source : undefined;

  const [allLeads, reps] = await Promise.all([
    db.query.leads.findMany({
      with: { assignedTo: true, customer: true },
      orderBy: [desc(t.leads.createdAt)],
    }),
    db.query.users.findMany({ where: eq(t.users.active, true), orderBy: [t.users.name] }),
  ]);

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
        )}
      </Card>
    </div>
  );
}
