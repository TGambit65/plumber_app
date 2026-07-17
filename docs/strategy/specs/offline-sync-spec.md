# Offline-First Field Sync — Specification

Status: ratified pattern · Harvested from the live `TGambit65/Kevins-App`
(`feat/hermes-assistant-dashboard`) offline stack and **re-targeted to the
multi-tenant Trade-Ops core (Next.js + Drizzle + Postgres)**. Do **not** copy
Kevin's single-tenant schema shape; lift the *mechanics* only.

Constraint 7: offline read + write with a durable local queue and conflict-safe
sync is a **CORE** requirement. **The entire sync path is org/tenant-scoped** —
every payload, queue item, and server query is filtered by `organizationId`.

## 1. Why

Field techs work in basements, crawlspaces, mechanical rooms, rural routes —
no signal at the exact moment work is documented. The app must let them read
today's route + history and *write* (status, notes, photos, forms, signatures,
time, estimates, invoices) fully offline, then sync opportunistically when
connectivity returns, without losing or corrupting data and without leaking
across tenants.

## 2. Architecture overview

```
┌─ Device (PWA) ─────────────────────────────┐        ┌─ Server (Next.js) ─────────┐
│ IndexedDB (encrypted)                       │        │ /api/sync/initial          │
│  ├─ entity stores (jobs, photos, forms…)    │  HTTPS │ /api/sync/delta?since=…     │
│  ├─ syncQueue (durable outbox)              │ ─────▶ │ /api/sync/push             │
│  ├─ conflicts (parked)                      │        │  → syncService (org-scoped)│
│  └─ idMap (localId → serverId)              │        │  → Drizzle + Postgres      │
│ Service worker: cache shell + read models   │        │  RLS enforces tenant scope │
└─────────────────────────────────────────────┘        └────────────────────────────┘
```

Three endpoints (all `requireSession`, all org-scoped):

- **`GET /api/sync/initial`** — full snapshot of the tenant's data the tech is
  authorized to see (their route + trailing history window), plus a
  `serverTimestamp` cursor. Used on first install, cache clear, or forced refresh.
- **`GET /api/sync/delta?since=<ISO>`** — only rows with `updatedAt > since`
  (and tombstones: `deletedAt > since`), plus a new `serverTimestamp`.
- **`POST /api/sync/push`** — batched client changes (create/update/delete),
  returns per-change results including server-assigned IDs and conflicts.

## 3. Local store (IndexedDB)

- One object store per syncable entity + `syncQueue`, `conflicts`, `idMap`,
  `formDrafts`.
- **Encryption at rest** (constraint: encrypted local store). Derive a key via
  WebCrypto (AES-GCM) from a device secret unlocked at login/biometric; encrypt
  PII-bearing fields (customer contact, claim data) before `put`. Mirror the
  `isEncryptionReady()` gate from the reference app — never write plaintext PII.
- Stamp every locally-cached row with its `organizationId`; the read models the
  UI binds to are filtered by the active org so a device that has logged into
  two orgs never blends them.

## 4. Local-ID generation + remap (the highest-value pattern)

Offline creates can't wait for a server ID. Generate a **prefixed local ID**
(`local:<uuid>`) client-side and use it everywhere immediately (foreign keys
included). On push, the server assigns the canonical ID and returns the mapping.

- `idMap: Map<localId, serverId>` in memory + persisted in IndexedDB.
- `isLocalId(id)` = `id.startsWith("local:")`; `stripLocalPrefix` for display.
- On a successful push create, rewrite the local caches: the created row and
  **every row referencing the local FK** get remapped to the server ID.
- **Cross-tab coherence**: broadcast remaps over a `BroadcastChannel`
  (`syncqueue-remap`) so other open tabs update their in-memory `idMap`
  (IndexedDB is shared across tabs of the origin, so only memory needs the nudge).
- Emit `syncqueue:remap` DOM events so React state (optimistic lists) can swap
  the key without a full reload.

Server side: accept the client-provided `local:` id on create, insert with a
freshly generated server id, and return `{ localId, serverId }`. Never trust the
client id as the stored PK — always mint server-side and map.

## 5. Sync queue (durable outbox)

- Every offline mutation appends a `SyncQueueItem { id, entityType, entityId,
  action, payload, clientTimestamp, orgId, attempts, lastError }`.
- **Optimistic local mirror**: `mirrorQueuedMutationLocally` applies the change
  to the local read model immediately so the UI is instant; `reconcileServerResponseLocally`
  replaces it with the authoritative server row after push.
