"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Card,
  CardBody,
  EmptyState,
  Textarea,
  buttonClass,
  jobStatusTone,
  statusLabel,
} from "@/components/ui";
import { fmtTime } from "@/lib/format";
import { SyncChip } from "./sync-chip";
import { Elapsed } from "./elapsed";
import { idbGetAll } from "@/lib/offline/idb";
import { loadIdMap, newLocalId } from "@/lib/offline/localId";
import {
  enqueue,
  enqueuePhoto,
  runInitialSync,
  startSyncListeners,
  syncNow,
  emitState,
  type QueuedPhoto,
} from "@/lib/offline/syncClient";

// ── Cached shapes (loosely typed — IDB rows are JSON) ─────────────────────────
interface CachedJob {
  id: string;
  number: string;
  status: string;
  priority: string;
  jobType: string;
  description: string | null;
  internalNotes: string | null;
  assignedToId: string | null;
  scheduledAt: string | null;
  completedAt: string | null;
  deletedAt: string | null;
  customer?: { id: string; name: string; phone: string | null } | null;
  property?: { address: string; city: string; state: string; zip: string; gateCode?: string | null; accessNotes?: string | null } | null;
  _pending?: boolean;
}

interface CachedTimeEntry {
  id: string;
  jobId: string | null;
  userId: string;
  kind: string;
  startedAt: string;
  endedAt: string | null;
  deletedAt: string | null;
  _pending?: boolean;
}

const FIELD_FLOW = ["SCHEDULED", "DISPATCHED", "EN_ROUTE", "IN_PROGRESS", "COMPLETED"] as const;
const NEXT_LABEL: Record<string, string> = {
  DISPATCHED: "📋 Accept dispatch",
  EN_ROUTE: "🚗 On my way",
  IN_PROGRESS: "▶️ Arrived — start work",
  COMPLETED: "✅ Mark complete",
};

function nowIso(): string {
  return new Date().toISOString();
}

function isToday(iso: string | null): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

