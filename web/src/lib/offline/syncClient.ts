/**
 * Offline sync client — the browser-side engine that keeps IndexedDB and the
 * server in step (spec §§5–7). Framework-agnostic; the Field workspace consumes
 * it and listens for the `tradeops-sync` DOM event to render its status chip.
 *
 * Guarantees:
 *  - Local writes are never lost: every mutation is appended to a durable
 *    `syncQueue` store BEFORE anything else, and only removed once the server
 *    acknowledges it.
 *  - Server-wins conflicts (default): a conflicted change is dropped locally and
 *    the authoritative row is pulled back via a delta sync.
 *  - Local ids remap on create, including FK rewrites on timeEntries.jobId and
 *    jobForms.jobId.
 */

import {
  idbBulkPut,
  idbClear,
  idbCount,
  idbDelete,
  idbGet,
  idbGetAll,
  idbPut,
  getMeta,
  setMeta,
  type StoreName,
} from "./idb";
import { allMappings, isLocalId, resolveId, setMapping } from "./localId";

export type SyncEntity = "job" | "timeEntry" | "jobForm";
export type ChangeAction = "create" | "update" | "delete";

export interface ChangeRecord {
  entityType: SyncEntity;
  entityId: string;
  action: ChangeAction;
  data: Record<string, unknown> | null;
  clientTimestamp: string;
  localId?: string;
}

export interface QueueItem extends ChangeRecord {
  id: string; // queue row id (distinct from entityId)
  attempts: number;
  lastError?: string;
}

export interface PushResultRow {
  entityType: SyncEntity;
  entityId: string;
  action: ChangeAction;
  status: "created" | "updated" | "deleted" | "conflict" | "notfound" | "error";
  localId?: string;
  serverId?: string;
  serverRow?: unknown;
  error?: string;
}

export interface SyncState {
  online: boolean;
  inFlight: boolean;
  pending: number; // queued data mutations
  pendingPhotos: number; // queued photo captures awaiting upload
  lastError: string | null;
  lastSync: string | null;
}

/** A photo captured in the field, queued in IDB until it can be uploaded. */
export interface QueuedPhoto {
  id: string;
  jobId: string;
  kind: "BEFORE" | "DURING" | "AFTER" | "PROBLEM" | "COVERUP";
  caption?: string;
  blob: Blob;
  capturedAt: string;
}

export interface FlushSummary {
  pushed: number;
  conflicts: number;
  errors: number;
  remaps: number;
}

const ENTITY_STORE: Record<SyncEntity, StoreName> = {
  job: "jobs",
  timeEntry: "timeEntries",
  jobForm: "jobForms",
};

const LAST_SYNC_KEY = "lastSync";
const SYNC_EVENT = "tradeops-sync";

let inFlight = false;
let lastError: string | null = null;
let listenersWired = false;

function isOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "q-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
}

/** Broadcast current sync state so UI chips can react. Safe on the server (no-op). */
export async function emitState(): Promise<SyncState> {
  const [pending, pendingPhotos, lastSync] = await Promise.all([
    idbCount("syncQueue").catch(() => 0),
    idbCount("photoQueue").catch(() => 0),
    getMeta<string>(LAST_SYNC_KEY).catch(() => undefined),
  ]);
  const state: SyncState = {
    online: isOnline(),
    inFlight,
    pending,
    pendingPhotos,
    lastError,
    lastSync: lastSync ?? null,
  };
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<SyncState>(SYNC_EVENT, { detail: state }));
  }
  return state;
}

// ── Photo capture queue (spec §5) ─────────────────────────────────────────────

/**
 * Queue a captured photo locally. It uploads immediately if online, otherwise
 * it waits in IndexedDB (durable) and drains on reconnect via flushPhotos().
 * Local-ID remap: if jobId is still a `local:` id, it's resolved at upload time.
 */
export async function enqueuePhoto(input: {
  jobId: string;
  kind: QueuedPhoto["kind"];
  caption?: string;
  blob: Blob;
}): Promise<QueuedPhoto> {
  const photo: QueuedPhoto = {
    id: uuid(),
    jobId: input.jobId,
    kind: input.kind,
    caption: input.caption,
    blob: input.blob,
    capturedAt: new Date().toISOString(),
  };
  await idbPut("photoQueue", photo);
  await emitState();
  if (isOnline()) void flushPhotos();
  return photo;
}

