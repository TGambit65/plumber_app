import { money } from "@/lib/format";
import { EmptyState } from "@/components/ui";

/** Simple accessible CSS bar chart — vertical bars (no chart lib). */
export function WeekBarChart({
  data,
  ariaLabel,
}: {
  data: { label: string; valueCents: number }[];
  ariaLabel: string;
}) {
  const max = Math.max(...data.map((d) => d.valueCents), 1);
  if (data.every((d) => d.valueCents === 0)) {
    return <EmptyState title="No revenue recorded yet" hint="Payments will chart here by ISO week." />;
  }
  return (
    <div role="img" aria-label={ariaLabel}>
      <div className="flex items-end gap-2">
        {data.map((d) => {
          // Fixed-pixel bar heights: % heights don't resolve inside auto-height flex children.
          const px = d.valueCents > 0 ? Math.max(Math.round((d.valueCents / max) * 112), 6) : 2;
          return (
            <div key={d.label} className="flex flex-1 flex-col items-center justify-end gap-1" title={`${d.label}: ${money(d.valueCents)}`}>
              <span className="text-[10px] tabular-nums text-slate-500">
                {d.valueCents > 0 ? money(d.valueCents) : ""}
              </span>
              <div
                className={d.valueCents > 0 ? "w-full rounded-t bg-blue-500/80" : "w-full rounded-t bg-slate-200"}
                style={{ height: `${px}px` }}
                aria-hidden="true"
              />
              <span className="sr-only">
                {d.label}: {money(d.valueCents)}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex gap-2">
        {data.map((d) => (
          <div key={d.label} className="flex-1 text-center text-[10px] text-slate-500">
            {d.label}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Small horizontal bar rows (e.g., lead sources). */
export function HBarList({
  rows,
}: {
  rows: { label: string; value: number; display: string; hint?: string }[];
}) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  if (rows.length === 0) return <EmptyState title="Nothing to show yet" />;
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.label}>
          <div className="mb-0.5 flex items-baseline justify-between gap-2 text-xs">
            <span className="font-medium text-slate-700">{r.label}</span>
            <span className="tabular-nums text-slate-500">
              {r.display}
              {r.hint ? <span className="text-slate-400"> · {r.hint}</span> : null}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-blue-500/80"
              style={{ width: `${Math.max(Math.round((r.value / max) * 100), 2)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