export function FieldWorkspace({
  currentUserId,
  userName,
  role,
}: {
  currentUserId: string;
  userName: string;
  role: string;
}) {
  const [jobs, setJobs] = useState<CachedJob[]>([]);
  const [timeEntries, setTimeEntries] = useState<CachedTimeEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [booted, setBooted] = useState(false);
  const [offlineBoot, setOfflineBoot] = useState(false);

  const reload = useCallback(async () => {
    const [j, te] = await Promise.all([
      idbGetAll<CachedJob>("jobs"),
      idbGetAll<CachedTimeEntry>("timeEntries"),
    ]);
    setJobs(j.filter((x) => !x.deletedAt).sort(sortJobs));
    setTimeEntries(te.filter((x) => !x.deletedAt));
  }, []);

  // Boot: wire listeners, hydrate id map, initial sync (fall back to cache offline).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      startSyncListeners();
      await loadIdMap();
      try {
        await runInitialSync();
      } catch {
        if (!cancelled) setOfflineBoot(true); // no signal / server down — use cache
      }
      if (!cancelled) {
        await reload();
        await emitState();
        setBooted(true);
      }
    })();

    const onSync = () => void reload();
    window.addEventListener("tradeops-sync", onSync);
    return () => {
      cancelled = true;
      window.removeEventListener("tradeops-sync", onSync);
    };
  }, [reload]);

  const selected = jobs.find((j) => j.id === selectedId) ?? null;
  const activeTimer = timeEntries.find(
    (te) => te.jobId === selectedId && te.userId === currentUserId && !te.endedAt
  );

  // ── Actions (all write locally first via enqueue) ──────────────────────────
  const advance = useCallback(
    async (job: CachedJob) => {
      const idx = FIELD_FLOW.indexOf(job.status as (typeof FIELD_FLOW)[number]);
      const next = idx >= 0 ? FIELD_FLOW[idx + 1] : undefined;
      if (!next) return;
      setBusy(true);
      const data: Record<string, unknown> = { status: next };
      if (next === "COMPLETED") data.completedAt = nowIso();
      await enqueue({
        entityType: "job",
        entityId: job.id,
        action: "update",
        data,
        clientTimestamp: nowIso(),
      });
      await reload();
      setBusy(false);
    },
    [reload]
  );

  const saveNote = useCallback(
    async (job: CachedJob) => {
      const text = note.trim();
      if (!text) return;
      setBusy(true);
      const stamp = `[${fmtTime(new Date())} · ${userName}] ${text}`;
      const internalNotes = job.internalNotes ? `${job.internalNotes}\n${stamp}` : stamp;
      await enqueue({
        entityType: "job",
        entityId: job.id,
        action: "update",
        data: { internalNotes },
        clientTimestamp: nowIso(),
      });
      setNote("");
      await reload();
      setBusy(false);
    },
    [note, userName, reload]
  );

  const startTimer = useCallback(
    async (job: CachedJob) => {
      setBusy(true);
      const localId = newLocalId();
      await enqueue({
        entityType: "timeEntry",
        entityId: localId,
        localId,
        action: "create",
        data: { jobId: job.id, userId: currentUserId, kind: "WORK", startedAt: nowIso() },
        clientTimestamp: nowIso(),
      });
      await reload();
      setBusy(false);
    },
    [currentUserId, reload]
  );

  const stopTimer = useCallback(
    async (entry: CachedTimeEntry) => {
      setBusy(true);
      await enqueue({
        entityType: "timeEntry",
        entityId: entry.id,
        action: "update",
        data: { endedAt: nowIso() },
        clientTimestamp: nowIso(),
      });
      await reload();
      setBusy(false);
    },
    [reload]
  );

  const doSyncNow = useCallback(async () => {
    setBusy(true);
    try {
      await syncNow();
    } catch {
      /* surfaced via the chip's lastError */
    }
    await reload();
    setBusy(false);
  }, [reload]);

  // ── Render ─────────────────────────────────────────────────────────────────
  const todays = jobs.filter((j) => isToday(j.scheduledAt));
  const rest = jobs.filter((j) => !isToday(j.scheduledAt));

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-4 flex items-center justify-between gap-2">
        <SyncChip />
        <button onClick={doSyncNow} disabled={busy} className={buttonClass("secondary", "md")}>
          🔄 Sync now
        </button>
      </div>

      {offlineBoot ? (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Started from your on-device cache — no signal. Changes are saved locally and will sync
          automatically.
        </div>
      ) : null}

      {!booted ? (
        <EmptyState title="Loading your route…" hint="Fetching today's jobs" />
      ) : selected ? (
        <JobDetail
          job={selected}
          activeTimer={activeTimer ?? null}
          busy={busy}
          note={note}
          onNote={setNote}
          onBack={() => setSelectedId(null)}
          onAdvance={() => advance(selected)}
          onSaveNote={() => saveNote(selected)}
          onStartTimer={() => startTimer(selected)}
          onStopTimer={() => activeTimer && stopTimer(activeTimer)}
        />
      ) : (
        <div className="space-y-6">
          <JobList title="Today" jobs={todays} onOpen={setSelectedId} emptyHint="No jobs scheduled today." />
          {rest.length > 0 ? (
            <JobList title="Other jobs" jobs={rest} onOpen={setSelectedId} />
          ) : null}
          {jobs.length === 0 ? (
            <EmptyState
              title="No cached jobs"
              hint={role === "TECH" ? "Jobs assigned to you will appear here." : "Sync to pull the route."}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

function sortJobs(a: CachedJob, b: CachedJob): number {
  const ta = a.scheduledAt ? new Date(a.scheduledAt).getTime() : Number.MAX_SAFE_INTEGER;
  const tb = b.scheduledAt ? new Date(b.scheduledAt).getTime() : Number.MAX_SAFE_INTEGER;
  return ta - tb;
}

function JobList({
  title,
  jobs,
  onOpen,
  emptyHint,
}: {
  title: string;
  jobs: CachedJob[];
  onOpen: (id: string) => void;
  emptyHint?: string;
}) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-slate-700">{title}</h2>
      {jobs.length === 0 ? (
        emptyHint ? <p className="text-xs text-slate-400">{emptyHint}</p> : null
      ) : (
        <ul className="space-y-2">
          {jobs.map((job) => (
            <li key={job.id}>
              <button
                onClick={() => onOpen(job.id)}
                className="flex min-h-[64px] w-full items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-left shadow-sm active:bg-slate-50"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-slate-900">
                      {job.customer?.name ?? "Customer"}
                    </span>
                    {job._pending ? <Badge tone="amber">pending</Badge> : null}
                  </div>
                  <div className="truncate text-xs text-slate-500">
                    {job.jobType} · {job.property?.address ?? "—"}
                    {job.scheduledAt ? ` · ${fmtTime(job.scheduledAt)}` : ""}
                  </div>
                </div>
                <Badge tone={jobStatusTone[job.status] ?? "slate"}>{statusLabel(job.status)}</Badge>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function JobDetail({
  job,
  activeTimer,
  busy,
  note,
  onNote,
  onBack,
  onAdvance,
  onSaveNote,
  onStartTimer,
  onStopTimer,
}: {
  job: CachedJob;
  activeTimer: CachedTimeEntry | null;
  busy: boolean;
  note: string;
  onNote: (v: string) => void;
  onBack: () => void;
  onAdvance: () => void;
  onSaveNote: () => void;
  onStartTimer: () => void;
  onStopTimer: () => void;
}) {
  const idx = FIELD_FLOW.indexOf(job.status as (typeof FIELD_FLOW)[number]);
  const next = idx >= 0 ? FIELD_FLOW[idx + 1] : undefined;

  return (
    <div className="space-y-4">
      <button onClick={onBack} className={buttonClass("ghost", "md")}>
        ← Back to route
      </button>

      <Card>
        <CardBody className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-base font-semibold text-slate-900">{job.customer?.name ?? "Customer"}</div>
              <div className="text-xs text-slate-500">
                #{job.number} · {job.jobType}
              </div>
            </div>
            <Badge tone={jobStatusTone[job.status] ?? "slate"}>{statusLabel(job.status)}</Badge>
          </div>

          {job.property ? (
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
              {job.property.address}, {job.property.city}, {job.property.state} {job.property.zip}
              {job.property.gateCode ? <div className="mt-1">🔑 Gate: {job.property.gateCode}</div> : null}
              {job.property.accessNotes ? <div className="mt-1">📝 {job.property.accessNotes}</div> : null}
            </div>
          ) : null}

          {job.description ? <p className="text-sm text-slate-700">{job.description}</p> : null}
        </CardBody>
      </Card>

      {/* Status advance */}
      {next ? (
        <button
          onClick={onAdvance}
          disabled={busy}
          className={buttonClass(next === "COMPLETED" ? "success" : "primary", "lg", "w-full")}
        >
          {NEXT_LABEL[next] ?? `Advance to ${statusLabel(next)}`}
        </button>
      ) : (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-center text-sm text-emerald-700">
          {job.status === "COMPLETED" ? "Job completed" : statusLabel(job.status)}
        </div>
      )}

      {/* Timer */}
      <Card>
        <CardBody className="space-y-3">
          <div className="text-sm font-semibold text-slate-700">Time clock</div>
          {activeTimer ? (
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm text-slate-600">
                {statusLabel(activeTimer.kind)} · <Elapsed startedAt={activeTimer.startedAt} className="font-mono tabular-nums" />
              </div>
              <button onClick={onStopTimer} disabled={busy} className={buttonClass("danger", "lg")}>
                ⏹ Stop
              </button>
            </div>
          ) : (
            <button onClick={onStartTimer} disabled={busy} className={buttonClass("primary", "lg", "w-full")}>
              ⏱ Start work timer
            </button>
          )}
        </CardBody>
      </Card>

      {/* Photos — capture works offline; uploads drain on reconnect */}
      <JobPhotos jobId={job.id} />

      {/* Notes */}
      <Card>
        <CardBody className="space-y-3">
          <div className="text-sm font-semibold text-slate-700">Notes</div>
          {job.internalNotes ? (
            <pre className="whitespace-pre-wrap rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
              {job.internalNotes}
            </pre>
          ) : null}
          <Textarea
            rows={3}
            value={note}
            onChange={(e) => onNote(e.target.value)}
            placeholder="Add a field note…"
          />
          <button onClick={onSaveNote} disabled={busy || !note.trim()} className={buttonClass("secondary", "lg", "w-full")}>
            💾 Save note
          </button>
        </CardBody>
      </Card>

      <p className="text-center text-[11px] text-slate-400">
        Every action saves to this device first, then syncs automatically.
      </p>
    </div>
  );
}

const PHOTO_KINDS: QueuedPhoto["kind"][] = ["BEFORE", "DURING", "AFTER", "PROBLEM", "COVERUP"];

/**
 * Offline photo capture for a job. Photos are queued in IndexedDB (durable) and
 * upload automatically when back online. Queued blobs preview via object URLs.
 */
function JobPhotos({ jobId }: { jobId: string }) {
  const [queued, setQueued] = useState<QueuedPhoto[]>([]);
  const [kind, setKind] = useState<QueuedPhoto["kind"]>("AFTER");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const all = await idbGetAll<QueuedPhoto>("photoQueue");
      setQueued(all.filter((p) => p.jobId === jobId));
    } catch {
      /* IDB unavailable — no-op */
    }
  }, [jobId]);

  useEffect(() => {
    void refresh();
    const onSync = () => void refresh();
    window.addEventListener("tradeops-sync", onSync as EventListener);
    return () => window.removeEventListener("tradeops-sync", onSync as EventListener);
  }, [refresh]);

  const onPick = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setBusy(true);
      try {
        await enqueuePhoto({ jobId, kind, blob: file });
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [jobId, kind, refresh]
  );

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-700">Photos</div>
          {queued.length > 0 ? <Badge tone="amber">{queued.length} queued</Badge> : null}
        </div>

        <div className="flex flex-wrap gap-1.5">
          {PHOTO_KINDS.map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={
                "rounded-full px-3 py-1 text-xs font-medium " +
                (kind === k ? "bg-brand-blue text-white" : "bg-slate-100 text-slate-600")
              }
            >
              {statusLabel(k)}
            </button>
          ))}
        </div>

        {/* Native capture — opens the camera on phones. */}
        <label className={buttonClass("primary", "lg", "w-full cursor-pointer")}>
          {busy ? "Saving…" : `📷 Capture ${statusLabel(kind)} photo`}
          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            disabled={busy}
            onChange={(e) => onPick(e.target.files?.[0])}
          />
        </label>

        {queued.length > 0 ? (
          <>
            <div className="grid grid-cols-3 gap-2">
              {queued.map((p) => (
                <div key={p.id} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={URL.createObjectURL(p.blob)}
                    alt={p.kind}
                    className="h-24 w-full rounded-lg object-cover"
                  />
                  <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[9px] font-medium text-white">
                    {p.kind}
                  </span>
                </div>
              ))}
            </div>
            <p className="text-center text-[11px] text-amber-600">
              ⏳ Queued on this device — uploads when you&apos;re back online.
            </p>
          </>
        ) : (
          <p className="text-center text-[11px] text-slate-400">
            Captured photos attach to this job and upload automatically.
          </p>
        )}
      </CardBody>
    </Card>
  );
}
