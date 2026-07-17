"use client";

import { useEffect, useState } from "react";
import { clsx } from "@/lib/clsx";
import type { SyncState } from "@/lib/offline/syncClient";

/**
 * Live sync-state chip, driven entirely by the `tradeops-sync` DOM event the
 * sync client emits. Field-visible states:
 *   🟢 Synced · 🟡 N pending · 🔴 Offline — N queued
 */
export function SyncChip({ className }: { className?: string }) {
  const [state, setState] = useState<SyncState | null>(null);

  useEffect(() => {
    const onSync = (e: Event) => setState((e as CustomEvent<SyncState>).detail);
    window.addEventListener("tradeops-sync", onSync as EventListener);
    return () => window.removeEventListener("tradeops-sync", onSync as EventListener);
  }, []);

  const online = state?.online ?? (typeof navigator !== "undefined" ? navigator.onLine : true);
  // A photo capture is a pending item too — count both so nothing looks "synced"
  // while a photo is still queued for upload.
  const pending = (state?.pending ?? 0) + (state?.pendingPhotos ?? 0);
  const inFlight = state?.inFlight ?? false;

  let tone: string;
  let label: string;
  if (!online) {
    tone = "bg-red-50 text-red-700 border-red-200";
    label = `🔴 Offline${pending > 0 ? ` — ${pending} queued` : ""}`;
  } else if (inFlight) {
    tone = "bg-blue-50 text-blue-700 border-blue-200";
    label = `⏳ Syncing${pending > 0 ? ` ${pending}` : ""}…`;
  } else if (pending > 0) {
    tone = "bg-amber-50 text-amber-800 border-amber-200";
    label = `🟡 ${pending} pending`;
  } else {
    tone = "bg-emerald-50 text-emerald-700 border-emerald-200";
    label = "🟢 Synced";
  }

  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium",
        tone,
        className
      )}
      title={state?.lastError ? `Last error: ${state.lastError}` : undefined}
    >
      {label}
    </span>
  );
}
