/**
 * Local-ID generation + remap (spec §4 — the highest-value offline pattern).
 *
 * Offline creates can't wait for a server id, so we mint a prefixed local id
 * (`local:<uuid>`) client-side and use it everywhere immediately — including as
 * a foreign key. On a successful push the server returns the canonical id and
 * we remap: in-memory `idMap`, persisted to IndexedDB, broadcast to other tabs.
 */

import { getMeta, setMeta } from "./idb";

const LOCAL_PREFIX = "local:";
const MAP_META_KEY = "idMap";
const CHANNEL_NAME = "syncqueue-remap";

/** In-memory localId → serverId map (hydrated from IDB via loadIdMap). */
const idMap = new Map<string, string>();

let channel: BroadcastChannel | null = null;
let channelWired = false;

function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for older/embedded webviews without crypto.randomUUID.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function getChannel(): BroadcastChannel | null {
  if (channel) return channel;
  if (typeof BroadcastChannel === "undefined") return null;
  channel = new BroadcastChannel(CHANNEL_NAME);
  return channel;
}

/** `local:<uuid>` — safe to use as a PK/FK immediately, everywhere. */
export function newLocalId(): string {
  return LOCAL_PREFIX + uuid();
}

export function isLocalId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(LOCAL_PREFIX);
}

/** Strip the `local:` prefix for display only (never for storage). */
export function stripLocalPrefix(id: string): string {
  return isLocalId(id) ? id.slice(LOCAL_PREFIX.length) : id;
}

/** Resolve a (possibly local) id to its server id, or return it unchanged. */
export function resolveId(id: string): string {
  return idMap.get(id) ?? id;
}

export function allMappings(): ReadonlyMap<string, string> {
  return idMap;
}

/** Hydrate the in-memory map from IDB and wire cross-tab remap coherence. */
export async function loadIdMap(): Promise<void> {
  const stored = await getMeta<[string, string][]>(MAP_META_KEY);
  if (stored) for (const [l, s] of stored) idMap.set(l, s);

  const ch = getChannel();
  if (ch && !channelWired) {
    channelWired = true;
    ch.onmessage = (ev: MessageEvent) => {
      const d = ev.data as { localId?: string; serverId?: string } | null;
      if (d && d.localId && d.serverId) idMap.set(d.localId, d.serverId);
    };
  }
}

async function persist(): Promise<void> {
  await setMeta<[string, string][]>(MAP_META_KEY, Array.from(idMap.entries()));
}

/**
 * Record a localId → serverId mapping: memory + IDB + cross-tab broadcast + a
 * `syncqueue:remap` DOM event so optimistic React state can swap the key.
 */
export async function setMapping(localId: string, serverId: string): Promise<void> {
  idMap.set(localId, serverId);
  await persist();
  getChannel()?.postMessage({ localId, serverId });
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("syncqueue:remap", { detail: { localId, serverId } }));
  }
}

/** Rewrite any string field on `obj` that currently holds a mapped local id. */
export function remapFields<T extends Record<string, unknown>>(obj: T, fields: (keyof T)[]): T {
  for (const f of fields) {
    const v = obj[f];
    if (typeof v === "string" && idMap.has(v)) {
      (obj as Record<string, unknown>)[f as string] = idMap.get(v);
    }
  }
  return obj;
}
