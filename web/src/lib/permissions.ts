import type { Role } from "./auth";

/**
 * Permission system per docs/02-user-roles-and-permissions.md.
 * Granular permissions bundled into the four default roles.
 * Scope: "own" = only records the user owns/is assigned; "all" = everything.
 */
export type Permission =
  | "schedule.view.own"
  | "schedule.view.all"
  | "dispatch.manage"
  | "customers.view"
  | "customers.edit"
  | "customers.merge"
  | "leads.create"
  | "pipeline.manage"
  | "estimates.create"
  | "estimates.discount.unlimited"
  | "projects.manage"
  | "jobs.work"
  | "invoices.create"
  | "payments.take"
  | "payments.refund"
  | "inventory.view"
  | "inventory.manage"
  | "pricebook.edit"
  | "kb.view"
  | "kb.author"
  | "commissions.view.own"
  | "commissions.view.all"
  | "commissions.rules.manage"
  | "reports.company"
  | "reports.ar"
  | "users.manage"
  | "integrations.manage"
  | "audit.view";

const TECH: Permission[] = [
  "schedule.view.own",
  "customers.view",
  "leads.create",
  "estimates.create",
  "jobs.work",
  "invoices.create",
  "payments.take",
  "inventory.view",
  "kb.view",
  "commissions.view.own",
];

const SALES_PM: Permission[] = [
  "schedule.view.own",
  "schedule.view.all",
  "customers.view",
  "customers.edit",
  "leads.create",
  "pipeline.manage",
  "estimates.create",
  "projects.manage",
  "invoices.create",
  "payments.take",
  "inventory.view",
  "kb.view",
  "commissions.view.own",
];

const OFFICE: Permission[] = [
  "schedule.view.all",
  "dispatch.manage",
  "customers.view",
  "customers.edit",
  "customers.merge",
  "leads.create",
  "estimates.create",
  "invoices.create",
  "payments.take",
  "inventory.view",
  "inventory.manage",
  "kb.view",
  "kb.author",
  "reports.ar",
];

const ADMIN: Permission[] = Array.from(
  new Set<Permission>([
    ...TECH,
    ...SALES_PM,
    ...OFFICE,
    "estimates.discount.unlimited",
    "payments.refund",
    "pricebook.edit",
    "commissions.view.all",
    "commissions.rules.manage",
    "reports.company",
    "users.manage",
    "integrations.manage",
    "audit.view",
  ])
);

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  TECH,
  SALES_PM,
  OFFICE,
  ADMIN,
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export const ROLE_LABELS: Record<Role, string> = {
  TECH: "Field Technician",
  SALES_PM: "Sales / Project Manager",
  OFFICE: "Office",
  ADMIN: "Admin / Owner",
};

/** Landing page per role after login */
export const ROLE_HOME: Record<Role, string> = {
  TECH: "/my-day",
  SALES_PM: "/cockpit",
  OFFICE: "/dispatch",
  ADMIN: "/dashboard",
};
