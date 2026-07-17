"use client";

import { useState } from "react";
import { startConversation } from "@/lib/actions/messages";
import { Button, buttonClass } from "@/components/ui";
import { ROLE_LABELS } from "@/lib/permissions";
import type { Role } from "@/lib/auth";

type U = { id: string; name: string; role: Role };

export function NewMessage({ users }: { users: U[] }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  function toggle(id: string) {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  return (
    <>
      <button onClick={() => setOpen(true)} className={buttonClass("primary", "md")}>
        ✏️ New message
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={() => setOpen(false)}>
          <div
            className="w-full max-w-md rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-base font-semibold">New message</h3>
              <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-600">✕</button>
            </div>
            <form action={startConversation} className="space-y-3">
              <div>
                <p className="mb-1 text-xs font-medium text-slate-600">
                  To {selected.length > 1 ? `(group of ${selected.length})` : ""}
                </p>
                <div className="max-h-52 overflow-y-auto rounded-lg border border-slate-200">
                  {users.map((u) => (
                    <label key={u.id} className="flex cursor-pointer items-center gap-2 border-b border-slate-50 px-3 py-2 last:border-0 hover:bg-slate-50">
                      <input
                        type="checkbox"
                        name="recipients"
                        value={u.id}
                        checked={selected.includes(u.id)}
                        onChange={() => toggle(u.id)}
                        className="h-4 w-4"
                      />
                      <span className="text-sm text-slate-800">{u.name}</span>
                      <span className="ml-auto text-xs text-slate-400">{ROLE_LABELS[u.role]}</span>
                    </label>
                  ))}
                </div>
              </div>
              {selected.length > 1 ? (
                <input
                  name="title"
                  placeholder="Group name (optional)"
                  className="h-10 w-full rounded-lg border border-slate-300 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              ) : null}
              <textarea
                name="body"
                required
                rows={3}
                placeholder="Type your message…"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={selected.length === 0}>
                  Send
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
