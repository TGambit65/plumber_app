/**
 * Minimal, dependency-free typed IndexedDB wrapper for the offline field store.
 *
 * Hand-rolled on purpose (no idb / dexie) — we only need a handful of key/value
 * object stores. Everything here is browser-only; callers live in "use client"
 * code. On a non-browser/no-IDB environment `openDb()` rejects so callers can
 * degrade gracefully.
 *
 * Stores (all keyPath "id", except `meta` keyed by "key"):
 *   jobs · timeEntries · jobForms · syncQueue · meta
 */

export const DB_NAME = "tradeops-offline";
export const DB_VERSION = 1;

export type StoreName = "jobs" | "timeEntries" | "jobForms" | "syncQueue" | "meta";

const ENTITY_STORES: StoreName[] = ["jobs", "timeEntries", "jobForms", "syncQueue"];

let dbPromise: Promise<IDBDatabase> | null = null;

export function idbAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

export function openDb(): Promise<IDBDatabase> {
  if (!idbAvailable()) return Promise.reject(new Error("IndexedDB unavailable"));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of ENTITY_STORES) {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
  return dbPromise;
}

function tx(db: IDBDatabase, store: StoreName, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(store, mode).objectStore(store);
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

export async function idbGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  const db = await openDb();
  return (await wrap(tx(db, store, "readonly").get(key))) as T | undefined;
}

export async function idbGetAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDb();
  return (await wrap(tx(db, store, "readonly").getAll())) as T[];
}

export async function idbPut<T>(store: StoreName, value: T): Promise<void> {
  const db = await openDb();
  await wrap(tx(db, store, "readwrite").put(value as any));
}

export async function idbDelete(store: StoreName, key: string): Promise<void> {
  const db = await openDb();
  await wrap(tx(db, store, "readwrite").delete(key));
}

export async function idbClear(store: StoreName): Promise<void> {
  const db = await openDb();
  await wrap(tx(db, store, "readwrite").clear());
}

/** Bulk put in a single transaction — used to hydrate a store from a snapshot. */
export async function idbBulkPut<T>(store: StoreName, values: T[]): Promise<void> {
  if (values.length === 0) return;
  const db = await openDb();
  const t = db.transaction(store, "readwrite");
  const os = t.objectStore(store);
  for (const v of values) os.put(v as any);
  await new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error ?? new Error("IndexedDB bulk put failed"));
    t.onabort = () => reject(t.error ?? new Error("IndexedDB bulk put aborted"));
  });
}

export async function idbCount(store: StoreName): Promise<number> {
  const db = await openDb();
  return wrap(tx(db, store, "readonly").count());
}

// ── meta helpers (small key/value scratch space: cursors, idMap, etc.) ────────
interface MetaRow<V> {
  key: string;
  value: V;
}

export async function getMeta<V>(key: string): Promise<V | undefined> {
  const row = await idbGet<MetaRow<V>>("meta", key);
  return row?.value;
}

export async function setMeta<V>(key: string, value: V): Promise<void> {
  await idbPut<MetaRow<V>>("meta", { key, value });
}
