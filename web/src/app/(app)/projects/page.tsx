import Link from "next/link";
import { db, t } from "@/db";
import { desc } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { fmtDate, money } from "@/lib/format";
import {
  Badge,
  Card,
  EmptyState,
  PageHeader,
  Table,
  TCell,
  THead,
  TRow,
  statusLabel,
  type BadgeTone,
} from "@/components/ui";
import { BudgetBar, Forbidden } from "@/components/sales/meta";

export const dynamic = "force-dynamic";

const projectStatusTone: Record<string, BadgeTone> = {
  PLANNING: "slate",
  ACTIVE: "blue",
  ON_HOLD: "amber",
  COMPLETED: "green",
  CLOSED: "slate",
};

export default async function ProjectsPage() {
  const session = await requireSession();
  if (!can(session.role, "projects.manage")) return <Forbidden />;

  const projects = await db.query.projects.findMany({
    with: { customer: true, milestones: true, costs: true, changeOrders: true },
    orderBy: [desc(t.projects.createdAt)],
  });

  return (
    <div>
      <PageHeader
        title="🏗️ Projects"
        subtitle="Milestones, budgets, permits & change orders for larger jobs"
      />

      <Card>
        {projects.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No projects yet" hint="Larger sold jobs (repipes, remodels, commercial) live here." />
          </div>
        ) : (
          <Table>
            <THead cols={["Project", "Customer", "Status", "Contract value", "Budget health", "Milestones"]} />
            <tbody>
              {projects.map((p) => {
                const approvedCOs = p.changeOrders
                  .filter((c) => c.status === "APPROVED")
                  .reduce((s, c) => s + c.amountCents, 0);
                const contract = p.contractValueCents + approvedCOs;
                const spent = p.costs.reduce((s, c) => s + c.amountCents, 0);
                const budget = p.budgetLaborCents + p.budgetMaterialsCents + approvedCOs;
                const done = p.milestones.filter((m) => m.status === "COMPLETE").length;
                return (
                  <TRow key={p.id}>
                    <TCell>
                      <Link href={`/projects/${p.id}`} className="font-medium text-blue-600 hover:underline">
                        {p.name}
                      </Link>
                      <div className="text-xs text-slate-500">
                        {fmtDate(p.startDate)} → {fmtDate(p.endDate)}
                      </div>
                    </TCell>
                    <TCell>{p.customer.name}</TCell>
                    <TCell>
                      <Badge tone={projectStatusTone[p.status]}>{statusLabel(p.status)}</Badge>
                    </TCell>
                    <TCell>
                      <span className="font-semibold tabular-nums">{money(contract)}</span>
                      {approvedCOs > 0 ? (
                        <div className="text-xs text-slate-500">incl. {money(approvedCOs)} in COs</div>
                      ) : null}
                    </TCell>
                    <TCell>
                      <BudgetBar spentCents={spent} budgetCents={budget} />
                    </TCell>
                    <TCell>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium tabular-nums">
                          {done}/{p.milestones.length}
                        </span>
                        <div className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-100">
                          <div
                            className="h-full rounded-full bg-blue-500"
                            style={{
                              width: `${p.milestones.length ? Math.round((done / p.milestones.length) * 100) : 0}%`,
                            }}
                          />
                        </div>
                      </div>
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
