"use client";

import { useState, useTransition } from "react";
import { Button, buttonClass } from "@/components/ui";

type Target = { id: string; name: string; role: string };
type Counts = { jobs: number; leads: number; estimates: number };

export function ReassignUser({
  user,
  targets,
  reassign,
  getCounts,
}: {
  user: { id: string; name: string };
  targets: Target[];
  active: boolean;
  reassign: (fd: FormData) => Promise<void>;
  getCounts: (userId: string) => Promise<Counts>;
}) {
  const [open, setOpen] = useState(false);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [toId, setToId] = useState("");
  const [deactivate, setDeactivate] = useState(true);
  const [pending, start] = useTransition();

  function openDialog() {
    setOpen(true);
    getCounts(user.id).then(setCounts).catch(() => setCounts({ jobs: 0, leads: 0, estimates: 0 }));
  }

  function submit() {
    const fd = new FormData();
    fd.set("fromUserId", user.id);
    fd.set("toUserId", toId);
    fd.set("deactivate", String(deactivate));
    start(async () => {
      await reassign(fd);
      setOpen(false);
    });
  }

  const total = counts ? counts.jobs + counts.leads + counts.estimates : null;

  return (
    <>
      <button onClick={openDialog} className={buttonClass("secondary", "sm")}>
        Deactivate / reassign
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(false)}>
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold">Reassign {user.name}&apos;s work</h3>
            <p className="mt-1 text-sm text-slate-500">
              {counts === null ? (
                "Checking open work…"
              ) : total === 0 ? (
                "No open work to reassign."
              ) : (
                <>
                  Open work: <b>{counts.jobs}</b> jobs, <b>{counts.leads}</b> leads, <b>{counts.estimates}</b> estimates.
                </>
              )}
            </p>

            <div className="mt-4 space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Reassign to</label>
                <select
                  value={toId}
                  onChange={(e) => setToId(e.target.value)}
                  className="h-10 w-full rounded-lg border border-slate-300 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">Select a user…</option>
                  {targets.map((tg) => (
                    <option key={tg.id} value={tg.id}>
                      {tg.name} — {tg.role.replace("_", "/")}
                    </option>
                  ))}
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={deactivate} onChange={(e) => setDeactivate(e.target.checked)} className="h-4 w-4" />
                Also deactivate {user.name} after reassigning
              </label>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="danger" onClick={submit} disabled={!toId || pending}>
                {pending ? "Working…" : deactivate ? "Reassign & deactivate" : "Reassign work"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