/** Upload every queued photo. Successful uploads are removed from the queue. */
export async function flushPhotos(): Promise<{ uploaded: number; errors: number }> {
  const result = { uploaded: 0, errors: 0 };
  if (!isOnline()) return result;
  const queued = await idbGetAll<QueuedPhoto>("photoQueue");
  for (const p of queued) {
    try {
      const jobId = resolveId(p.jobId); // handle local:→server FK remap
      if (isLocalId(jobId)) continue; // job not synced yet; try again next flush
      const fd = new FormData();
      fd.set("file", p.blob, `${p.id}.jpg`);
      fd.set("jobId", jobId);
      fd.set("kind", p.kind);
      if (p.caption) fd.set("caption", p.caption);
      fd.set("localId", p.id);
      const res = await fetch("/api/photos/upload", { method: "POST", body: fd });
      if (!res.ok) throw new Error(`upload ${res.status}`);
      await idbDelete("photoQueue", p.id);
      result.uploaded++;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      result.errors++;
    }
  }
  await emitState();
  return result;
}

export async function getSyncState(): Promise<SyncState> {
  return emitState();
}

// ── Snapshot / delta ─────────────────────────────────────────────────────────

interface SnapshotResponse {
  serverTimestamp: string;
  jobs: any[];
  jobForms: any[];
  timeEntries: any[];
}

