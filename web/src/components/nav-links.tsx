"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "@/lib/clsx";
import type { NavItem } from "@/lib/nav";

function Count({ n, className }: { n?: number; className?: string }) {
  if (!n || n <= 0) return null;
  return (
    <span
      className={clsx(
        "inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white",
        className
      )}
    >
      {n > 9 ? "9+" : n}
    </span>
  );
}

export function NavLinks({ items, badges }: { items: NavItem[]; badges?: Record<string, number> }) {
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
              active ? "bg-brand-blue font-medium text-white" : "text-slate-300 hover:bg-slate-800 hover:text-white"
            )}
          >
            <span className="text-base leading-none">{item.icon}</span>
            <span className="flex-1">{item.label}</span>
            <Count n={badges?.[item.href]} />
          </Link>
        );
      })}
    </>
  );
}

export function MobileNav({ items, badges }: { items: NavItem[]; badges?: Record<string, number> }) {
  const pathname = usePathname();
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] md:hidden">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(item.href + "/");
        const n = badges?.[item.href];
        return (
          <Link
            key={item.href}
            href={item.href}
            className={clsx(
              "relative flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium",
              active ? "text-brand-blue" : "text-slate-500"
            )}
          >
            <span className="text-lg leading-none">{item.icon}</span>
            {item.label}
            <Count n={n} className="absolute right-1/2 top-1.5 translate-x-3" />
          </Link>
        );
      })}
    </nav>
  );
}
