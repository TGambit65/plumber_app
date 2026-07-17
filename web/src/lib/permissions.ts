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

/** Human labels for every permission — used by the per-user override UI. */
export const PERMISSION_LABELS: Record<Permission, string> = {
  "schedule.view.own": "View own schedule",
  "schedule.view.all": "View all schedules",
  "dispatch.manage": "Manage dispatch board",
  "customers.view": "View customers",
  "customers.edit": "Create/edit customers",
  "customers.merge": "Merge/delete customers",
  "leads.create": "Create leads",
  "pipeline.manage": "Manage pipeline & follow-ups",
  "estimates.create": "Build & send estimates",
  "estimates.discount.unlimited": "Discount beyond threshold",
  "projects.manage": "Manage projects",
  "jobs.work": "Work jobs (field)",
  "invoices.create": "Create invoices",
  "payments.take": "Take payments",
  "payments.refund": "Issue refunds",
  "inventory.view": "View inventory",
  "inventory.manage": "Manage inventory & POs",
  "pricebook.edit": "Edit price book",
  "kb.view": "View knowledge base",
  "kb.author": "Author/approve SOPs",
  "commissions.view.own": "View own commissions",
  "commissions.view.all": "View all commissions",
  "commissions.rules.manage": "Manage commission rules",
  "reports.company": "Company dashboards",
  "reports.ar": "AR reporting",
  "users.manage": "Manage users",
  "integrations.manage": "Manage integrations",
  "audit.view": "View audit log",
};

/** Permissions grouped for the override UI. */
export const PERMISSION_GROUPS: { label: string; permissions: Permission[] }[] = [
  { label: "Scheduling & dispatch", permissions: ["schedule.view.own", "schedule.view.all", "dispatch.manage"] },
  { label: "Customers", permissions: ["customers.view", "customers.edit", "customers.merge"] },
  { label: "Sales", permissions: ["leads.create", "pipeline.manage", "estimates.create", "estimates.discount.unlimited", "projects.manage"] },
  { label: "Field & money", permissions: ["jobs.work", "invoices.create", "payments.take", "payments.refund"] },
  { label: "Inventory & pricing", permissions: ["inventory.view", "inventory.manage", "pricebook.edit"] },
  { label: "Knowledge", permissions: ["kb.view", "kb.author"] },
  { label: "Money & reporting", permissions: ["commissions.view.own", "commissions.view.all", "commissions.rules.manage", "reports.company", "reports.ar"] },
  { label: "Administration", permissions: ["users.manage", "integrations.manage", "audit.view"] },
];

export const ALL_PERMISSIONS = PERMISSION_GROUPS.flatMap((g) => g.permissions);
