"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function GlobalSearch() {
  const router = useRouter();
  const [q, setQ] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (q.trim()) router.push(`/search?q=${encodeURIComponent(q.trim())}`);
      }}
      className="relative hidden sm:block"
    >
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-slate-400">🔍</span>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search customers, jobs, parts, SOPs…"
        className="h-9 w-64 rounded-lg border border-slate-200 bg-slate-50 pl-8 pr-3 text-sm placeholder:text-slate-400 focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
    </form>
  );
}
