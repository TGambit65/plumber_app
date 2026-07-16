import type * as schema from "@/db/schema";
import { timeAgo } from "@/lib/format";
import { EmptyState } from "@/components/ui";

type Activity = typeof schema.activities.$inferSelect & {
  user?: typeof schema.users.$inferSelect | null;
};

export const ACTIVITY_ICONS: Record<string, string> = {
  CALL: "📞",
  SMS: "💬",
  EMAIL: "✉️",
  NOTE: "📝",
  STATUS: "🔄",
  SYSTEM: "⚙️",
  ESTIMATE_VIEW: "👁",
  PAYMENT: "💳",
  REVIEW: "⭐",
};

/** Unified activity timeline (server component). */
export function ActivityTimeline({ activities }: { activities: Activity[] }) {
  if (activities.length === 0) {
    return <EmptyState title="No activity yet" hint="Calls, notes, payments and system events will appear here." />;
  }
  return (
    <ol className="space-y-3">
      {activities.map((a) => (
        <li key={a.id} className="flex gap-3">
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm"
            title={a.kind}
            aria-label={a.kind}
          >
            {ACTIVITY_ICONS[a.kind] ?? "•"}
          </span>
          <div className="min-w-0 flex-1 border-b border-slate-100 pb-3">
            <p className="text-sm text-slate-800">{a.body}</p>
            <p className="mt-0.5 text-xs text-slate-400">
              {a.user ? `${a.user.name} · ` : ""}
              {timeAgo(a.createdAt)}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}