/** Full snapshot: replace cached entity stores and set the sync cursor. */
export async function runInitialSync(): Promise<void> {
  const res = await fetch("/api/sync/initial", { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`initial sync failed: ${res.status}`);
  const data = (await res.json()) as SnapshotResponse;

  await Promise.all([idbClear("jobs"), idbClear("timeEntries"), idbClear("jobForms")]);
  await Promise.all([
    idbBulkPut("jobs", data.jobs ?? []),
    idbBulkPut("jobForms", data.jobForms ?? []),
    idbBulkPut("timeEntries", data.timeEntries ?? []),
  ]);
  await setMeta(LAST_SYNC_KEY, data.serverTimestamp);
  lastError = null;
  await emitState();
}

/** Merge only what changed since the cursor; evict tombstones. */
export async function runDeltaSync(): Promise<void> {
  const since = (await getMeta<string>(LAST_SYNC_KEY)) ?? new Date(0).toISOString();
  const res = await fetch(`/api/sync/delta?since=${encodeURIComponent(since)}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`delta sync failed: ${res.status}`);
  const data = (await res.json()) as SnapshotResponse;

  await mergeRows("jobs", data.jobs ?? []);
  await mergeRows("jobForms", data.jobForms ?? []);
  await mergeRows("timeEntries", data.timeEntries ?? []);

  await setMeta(LAST_SYNC_KEY, data.serverTimestamp);
  await emitState();
}

/** Apply server rows over local cache; a non-null deletedAt evicts the row. */
async function mergeRows(store: StoreName, rows: any[]): Promise<void> {
  for (const row of rows) {
    if (row?.deletedAt) {
      await idbDelete(store, row.id);
    } else {
      await idbPut(store, row);
    }
  }
}

// ── Enqueue (durable outbox + optimistic mirror) ──────────────────────────────

/**
 * Append a change to the durable queue AND apply it to the local read model
 * immediately (optimistic mirror) so the UI is instant. If online, kick a flush.
 */
export async function enqueue(change: ChangeRecord): Promise<QueueItem> {
  const item: QueueItem = { ...change, id: uuid(), attempts: 0 };
  await idbPut("syncQueue", item);
  await mirrorLocally(change);
  await emitState();
  if (isOnline()) void flushQueue();
  return item;
}

async function mirrorLocally(change: ChangeRecord): Promise<void> {
  const store = ENTITY_STORE[change.entityType];
  const now = new Date().toISOString();
  if (change.action === "create") {
    await idbPut(store, { ...(change.data ?? {}), id: change.entityId, updatedAt: now, _pending: true });
  } else if (change.action === "update") {
    const existing = (await idbGet<any>(store, change.entityId)) ?? { id: change.entityId };
    await idbPut(store, { ...existing, ...(change.data ?? {}), updatedAt: now, _pending: true });
  } else {
    const existing = await idbGet<any>(store, change.entityId);
    if (existing) await idbPut(store, { ...existing, deletedAt: now, _pending: true });
  }
}

// ── Flush (batched push + remap + conflict reconcile) ─────────────────────────

/**
 * Push the queue to the server in one batch, then reconcile: remap created ids
 * (incl. FK rewrites), drop acknowledged items, keep failures for retry, and
 * pull server truth for any conflict (server-wins).
 */
export async function flushQueue(): Promise<FlushSummary> {
  const summary: FlushSummary = { pushed: 0, conflicts: 0, errors: 0, remaps: 0 };
  if (inFlight) return summary;
  if (!isOnline()) {
    await emitState();
    return summary;
  }

  const queue = await idbGetAll<QueueItem>("syncQueue");
  if (queue.length === 0) {
    await emitState();
    return summary;
  }

  inFlight = true;
  await emitState();

  // Resolve known FKs to server ids before sending (handles cross-flush maps).
  const changes: ChangeRecord[] = queue.map((it) => {
    const data = { ...(it.data ?? {}) } as Record<string, unknown>;
    if (typeof data.jobId === "string") data.jobId = resolveId(data.jobId);
    return {
      entityType: it.entityType,
      entityId: it.action === "create" ? it.entityId : resolveId(it.entityId),
      action: it.action,
      data,
      clientTimestamp: it.clientTimestamp,
      localId: it.action === "create" ? it.localId ?? it.entityId : undefined,
    };
  });

  let results: PushResultRow[];
  try {
    const res = await fetch("/api/sync/push", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ changes }),
    });
    if (!res.ok) throw new Error(`push failed: ${res.status}`);
    const payload = (await res.json()) as { results: PushResultRow[] };
    results = payload.results ?? [];
  } catch (e) {
    // Network/transport failure: nothing is lost — the queue is untouched.
    lastError = e instanceof Error ? e.message : String(e);
    inFlight = false;
    await emitState();
    return summary;
  }

  let hadConflict = false;

  // Results are returned in request order; zip back onto queue items.
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    const r = results[i];
    if (!r) {
      await bumpAttempt(item, "no result returned");
      summary.errors++;
      continue;
    }

    if (r.status === "created" && r.serverId) {
      const localId = r.localId ?? item.entityId;
      await setMapping(localId, r.serverId);
      await remapEntity(item.entityType, localId, r.serverId);
      await idbDelete("syncQueue", item.id);
      summary.pushed++;
      summary.remaps++;
    } else if (r.status === "updated" || r.status === "deleted") {
      await clearPending(item.entityType, r.serverId ?? resolveId(item.entityId));
      await idbDelete("syncQueue", item.id);
      summary.pushed++;
    } else if (r.status === "conflict") {
      // Server-wins: drop the local change, reconcile from server below.
      await idbDelete("syncQueue", item.id);
      hadConflict = true;
      summary.conflicts++;
    } else if (r.status === "notfound") {
      // Target vanished server-side (e.g. deleted) — nothing to retry.
      await idbDelete("syncQueue", item.id);
      summary.errors++;
    } else {
      await bumpAttempt(item, r.error ?? "push error");
      summary.errors++;
    }
  }

  lastError = summary.errors > 0 ? lastError ?? "some changes failed" : null;
  inFlight = false;
  await emitState();

  // Reconcile server-wins conflicts by pulling authoritative rows.
  if (hadConflict) {
    try {
      await runDeltaSync();
    } catch {
      /* delta will retry on next sync */
    }
  }

  return summary;
}

async function bumpAttempt(item: QueueItem, err: string): Promise<void> {
  lastError = err;
  await idbPut("syncQueue", { ...item, attempts: item.attempts + 1, lastError: err });
}

async function clearPending(entity: SyncEntity, id: string): Promise<void> {
  const store = ENTITY_STORE[entity];
  const row = await idbGet<any>(store, id);
  if (row && row._pending) {
    const { _pending: _p, ...rest } = row; void _p;
    await idbPut(store, rest);
  }
}

/** Remap a created row local→server id and rewrite dependent FKs across stores. */
async function remapEntity(entity: SyncEntity, localId: string, serverId: string): Promise<void> {
  const store = ENTITY_STORE[entity];
  const row = await idbGet<any>(store, localId);
  if (row) {
    const { _pending: _p, ...rest } = row; void _p;
    await idbDelete(store, localId);
    await idbPut(store, { ...rest, id: serverId });
  }

  // FK rewrites: children that referenced the local job id.
  if (entity === "job") {
    for (const child of ["timeEntries", "jobForms"] as StoreName[]) {
      const rows = await idbGetAll<any>(child);
      for (const c of rows) {
        if (c.jobId === localId) await idbPut(child, { ...c, jobId: serverId });
      }
    }
  }

  // Rewrite still-queued items that reference the local id.
  const queued = await idbGetAll<QueueItem>("syncQueue");
  for (const q of queued) {
    let changed = false;
    const data = { ...(q.data ?? {}) } as Record<string, unknown>;
    if (data.jobId === localId) {
      data.jobId = serverId;
      changed = true;
    }
    const entityId = q.entityId === localId ? serverId : q.entityId;
    if (entityId !== q.entityId) changed = true;
    if (changed) await idbPut("syncQueue", { ...q, entityId, data });
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/** Wire online/offline listeners once; flush opportunistically when back online. */
export function startSyncListeners(): void {
  if (listenersWired || typeof window === "undefined") return;
  listenersWired = true;
  window.addEventListener("online", () => {
    // Data mutations first (so photos can remap local job ids to server ids),
    // then queued photos.
    void emitState()
      .then(() => flushQueue())
      .then(() => flushPhotos());
  });
  window.addEventListener("offline", () => {
    void emitState();
  });
}

/** Convenience for the "Sync now" button: drain queues, then pull deltas. */
export async function syncNow(): Promise<void> {
  await flushQueue();
  await flushPhotos();
  if (isOnline()) await runDeltaSync();
}

// Re-export id helpers so the workspace has a single import surface.
export { isLocalId, resolveId, allMappings };
