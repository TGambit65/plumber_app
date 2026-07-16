import { describe, it, expect } from "vitest";
import { can, ROLE_PERMISSIONS, ROLE_HOME } from "../permissions";

describe("role permission bundles (docs/02 matrix)", () => {
  it("techs can work jobs, take payments, and see own commissions — nothing administrative", () => {
    expect(can("TECH", "jobs.work")).toBe(true);
    expect(can("TECH", "payments.take")).toBe(true);
    expect(can("TECH", "commissions.view.own")).toBe(true);
    expect(can("TECH", "leads.create")).toBe(true); // tech lead-flagging
    expect(can("TECH", "dispatch.manage")).toBe(false);
    expect(can("TECH", "pricebook.edit")).toBe(false);
    expect(can("TECH", "users.manage")).toBe(false);
    expect(can("TECH", "payments.refund")).toBe(false);
    expect(can("TECH", "commissions.view.all")).toBe(false);
  });

  it("sales/PM manage pipeline and projects but not users or the price book", () => {
    expect(can("SALES_PM", "pipeline.manage")).toBe(true);
    expect(can("SALES_PM", "projects.manage")).toBe(true);
    expect(can("SALES_PM", "estimates.create")).toBe(true);
    expect(can("SALES_PM", "pricebook.edit")).toBe(false);
    expect(can("SALES_PM", "users.manage")).toBe(false);
    expect(can("SALES_PM", "integrations.manage")).toBe(false);
  });

  it("office manages dispatch, inventory, AR — not commissions rules or integrations", () => {
    expect(can("OFFICE", "dispatch.manage")).toBe(true);
    expect(can("OFFICE", "inventory.manage")).toBe(true);
    expect(can("OFFICE", "reports.ar")).toBe(true);
    expect(can("OFFICE", "customers.merge")).toBe(true);
    expect(can("OFFICE", "commissions.rules.manage")).toBe(false);
    expect(can("OFFICE", "reports.company")).toBe(false);
    expect(can("OFFICE", "users.manage")).toBe(false);
  });

  it("admin has every permission any role has", () => {
    const all = new Set([
      ...ROLE_PERMISSIONS.TECH,
      ...ROLE_PERMISSIONS.SALES_PM,
      ...ROLE_PERMISSIONS.OFFICE,
    ]);
    for (const p of all) {
      expect(can("ADMIN", p)).toBe(true);
    }
    expect(can("ADMIN", "users.manage")).toBe(true);
    expect(can("ADMIN", "audit.view")).toBe(true);
    expect(can("ADMIN", "payments.refund")).toBe(true);
  });

  it("each role lands on its own home", () => {
    expect(ROLE_HOME.TECH).toBe("/my-day");
    expect(ROLE_HOME.SALES_PM).toBe("/cockpit");
    expect(ROLE_HOME.OFFICE).toBe("/dispatch");
    expect(ROLE_HOME.ADMIN).toBe("/dashboard");
  });
});