- **Batched push** with retry/backoff; a single failed item parks or retries
  without blocking the batch. Surface queue depth + in-flight + last error via a
  `syncqueue:change` event so the UI can show a sync-state chip (never silently
  lose writes).
- Photos push via **resumable multipart upload** with progress, decoupled from
  the JSON mutation queue; completion updates the photo row's URL/thumb.

## 6. Delta sync

- Server: `where(and(eq(org), gt(updatedAt, since)))` per entity + tombstones
  where `deletedAt > since`. Order by `updatedAt desc`. Return `serverTimestamp`
  = now.
- Client: apply server rows over local (server is source of truth for confirmed
  state), then advance the stored `since` cursor. A nightly/opportunistic **full
  reconciliation** (initial sync) catches missed tombstones.

## 7. Conflict resolution

Two layers, matching the reference app:

1. **Server-wins guard (default, automatic).** On push update/delete, compare
   the row's `updatedAt` to the change's `clientTimestamp`. If the server row is
   newer, **skip and report a conflict** rather than clobbering — the client
   parks it. This is the safe default (no lost server writes).
2. **Per-field merge (user-resolved).** A parked `ConflictRecord { mine, server,
   base }` drives a field-level merge UI. Resolutions:
   - `resolveConflictKeepMine` — re-queue the client version.
   - `resolveConflictKeepServer` — drop the local change, accept server.
   - `resolveConflictMerge(partial)` — re-queue a **partial** update built from
     the per-field picker (only the fields the user chose), plus
     `restoreResolvedConflict` to roll back the last resolution.

For the field app's UX target, most conflicts auto-resolve last-write-wins with
a notification; only genuine field-vs-field edits surface the merge UI.

## 8. Security & audit (harvest these too)

- **Hash-chained audit log** — each audit row stores a hash of `(prevHash +
  payload)`; tampering breaks the chain. Add to the core `audit_logs` table.
- **Soft-delete convention** — `deletedAt` + `deletedById`, restrict-on-delete
  FKs; tombstones flow through delta sync. Adopt across core entities.
- **Per-record ownership + org checks** on every push change (verify the row
  belongs to the caller's org **and** they may edit it) — RLS is the backstop,
  the service check is the explicit gate.
- **PII field encryption + HMAC lookup** — encrypt PII at rest; keep a keyed
  HMAC column for equality lookups (e.g. dedupe by phone) without decrypting.
- **Optional WebAuthn MFA** for privileged roles.

## 9. Mapping to our Drizzle stack (implementation notes)

- Add `updatedAt` (auto-touch), `deletedAt`, `deletedById`, and `organizationId`
  to every syncable core table (jobs, activities, job_photos, job_forms,
  time_entries, estimates, invoices, customers, properties, equipment).
- Build the three sync routes as Next.js Route Handlers under
  `src/app/api/sync/*`, each resolving the session → org and running through the
  tenant-scoped db (RLS-enforced).
- Re-implement the client stack (`indexedDB`, `localDatabase`, `syncQueue`,
  `sync`, `syncMirror`, `conflictResolution`, `encryption`, `formDrafts`) as a
  framework-agnostic `src/lib/offline/*` module the PWA shell consumes. Port the
  reference tests (`sync.test.ts`, `conflictResolution.test.ts`) — **they encode
  the contract** — adapting entity names to the core schema.
- Register a service worker for the app shell + cached read models. Benchmarks
  to beat: Housecall Pro ~30d cache, ServiceTitan ~14d, Jobber ~7d.

## 10. Do-not-copy list (single-tenant / fuel landmines)

- Kevin's "creator owns the record" access model → replace with org/tenant
  isolation + role scoping.
- Its 3-role RBAC (ADMIN/USER/VIEWER) → we use TECH/SALES_PM/OFFICE/ADMIN.
- Fuel enums (dispenser/tank/cardlock/lube) and denormalized site-contacts stay
  in the **Fuel Equipment trade pack**, never in core.

## 11. Acceptance (definition of done)

- Create/edit/complete a job, capture photos + a signed form, and take a payment
  fully offline; all persist locally and appear in a visible sync-pending state.
- On reconnect: queue drains, local IDs remap (including FKs), server rows
  reconcile, photos finish uploading — with zero data loss and a visible
  success state.
- Two devices editing the same job produce a server-wins auto-resolution (with
  notice) or a per-field merge; no silent clobber.
- A device logged into two orgs never blends their data; every sync call is
  org-scoped and RLS-guarded.
- Ported `sync` + `conflictResolution` tests pass against the Drizzle backend.
