/**
 * Pack-scoped custom fields (constraint 1 — one core, many packs).
 *
 * Trade packs declare typed field definitions in `tradePacks.config.customFields`;
 * values live in a `custom_fields` jsonb column on the entity row (org-scoped,
 * RLS applies row-level). The CORE schema stays trade-neutral: no fuel columns,
 * no plumbing columns — richer domain records (tank capacity, dispenser hose
 * count, …) are pack data, composed from the org's ENABLED packs only.
 *
 * This module is PURE (no server-only/db imports) so validation is unit-tested.
 */

export type CustomFieldKind = "text" | "number" | "select" | "date" | "boolean";

export interface CustomFieldDef {
  /** Storage key inside the jsonb blob — unique within a pack. */
  key: string;
  label: string;
  /** Which core entity the field extends. Equipment today; designed for more. */
  entity: "equipment";
  kind: CustomFieldKind;
  required?: boolean;
  /** For kind "select": the allowed values. */
  options?: string[];
  /** Display unit suffix, e.g. "gal", "GPM". */
  unit?: string;
  /**
   * Restrict to specific equipment kinds (as shipped in the pack's
   * equipmentKinds). Absent/empty → applies to every kind.
   */
  appliesToKinds?: string[];
}

export type CustomFieldValues = Record<string, string | number | boolean>;

/** The defs that apply to one entity instance (e.g. one equipment kind). */
export function applicableDefs(defs: CustomFieldDef[], entity: CustomFieldDef["entity"], kind: string): CustomFieldDef[] {
  return defs.filter(
    (d) => d.entity === entity && (!d.appliesToKinds || d.appliesToKinds.length === 0 || d.appliesToKinds.includes(kind))
  );
}

export type ValidationResult =
  | { ok: true; values: CustomFieldValues }
  | { ok: false; errors: string[] };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate raw string inputs (form data) against the applicable defs.
 * Returns TYPED values ready for jsonb storage. Unknown keys are rejected —
 * a tenant can never write fields its enabled packs don't declare.
 */
export function validateCustomFieldValues(
  defs: CustomFieldDef[],
  entity: CustomFieldDef["entity"],
  kind: string,
  raw: Record<string, string>
): ValidationResult {
  const applicable = applicableDefs(defs, entity, kind);
  const byKey = new Map(applicable.map((d) => [d.key, d]));
  const errors: string[] = [];
  const values: CustomFieldValues = {};

  for (const key of Object.keys(raw)) {
    if (!byKey.has(key)) errors.push(`Unknown field '${key}' for ${entity} kind '${kind}'`);
  }

  for (const def of applicable) {
    const input = (raw[def.key] ?? "").trim();
    if (!input) {
      if (def.required && def.kind !== "boolean") errors.push(`${def.label} is required`);
      else if (def.kind === "boolean") values[def.key] = false; // unchecked checkbox
      continue;
    }
    switch (def.kind) {
      case "text":
        values[def.key] = input;
        break;
      case "number": {
        const n = Number(input);
        if (!Number.isFinite(n)) errors.push(`${def.label} must be a number`);
        else values[def.key] = n;
        break;
      }
      case "select":
        if (!def.options?.includes(input)) {
          errors.push(`${def.label} must be one of: ${(def.options ?? []).join(", ")}`);
        } else values[def.key] = input;
        break;
      case "date":
        if (!DATE_RE.test(input) || Number.isNaN(Date.parse(input))) {
          errors.push(`${def.label} must be a date (YYYY-MM-DD)`);
        } else values[def.key] = input;
        break;
      case "boolean":
        values[def.key] = input === "on" || input === "true" || input === "1";
        break;
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, values };
}

/** Parse a jsonb blob defensively for display (drops non-scalar junk). */
export function readCustomFieldValues(blob: unknown): CustomFieldValues {
  if (!blob || typeof blob !== "object" || Array.isArray(blob)) return {};
  const out: CustomFieldValues = {};
  for (const [k, v] of Object.entries(blob as Record<string, unknown>)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

/** "capacityGal: 10000 gal" style display pairs, in def order. */
export function displayPairs(defs: CustomFieldDef[], entity: CustomFieldDef["entity"], kind: string, blob: unknown) {
  const values = readCustomFieldValues(blob);
  return applicableDefs(defs, entity, kind)
    .filter((d) => values[d.key] !== undefined && values[d.key] !== "")
    .map((d) => ({
      key: d.key,
      label: d.label,
      value:
        typeof values[d.key] === "boolean" ? (values[d.key] ? "Yes" : "No") : `${values[d.key]}${d.unit ? ` ${d.unit}` : ""}`,
    }));
}
