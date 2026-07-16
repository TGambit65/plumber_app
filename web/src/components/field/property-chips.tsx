import type { t } from "@/db";

type Property = typeof t.properties.$inferSelect;

/** "At the door" property-memory chips — gate code, pets, shutoff, parking, access. */
export function PropertyChips({ property, className }: { property: Property; className?: string }) {
  const chips: { icon: string; label: string }[] = [];
  if (property.gateCode) chips.push({ icon: "🔑", label: `Gate ${property.gateCode}` });
  if (property.petNotes) chips.push({ icon: "🐕", label: property.petNotes });
  if (property.shutoffLocation) chips.push({ icon: "🚰", label: property.shutoffLocation });
  if (property.parkingNotes) chips.push({ icon: "🅿️", label: property.parkingNotes });
  if (property.accessNotes) chips.push({ icon: "🚪", label: property.accessNotes });
  if (chips.length === 0) return null;
  return (
    <div className={`flex flex-wrap gap-1.5 ${className ?? ""}`}>
      {chips.map((c, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-900 ring-1 ring-amber-200"
        >
          <span>{c.icon}</span>
          {c.label}
        </span>
      ))}
    </div>
  );
}
