"use client";

import { useMemo, useState } from "react";
import { Button, Field, Input, Select } from "@/components/ui";
import { applicableDefs, type CustomFieldDef } from "@/lib/custom-fields";

/**
 * Add-equipment form with PACK-SCOPED CUSTOM FIELDS: the selected equipment
 * kind drives which of the org's enabled-pack field definitions render.
 * Values submit as cf_<key> and are re-validated server-side (addEquipment) —
 * this component is display logic only, never the trust boundary.
 */
export function EquipmentForm({
  customerId,
  propertyId,
  kinds,
  defs,
  action,
}: {
  customerId: string;
  propertyId: string;
  kinds: string[];
  defs: CustomFieldDef[];
  action: (formData: FormData) => Promise<void>;
}) {
  const [kind, setKind] = useState(kinds[0] ?? "");
  const fields = useMemo(() => applicableDefs(defs, "equipment", kind), [defs, kind]);

  if (kinds.length === 0) {
    return <p className="text-xs text-slate-500">Enable a trade pack with equipment kinds to add equipment.</p>;
  }

  return (
    <form action={action} className="mt-2 grid gap-2 sm:grid-cols-2">
      <input type="hidden" name="customerId" value={customerId} />
      <input type="hidden" name="propertyId" value={propertyId} />
      <Field label="Kind">
        <Select name="kind" value={kind} onChange={(e) => setKind(e.target.value)} required>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Brand">
        <Input name="brand" placeholder="e.g. Rheem" />
      </Field>
      <Field label="Model">
        <Input name="model" />
      </Field>
      <Field label="Serial #">
        <Input name="serial" />
      </Field>
      <Field label="Installed on">
        <Input name="installedAt" type="date" />
      </Field>
      <Field label="Notes">
        <Input name="notes" />
      </Field>

      {fields.length > 0 ? (
        <div className="sm:col-span-2 rounded-lg border border-slate-200 bg-slate-50 p-2">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
            {kind} details <span className="normal-case">(from your trade packs)</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {fields.map((d) => (
              <Field key={d.key} label={`${d.label}${d.unit ? ` (${d.unit})` : ""}${d.required ? " *" : ""}`}>
                {d.kind === "select" ? (
                  <Select name={`cf_${d.key}`} required={d.required} defaultValue="">
                    <option value="" disabled>
                      Select…
                    </option>
                    {(d.options ?? []).map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </Select>
                ) : d.kind === "boolean" ? (
                  <label className="flex h-9 items-center gap-2 text-sm text-slate-700">
                    <input type="checkbox" name={`cf_${d.key}`} className="h-4 w-4 rounded border-slate-300" />
                    Yes
                  </label>
                ) : (
                  <Input
                    name={`cf_${d.key}`}
                    type={d.kind === "number" ? "number" : d.kind === "date" ? "date" : "text"}
                    step={d.kind === "number" ? "any" : undefined}
                    required={d.required}
                  />
                )}
              </Field>
            ))}
          </div>
        </div>
      ) : null}

      <div className="sm:col-span-2">
        <Button type="submit" size="sm">
          Add equipment
        </Button>
      </div>
    </form>
  );
}
