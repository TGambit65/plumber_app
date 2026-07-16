"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "@/lib/clsx";
import type { NavItem } from "@/lib/nav";

export function NavLinks({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <>
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(item.href + "/");
        return (
          <Link
            key={item.href}
            href={item.href}
            className={clsx(
              "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
              active ? "bg-blue-600 font-medium text-white" : "text-slate-300 hover:bg-slate-800 hover:text-white"
            )}
          >
            <span className="text-base leading-none">{item.icon}</span>
            {item.label}
          </Link>
        );
      })}
    </>
  );
}

export function MobileNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] md:hidden">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(item.href + "/");
        return (
          <Link
            key={item.href}
            href={item.href}
            className={clsx(
              "flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium",
              active ? "text-blue-600" : "text-slate-500"
            )}
          >
            <span className="text-lg leading-none">{item.icon}</span>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
