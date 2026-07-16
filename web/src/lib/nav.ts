import type { Role } from "./auth";

export type NavItem = { href: string; label: string; icon: string };

/** Role-aware navigation. Icons are emoji for zero-dependency clarity. */
export const NAV: Record<Role, NavItem[]> = {
  TECH: [
    { href: "/my-day", label: "My Day", icon: "🗓️" },
    { href: "/inventory", label: "Truck Stock", icon: "🧰" },
    { href: "/kb", label: "Knowledge", icon: "📖" },
    { href: "/earnings", label: "Earnings", icon: "💵" },
  ],
  SALES_PM: [
    { href: "/cockpit", label: "Cockpit", icon: "🎯" },
    { href: "/leads", label: "Leads", icon: "📥" },
    { href: "/pipeline", label: "Pipeline", icon: "📊" },
    { href: "/estimates", label: "Estimates", icon: "📝" },
    { href: "/projects", label: "Projects", icon: "🏗️" },
    { href: "/customers", label: "Customers", icon: "👥" },
    { href: "/kb", label: "Knowledge", icon: "📖" },
    { href: "/earnings", label: "Earnings", icon: "💵" },
  ],
  OFFICE: [
    { href: "/dispatch", label: "Dispatch", icon: "🚚" },
    { href: "/jobs", label: "Jobs", icon: "🔧" },
    { href: "/customers", label: "Customers", icon: "👥" },
    { href: "/leads", label: "Leads", icon: "📥" },
    { href: "/invoices", label: "Invoices & AR", icon: "🧾" },
    { href: "/inventory", label: "Inventory", icon: "🧰" },
    { href: "/kb", label: "Knowledge", icon: "📖" },
  ],
  ADMIN: [
    { href: "/dashboard", label: "Dashboard", icon: "📈" },
    { href: "/dispatch", label: "Dispatch", icon: "🚚" },
    { href: "/pipeline", label: "Pipeline", icon: "📊" },
    { href: "/jobs", label: "Jobs", icon: "🔧" },
    { href: "/projects", label: "Projects", icon: "🏗️" },
    { href: "/customers", label: "Customers", icon: "👥" },
    { href: "/invoices", label: "Invoices & AR", icon: "🧾" },
    { href: "/inventory", label: "Inventory", icon: "🧰" },
    { href: "/pricebook", label: "Price Book", icon: "📗" },
    { href: "/commissions", label: "Commissions", icon: "💵" },
    { href: "/kb", label: "Knowledge", icon: "📖" },
    { href: "/settings", label: "Settings", icon: "⚙️" },
  ],
};
