"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { markAllNotificationsRead } from "@/lib/actions/notifications";

type Item = { id: string; title: string; body: string | null; href: string | null; createdAt: Date };

export function NotificationsBell({ items }: { items: Item[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative flex h-10 w-10 items-center justify-center rounded-lg text-lg transition-colors hover:bg-slate-100"
        aria-label="Notifications"
      >
        🔔
        {items.length > 0 && (
          <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {items.length}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-12 z-50 w-80 rounded-xl border border-slate-200 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Notifications</span>
            {items.length > 0 && (
              <form action={markAllNotificationsRead}>
                <button className="text-xs font-medium text-blue-600 hover:underline">Mark all read</button>
              </form>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-slate-400">You&apos;re all caught up 🎉</p>
            ) : (
              items.map((n) => (
                <Link
                  key={n.id}
                  href={n.href ?? "#"}
                  onClick={() => setOpen(false)}
                  className="block border-b border-slate-50 px-3 py-2.5 transition-colors hover:bg-slate-50"
                >
                  <div className="text-sm font-medium text-slate-800">{n.title}</div>
                  {n.body ? <div className="mt-0.5 text-xs text-slate-500">{n.body}</div> : null}
                </Link>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
