import { projectPoints, type LatLng } from "@/lib/geo/distance";

/**
 * Day map (dispatch D3) — a compact, fully self-contained SVG plot of the
 * day's stops, one color per tech, connected in visit order. No external map
 * tiles (works offline, zero dependencies); positions are equirectangular-
 * projected lat/lng, north up.
 */

const TECH_COLORS = ["#0057FF", "#0f8a5f", "#b7791f", "#7c3aed", "#be185d", "#0e7490"];

export interface MapStop extends LatLng {
  key: string;
  label: string; // job number
  order: number; // visit order within the tech's day (1-based)
  techIndex: number;
}

export function DayMap({ stops, techs }: { stops: MapStop[]; techs: string[] }) {
  const W = 460;
  const H = 240;
  if (stops.length === 0) {
    return <p className="text-xs text-slate-400">No mappable stops — properties on this day lack coordinates.</p>;
  }
  const pos = projectPoints(stops, W, H);

  // Per-tech polyline in visit order.
  const byTech = new Map<number, MapStop[]>();
  for (const s of stops) {
    const arr = byTech.get(s.techIndex) ?? [];
    arr.push(s);
    byTech.set(s.techIndex, arr);
  }

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-lg border border-slate-200 bg-slate-50" role="img" aria-label="Day map of scheduled stops">
        {Array.from(byTech.entries()).map(([ti, arr]) => {
          const sorted = [...arr].sort((a, b) => a.order - b.order);
          const color = TECH_COLORS[ti % TECH_COLORS.length];
          const path = sorted
            .map((s, i) => {
              const p = pos.get(s.key)!;
              return `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
            })
            .join(" ");
          return (
            <g key={ti}>
              {sorted.length > 1 ? (
                <path d={path} fill="none" stroke={color} strokeWidth="1.5" strokeDasharray="4 3" opacity="0.55" />
              ) : null}
              {sorted.map((s) => {
                const p = pos.get(s.key)!;
                return (
                  <g key={s.key}>
                    <circle cx={p.x} cy={p.y} r="9" fill={color} opacity="0.92" />
                    <text x={p.x} y={p.y + 3.2} textAnchor="middle" fontSize="9" fontWeight="700" fill="#fff">
                      {s.order}
                    </text>
                    <text x={p.x} y={p.y - 12} textAnchor="middle" fontSize="8" fill="#475569">
                      {s.label}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
      <div className="mt-1.5 flex flex-wrap gap-3">
        {techs.map((name, i) =>
          byTech.has(i) ? (
            <span key={i} className="flex items-center gap-1.5 text-xs text-slate-600">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: TECH_COLORS[i % TECH_COLORS.length] }} />
              {name}
            </span>
          ) : null
        )}
      </div>
    </div>
  );
}
