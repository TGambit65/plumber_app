import Link from "next/link";
import { t, withTenant } from "@/db";
import { desc, isNull } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { money } from "@/lib/format";
import { Avatar, Badge, PageHeader, leadStageTone, statusLabel } from "@/components/ui";
import { Forbidden, SOURCE_META } from "@/components/sales/meta";
import { moveLeadStage, setLeadStage } from "@/lib/actions/sales";
import { clsx } from "@/lib/clsx";

export const dynamic = "force-dynamic";

const STAGES = ["NEW", "CONTACTED", "ESTIMATE_SCHEDULED", "ESTIMATE_SENT", "FOLLOW_UP", "WON", "LOST"] as const;

const COLUMN_ACCENT: Record<string, string> = {
  NEW: "border-t-blue-400",
  CONTACTED: "border-t-cyan-400",
  ESTIMATE_SCHEDULED: "border-t-violet-400",
  ESTIMATE_SENT: "border-t-amber-400",
  FOLLOW_UP: "border-t-orange-400",
  WON: "border-t-emerald-400",
  LOST: "border-t-red-400",
};

function daysInStage(lead: { lastContactAt: Date | null; createdAt: Date }): number {
  const since = lead.lastContactAt ?? lead.createdAt;
  return Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 86_400_000));
}

export default async function PipelinePage() {
  const session = await requireSession();
  if (!can(session.role, "pipeline.manage")) return <Forbidden />;

  const leads = await withTenant(session.organizationId, (tx) =>
    tx.query.leads.findMany({
      // M1: archived leads never appear on the board.
      where: isNull(t.leads.archivedAt),
      with: { assignedTo: true },
      orderBy: [desc(t.leads.createdAt)],
    })
  );

  const totalOpen = leads
    .filter((l) => !["WON", "LOST"].includes(l.stage))
    .reduce((s, l) => s + (l.estValueCents ?? 0), 0);

  return (
    <div>
      <PageHeader
        title="📊 Pipeline"
        subtitle={`${money(totalOpen)} in open pipeline — move cards with ◀ ▶`}
      />

      <div className="board-scroll -mx-4 overflow-x-auto px-4 pb-4 md:-mx-6 md:px-6">
        <div className="flex min-w-max gap-3">
          {STAGES.map((stage) => {
            const cards = leads.filter((l) => l.stage === stage);
            const value = cards.reduce((s, l) => s + (l.estValueCents ?? 0), 0);
            const idx = STAGES.indexOf(stage);
            return (
              <div
                key={stage}
                className={clsx(
                  "w-72 shrink-0 rounded-xl border border-slate-200 border-t-4 bg-slate-50/70",
                  COLUMN_ACCENT[stage]
                )}
              >
                <div className="flex items-center justify-between px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-slate-700">
                      {statusLabel(stage)}
                    </span>
                    <Badge tone={leadStageTone[stage]}>{cards.length}</Badge>
                  </div>
                  <span className="text-xs font-medium tabular-nums text-slate-500">{money(value)}</span>
                </div>
                <div className="space-y-2 px-2 pb-2">
                  {cards.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-slate-200 px-3 py-6 text-center text-xs text-slate-400">
                      Empty
                    </div>
                  ) : (
                    cards.map((l) => {
                      const days = daysInStage(l);
                      const src = SOURCE_META[l.source] ?? { icon: "📌", label: l.source };
                      return (
                        <div key={l.id} className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
                          <Link
                            href={`/leads/${l.id}`}
                            className="block text-sm font-medium leading-snug text-slate-900 hover:text-blue-600"
                          >
                            {l.title}
                          </Link>
                          <div className="mt-1 text-xs text-slate-500">{l.contactName}</div>
                          <div className="mt-2 flex items-center gap-2 text-xs">
                            <span className="font-semibold tabular-nums text-slate-800">{money(l.estValueCents)}</span>
                            <span title={src.label} className={l.source === "GOOGLE_LSA" ? "font-bold text-blue-600" : ""}>
                              {src.icon}
                            </span>
                            <span
                              className={clsx(
                                "ml-auto tabular-nums",
                                days >= 7 ? "font-medium text-red-600" : days >= 3 ? "text-amber-600" : "text-slate-400"
                              )}
                              title="Days in stage"
                            >
                              {days}d
                            </span>
                            {l.assignedTo ? <Avatar name={l.assignedTo.name} size="sm" /> : null}
                          </div>
                          {/* M1: jump straight to any stage (LOST requires a reason) */}
                          <details className="mt-2 border-t border-slate-100 pt-2">
                            <summary className="cursor-pointer text-[11px] font-medium text-slate-500 hover:text-blue-600">
                              ⤵ Jump to stage…
                            </summary>
                            <form action={setLeadStage} className="mt-1.5 space-y-1.5">
                              <input type="hidden" name="leadId" value={l.id} />
                              <select
                                name="stage"
                                defaultValue=""
                                required
                                aria-label="Jump to stage"
                                className="h-7 w-full rounded-md border border-slate-300 px-1.5 text-[11px]"
                              >
                                <option value="" disabled>
                                  Choose stage…
                                </option>
                                {STAGES.filter((s) => s !== stage).map((s) => (
                                  <option key={s} value={s}>
                                    {statusLabel(s)}
                                  </option>
                                ))}
                              </select>
                              <input
                                name="lostReason"
                                placeholder="Reason (required for Lost)"
                                aria-label="Lost reason"
                                className="h-7 w-full rounded-md border border-slate-300 px-1.5 text-[11px]"
                              />
                              <button
                                type="submit"
                                className="h-7 w-full rounded-md bg-slate-800 text-[11px] font-medium text-white hover:bg-slate-700"
                              >
                                Move
                              </button>
                            </form>
                          </details>
                          <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-2">
                            <form action={moveLeadStage}>
                              <input type="hidden" name="leadId" value={l.id} />
                              <input type="hidden" name="dir" value="-1" />
                              <button
                                type="submit"
                                disabled={idx === 0}
                                title="Move to previous stage"
                                className="rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 disabled:opacity-30"
                              >
                                ◀
                              </button>
                            </form>
                            <span className="text-[10px] uppercase tracking-wide text-slate-400">move</span>
                            <form action={moveLeadStage}>
                              <input type="hidden" name="leadId" value={l.id} />
                              <input type="hidden" name="dir" value="1" />
                              <button
                                type="submit"
                                disabled={idx === STAGES.length - 1}
                                title="Move to next stage"
                                className="rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 disabled:opacity-30"
                              >
                                ▶
                              </button>
                            </form>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
