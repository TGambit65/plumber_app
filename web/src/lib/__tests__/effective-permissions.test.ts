import { describe, it, expect } from "vitest";
import { ROLE_PERMISSIONS, type Permission } from "../permissions";

/**
 * Unit test for the override-merge logic (pure function form).
 * Mirrors effectivePermissions() without the DB dependency.
 */
function merge(role: keyof typeof ROLE_PERMISSIONS, overrides: { permission: Permission; granted: boolean }[]) {
  const set = new Set<Permission>(ROLE_PERMISSIONS[role]);
  for (const o of overrides) {
    if (o.granted) set.add(o.permission);
    else set.delete(o.permission);
  }
  return set;
}

describe("effective permissions (role ± overrides)", () => {
  it("grant adds a permission the role lacks", () => {
    const set = merge("TECH", [{ permission: "pricebook.edit", granted: true }]);
    expect(set.has("pricebook.edit")).toBe(true);
  });

  it("revoke removes a permission the role has", () => {
    expect(ROLE_PERMISSIONS.OFFICE).toContain("inventory.manage");
    const set = merge("OFFICE", [{ permission: "inventory.manage", granted: false }]);
    expect(set.has("inventory.manage")).toBe(false);
  });

  it("no overrides = role default", () => {
    const set = merge("SALES_PM", []);
    expect(set.has("pipeline.manage")).toBe(true);
    expect(set.has("users.manage")).toBe(false);
  });

  it("grant then the same permission stays granted (idempotent set)", () => {
    const set = merge("TECH", [
      { permission: "reports.company", granted: true },
      { permission: "reports.company", granted: true },
    ]);
    expect(set.has("reports.company")).toBe(true);
  });
});
