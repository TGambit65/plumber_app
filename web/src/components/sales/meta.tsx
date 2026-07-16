/* Shared server-safe presentation helpers for the SALES/PM module. */
import { Badge, type BadgeTone } from "@/components/ui";
import { money } from "@/lib/format";
import { clsx } from "@/lib/clsx";

// ── Lead source ──────────────────────────────────────────────────────────────
export const SOURCE_META: Record<string, { label: string; icon: string }> = {
  PHONE: { label: "Phone", icon: "📞" },
  WEB_FORM: { label: "Web", icon: "🌐" },
  GOOGLE_LSA: { label: "Google LSA", icon: "G" },
  ANGI: { label: "Angi", icon: "🏠" },
  REFERRAL: { label: "Referral", icon: "🤝" },
  TECH_FLAGGED: { label: "Tech-flagged", icon: "🔧" },
  SMS: { label: "SMS", icon: "💬" },
  OTHER: { label: "Other", icon: "📌" },
};

export function SourceBadge({ source }: { source: string }) {
  const meta = SOURCE_META[source] ?? { label: source, icon: "📌" };
  return (
    <Badge tone={source === "TECH_FLAGGED" ? "violet" : "slate"}>
      <span className={source === "GOOGLE_LSA" ? "font-bold text-blue-600" : undefined}>{meta.icon}</span>
      {meta.label}
    </Badge>
  );
}

// ── SLA indicator ────────────────────────────────────────────────────────────
function fmtMins(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  return `${Math.floor(hrs / 24)}d`;
}

export function SlaBadge({
  respondBy,
  firstTouchAt,
}: {
  respondBy: Date | null;
  firstTouchAt: Date | null;
}) {
  if (firstTouchAt) return <Badge tone="green">✓ Responded</Badge>;
  if (!respondBy) return <Badge tone="slate">No SLA</Badge>;
  const mins = Math.round((new Date(respondBy).getTime() - Date.now()) / 60000);
  if (mins < 0) return <Badge tone="red">⏰ SLA breached {fmtMins(-mins)} ago</Badge>;
  return <Badge tone="amber">⏳ Respond in {fmtMins(mins)}</Badge>;
}

// ── Status tone maps not covered by the UI kit ───────────────────────────────
export const changeOrderStatusTone: Record<string, BadgeTone> = {
  DRAFT: "slate",
  PENDING_SIGNATURE: "amber",
  APPROVED: "green",
  REJECTED: "red",
};

export const permitStatusTone: Record<string, BadgeTone> = {
  NOT_APPLIED: "slate",
  APPLIED: "blue",
  ISSUED: "cyan",
  INSPECTION_SCHEDULED: "violet",
  PASSED: "green",
  FAILED: "red",
  CLOSED: "slate",
};

export const milestoneStatusTone: Record<string, BadgeTone> = {
  PENDING: "slate",
  IN_PROGRESS: "blue",
  BLOCKED: "red",
  COMPLETE: "green",
};

export const commissionStatusTone: Record<string, BadgeTone> = {
  PENDING: "amber",
  APPROVED: "blue",
  PAID: "green",
};

// ── Budget health bar ────────────────────────────────────────────────────────
export function BudgetBar({ spentCents, budgetCents }: { spentCents: number; budgetCents: number }) {
  const pct = budgetCents > 0 ? Math.round((spentCents / budgetCents) * 100) : spentCents > 0 ? 999 : 0;
  const color = pct < 80 ? "bg-emerald-500" : pct <= 100 ? "bg-amber-500" : "bg-red-500";
  const textColor = pct < 80 ? "text-emerald-700" : pct <= 100 ? "text-amber-700" : "text-red-700";
  return (
    <div className="min-w-[140px]">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-slate-500">
          {money(spentCents)} / {money(budgetCents)}
        </span>
        <span className={clsx("font-semibold tabular-nums", textColor)}>{pct}%</span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div className={clsx("h-full rounded-full", color)} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  );
}

// ── 403 ──────────────────────────────────────────────────────────────────────
export function Forbidden() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50/50 px-6 py-16 text-center">
      <p className="text-2xl">🔒</p>
      <p className="mt-2 text-sm font-medium text-slate-600">You don&apos;t have access to this page</p>
      <p className="mt-1 text-xs text-slate-400">Ask an admin if you think this is a mistake.</p>
    </div>
  );
}
