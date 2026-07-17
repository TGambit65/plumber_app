import { NextResponse, type NextRequest } from "next/server";
import { t, withTenant, type TenantDb } from "@/db";
import { getSession, type Session } from "@/lib/auth";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * POST /api/sync/push
 *
 * Drains a batch of client changes. Every change is applied inside a single
 * `withTenant` transaction so RLS is the ownership/org backstop: a row the
 * caller's org can't see simply doesn't resolve on UPDATE/DELETE (reported as a
 * conflict), and CREATE auto-fills organization_id from the org GUC.
 *
 * Conflict rule (spec §7, server-wins default): on UPDATE/DELETE, if the stored
 * row's `updatedAt` is newer than the change's `clientTimestamp`, we SKIP and
 * report a conflict rather than clobber a newer server write.
 *
 * Local-ID remap (spec §4): CREATE trusts the client `local:` id only as a
 * correlation key. We mint a fresh server id (column default) and return
 * `{ localId, serverId }`. A batch-local map also rewrites `jobId` FKs of later
 * changes in the SAME batch that still reference a just-created local id.
 */

type SyncEntity = "job" | "timeEntry" | "jobForm";
type ChangeAction = "create" | "update" | "delete";

interface ChangeRecord {
  entityType: SyncEntity;
  entityId: string;
  action: ChangeAction;
  data: Record<string, unknown> | null;
  clientTimestamp: string;
  localId?: string;
}

interface PushResult {
  entityType: SyncEntity;
  entityId: string;
  action: ChangeAction;
  status: "created" | "updated" | "deleted" | "conflict" | "notfound" | "error";
  localId?: string;
  serverId?: string;
  /** Authoritative server row on a conflict so the client can reconcile. */
  serverRow?: unknown;
  error?: string;
}

const SYNCABLE: SyncEntity[] = ["job", "timeEntry", "jobForm"];

// Column whitelists — never mass-assign; organization_id / id / updatedAt are
// server-managed and intentionally excluded.
const JOB_CREATE = [
  "number", "jobType", "status", "priority", "description", "internalNotes",
  "customerId", "propertyId", "assignedToId", "projectId", "scheduledAt", "scheduledEnd",
] as const;
const JOB_UPDATE = [
  "status", "priority", "description", "internalNotes",
  "completedAt", "scheduledAt", "scheduledEnd", "assignedToId",
] as const;
const TE_CREATE = ["userId", "jobId", "kind", "startedAt", "endedAt"] as const;
const TE_UPDATE = ["kind", "startedAt", "endedAt"] as const;
const JF_CREATE = ["jobId", "name", "required", "completedAt", "data"] as const;
const JF_UPDATE = ["name", "required", "completedAt", "data"] as const;

const DATE_FIELDS = new Set(["scheduledAt", "scheduledEnd", "completedAt", "startedAt", "endedAt"]);

