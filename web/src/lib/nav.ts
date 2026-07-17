import type { Role } from "./auth";
import type { Permission } from "./permissions";

export type NavItem = { href: string; label: string; icon: string };

/** Role-aware navigation. Icons are emoji for zero-dependency clarity. */
export const NAV: Record<Role, NavItem[]> = {
  TECH: [
    { href: "/my-day", label: "My Day", icon: "🗓️" },
    { href: "/field", label: "Field Mode", icon: "📴" },
    { href: "/inventory", label: "Truck Stock", icon: "🧰" },
    { href: "/kb", label: "Knowledge", icon: "📖" },
    { href: "/messages", label: "Messages", icon: "💬" },
    { href: "/earnings", label: "Earnings", icon: "💵" },
  ],
  SALES_PM: [
    { href: "/cockpit", label: "Cockpit", icon: "🎯" },
    { href: "/leads", label: "Leads", icon: "📥" },
    { href: "/pipeline", label: "Pipeline", icon: "📊" },
    { href: "/estimates", label: "Estimates", icon: "📝" },
    { href: "/projects", label: "Projects", icon: "🏗️" },
    { href: "/claims", label: "Claims", icon: "🛡️" },
    { href: "/customers", label: "Customers", icon: "👥" },
    { href: "/messages", label: "Messages", icon: "💬" },
    { href: "/kb", label: "Knowledge", icon: "📖" },
    { href: "/earnings", label: "Earnings", icon: "💵" },
  ],
  OFFICE: [
    { href: "/dispatch", label: "Dispatch", icon: "🚚" },
    { href: "/approvals", label: "Approvals", icon: "✉️" },
    { href: "/jobs", label: "Jobs", icon: "🔧" },
    { href: "/customers", label: "Customers", icon: "👥" },
    { href: "/leads", label: "Leads", icon: "📥" },
    { href: "/invoices", label: "Invoices & AR", icon: "🧾" },
    { href: "/claims", label: "Claims", icon: "🛡️" },
    { href: "/compliance", label: "Compliance", icon: "✅" },
    { href: "/inventory", label: "Inventory", icon: "🧰" },
    { href: "/messages", label: "Messages", icon: "💬" },
    { href: "/kb", label: "Knowledge", icon: "📖" },
  ],
  ADMIN: [
    { href: "/dashboard", label: "Dashboard", icon: "📈" },
    { href: "/dispatch", label: "Dispatch", icon: "🚚" },
    { href: "/approvals", label: "Approvals", icon: "✉️" },
    { href: "/pipeline", label: "Pipeline", icon: "📊" },
    { href: "/jobs", label: "Jobs", icon: "🔧" },
    { href: "/projects", label: "Projects", icon: "🏗️" },
    { href: "/customers", label: "Customers", icon: "👥" },
    { href: "/invoices", label: "Invoices & AR", icon: "🧾" },
    { href: "/claims", label: "Claims", icon: "🛡️" },
    { href: "/compliance", label: "Compliance", icon: "✅" },
    { href: "/inventory", label: "Inventory", icon: "🧰" },
    { href: "/pricebook", label: "Price Book", icon: "📗" },
    { href: "/commissions", label: "Commissions", icon: "💵" },
    { href: "/messages", label: "Messages", icon: "💬" },
    { href: "/kb", label: "Knowledge", icon: "📖" },
    { href: "/settings", label: "Settings", icon: "⚙️" },
  ],
};

/** Nav items unlocked by a permission override the base role lacks. */
const PERMISSION_NAV: { permission: Permission; item: NavItem }[] = [
  { permission: "reports.company", item: { href: "/dashboard", label: "Dashboard", icon: "📈" } },
  { permission: "pricebook.edit", item: { href: "/pricebook", label: "Price Book", icon: "📗" } },
  { permission: "commissions.view.all", item: { href: "/commissions", label: "Commissions", icon: "💵" } },
  { permission: "schedule.view.all", item: { href: "/dispatch", label: "Dispatch", icon: "🚚" } },
  { permission: "reports.ar", item: { href: "/invoices", label: "Invoices & AR", icon: "🧾" } },
  { permission: "claims.manage", item: { href: "/claims", label: "Claims", icon: "🛡️" } },
  { permission: "approvals.manage", item: { href: "/approvals", label: "Approvals", icon: "✉️" } },
  { permission: "compliance.manage", item: { href: "/compliance", label: "Compliance", icon: "✅" } },
];

/** Build nav for a user, adding items unlocked by permission overrides. */
export function navForUser(role: Role, perms: Set<Permission>): NavItem[] {
  const items = [...NAV[role]];
  const hrefs = new Set(items.map((i) => i.href));
  for (const { permission, item } of PERMISSION_NAV) {
    if (perms.has(permission) && !hrefs.has(item.href)) {
      items.splice(items.length - 1, 0, item); // insert before last (usually Settings/Earnings)
      hrefs.add(item.href);
    }
  }
  return items;
}
