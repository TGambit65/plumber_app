import { describe, expect, it } from "vitest";
import {
  applicableDefs,
  displayPairs,
  readCustomFieldValues,
  validateCustomFieldValues,
  type CustomFieldDef,
} from "../custom-fields";

const DEFS: CustomFieldDef[] = [
  { key: "capacityGal", label: "Capacity", entity: "equipment", kind: "number", unit: "gal", required: true, appliesToKinds: ["UST"] },
  { key: "product", label: "Product stored", entity: "equipment", kind: "select", options: ["Gasoline", "Diesel"], required: true, appliesToKinds: ["UST"] },
  { key: "doubleWall", label: "Double-wall", entity: "equipment", kind: "boolean", appliesToKinds: ["UST"] },
  { key: "lastWmSealDate", label: "Last W&M seal", entity: "equipment", kind: "date", appliesToKinds: ["Dispenser"] },
  { key: "assetTag", label: "Asset tag", entity: "equipment", kind: "text" }, // applies to all kinds
];

describe("pack-scoped custom fields", () => {
  it("applicableDefs scopes by equipment kind (empty appliesToKinds = all)", () => {
    const ust = applicableDefs(DEFS, "equipment", "UST").map((d) => d.key);
    expect(ust).toEqual(["capacityGal", "product", "doubleWall", "assetTag"]);
    const disp = applicableDefs(DEFS, "equipment", "Dispenser").map((d) => d.key);
    expect(disp).toEqual(["lastWmSealDate", "assetTag"]);
  });

  it("validates + types the values (number, select, boolean, date)", () => {
    const r = validateCustomFieldValues(DEFS, "equipment", "UST", {
      capacityGal: "12000",
      product: "Gasoline",
      doubleWall: "on",
      assetTag: "T-9",
    });
    expect(r).toEqual({
      ok: true,
      values: { capacityGal: 12000, product: "Gasoline", doubleWall: true, assetTag: "T-9" },
    });
  });

  it("rejects missing required, bad number, bad option, bad date, unknown keys", () => {
    const r = validateCustomFieldValues(DEFS, "equipment", "UST", {
      capacityGal: "twelve",
      product: "Moonshine",
      notAField: "x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join(" | ")).toContain("must be a number");
      expect(r.errors.join(" | ")).toContain("must be one of");
      expect(r.errors.join(" | ")).toContain("Unknown field 'notAField'");
    }

    const missing = validateCustomFieldValues(DEFS, "equipment", "UST", {});
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors.join(" | ")).toContain("Capacity is required");

    const badDate = validateCustomFieldValues(DEFS, "equipment", "Dispenser", { lastWmSealDate: "08/02/2025" });
    expect(badDate.ok).toBe(false);

    // A dispenser-only field is UNKNOWN on a UST — kind scoping is enforced.
    const wrongKind = validateCustomFieldValues(DEFS, "equipment", "UST", {
      capacityGal: "1",
      product: "Diesel",
      lastWmSealDate: "2025-08-02",
    });
    expect(wrongKind.ok).toBe(false);
  });

  it("unchecked boolean stores false; display renders units and Yes/No", () => {
    const r = validateCustomFieldValues(DEFS, "equipment", "UST", { capacityGal: "8000", product: "Diesel" });
    expect(r).toMatchObject({ ok: true, values: { doubleWall: false } });

    const pairs = displayPairs(DEFS, "equipment", "UST", { capacityGal: 8000, product: "Diesel", doubleWall: true });
    expect(pairs).toEqual([
      { key: "capacityGal", label: "Capacity", value: "8000 gal" },
      { key: "product", label: "Product stored", value: "Diesel" },
      { key: "doubleWall", label: "Double-wall", value: "Yes" },
    ]);
  });

  it("readCustomFieldValues drops non-scalar junk defensively", () => {
    expect(readCustomFieldValues({ a: 1, b: "x", c: true, d: { nested: 1 }, e: [1], f: null })).toEqual({
      a: 1,
      b: "x",
      c: true,
    });
    expect(readCustomFieldValues(null)).toEqual({});
    expect(readCustomFieldValues([1, 2])).toEqual({});
  });
});