/** Pick whitelisted keys from `data`, coercing ISO strings on date columns to Date. */
function pick(data: Record<string, unknown> | null, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!data) return out;
  for (const k of keys) {
    if (!(k in data)) continue;
    const v = data[k];
    if (v == null) {
      out[k] = null;
    } else if (DATE_FIELDS.has(k)) {
      const d = new Date(v as string);
      out[k] = isNaN(d.getTime()) ? null : d;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Server-wins guard: true when the stored row is newer than the client change. */
function serverIsNewer(storedUpdatedAt: Date | null, clientTs: string): boolean {
  if (!storedUpdatedAt) return false;
  const c = new Date(clientTs).getTime();
  if (isNaN(c)) return false; // no usable client cursor → let the write proceed
  return storedUpdatedAt.getTime() > c;
}

async function processChange(
  tx: TenantDb,
  session: Session,
  change: ChangeRecord,
  batchMap: Map<string, string>
): Promise<PushResult> {
  const base: PushResult = {
    entityType: change.entityType,
    entityId: change.entityId,
    action: change.action,
    status: "error",
  };

  if (!SYNCABLE.includes(change.entityType)) {
    return { ...base, error: `non-syncable entityType: ${change.entityType}` };
  }

  // Rewrite a jobId FK that points at a local id created earlier in this batch.
  const data = { ...(change.data ?? {}) } as Record<string, unknown>;
  if (typeof data.jobId === "string" && batchMap.has(data.jobId)) {
    data.jobId = batchMap.get(data.jobId);
  }
  // A target row addressed by a just-created local id.
  const targetId = batchMap.get(change.entityId) ?? change.entityId;

  if (change.action === "create") {
    const localId = change.localId ?? change.entityId;
    if (change.entityType === "job") {
      const [row] = await tx.insert(t.jobs).values(pick(data, JOB_CREATE) as any).returning({ id: t.jobs.id });
      batchMap.set(localId, row.id);
      return { ...base, status: "created", localId, entityId: localId, serverId: row.id };
    }
    if (change.entityType === "timeEntry") {
      const vals = pick(data, TE_CREATE) as any;
      if (!vals.userId) vals.userId = session.userId;
      const [row] = await tx.insert(t.timeEntries).values(vals).returning({ id: t.timeEntries.id });
      batchMap.set(localId, row.id);
      return { ...base, status: "created", localId, entityId: localId, serverId: row.id };
    }
    // jobForm
    const [row] = await tx.insert(t.jobForms).values(pick(data, JF_CREATE) as any).returning({ id: t.jobForms.id });
    batchMap.set(localId, row.id);
    return { ...base, status: "created", localId, entityId: localId, serverId: row.id };
  }

  // UPDATE / DELETE — resolve the existing (RLS-scoped) row first.
  if (change.entityType === "job") {
    const existing = await tx.query.jobs.findFirst({ where: eq(t.jobs.id, targetId) });
    if (!existing) return { ...base, status: "notfound" };
    if (serverIsNewer(existing.updatedAt, change.clientTimestamp))
      return { ...base, status: "conflict", serverRow: existing };
    if (change.action === "delete") {
      await tx.update(t.jobs).set({ deletedAt: new Date(), deletedById: session.userId }).where(eq(t.jobs.id, targetId));
      return { ...base, status: "deleted", serverId: targetId };
    }
    await tx.update(t.jobs).set(pick(data, JOB_UPDATE) as any).where(eq(t.jobs.id, targetId));
    return { ...base, status: "updated", serverId: targetId };
  }

  if (change.entityType === "timeEntry") {
    const existing = await tx.query.timeEntries.findFirst({ where: eq(t.timeEntries.id, targetId) });
    if (!existing) return { ...base, status: "notfound" };
    if (serverIsNewer(existing.updatedAt, change.clientTimestamp))
      return { ...base, status: "conflict", serverRow: existing };
    if (change.action === "delete") {
      await tx.update(t.timeEntries).set({ deletedAt: new Date(), deletedById: session.userId }).where(eq(t.timeEntries.id, targetId));
      return { ...base, status: "deleted", serverId: targetId };
    }
    await tx.update(t.timeEntries).set(pick(data, TE_UPDATE) as any).where(eq(t.timeEntries.id, targetId));
    return { ...base, status: "updated", serverId: targetId };
  }

  // jobForm
  const existing = await tx.query.jobForms.findFirst({ where: eq(t.jobForms.id, targetId) });
  if (!existing) return { ...base, status: "notfound" };
  if (serverIsNewer(existing.updatedAt, change.clientTimestamp))
    return { ...base, status: "conflict", serverRow: existing };
  if (change.action === "delete") {
    await tx.update(t.jobForms).set({ deletedAt: new Date(), deletedById: session.userId }).where(eq(t.jobForms.id, targetId));
    return { ...base, status: "deleted", serverId: targetId };
  }
  await tx.update(t.jobForms).set(pick(data, JF_UPDATE) as any).where(eq(t.jobForms.id, targetId));
  return { ...base, status: "updated", serverId: targetId };
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { changes?: ChangeRecord[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const changes = Array.isArray(body.changes) ? body.changes : [];

  const serverTimestamp = new Date().toISOString();

  const results = await withTenant(session.organizationId, async (tx) => {
    const batchMap = new Map<string, string>();
    const out: PushResult[] = [];
    for (const change of changes) {
      try {
        // Per-change SAVEPOINT: a failing statement rolls back only its own
        // change (Postgres would otherwise abort the whole outer transaction),
        // so one bad row never poisons the rest of the batch.
        const r = await tx.transaction((tx2) =>
          processChange(tx2 as unknown as TenantDb, session, change, batchMap)
        );
        out.push(r);
      } catch (e) {
        out.push({
          entityType: change.entityType,
          entityId: change.entityId,
          action: change.action,
          status: "error",
          localId: change.localId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return out;
  });

  return NextResponse.json({ serverTimestamp, results });
}
