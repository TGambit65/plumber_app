# Tenancy conversion contract (read fully before editing)

Goal: convert your assigned module's database access from the base `db` client
to the tenant-scoped `withTenant` primitive so Postgres RLS can be enabled on
every core table. The app is multi-tenant now: two seeded orgs (Apex Plumbing,
Summit HVAC) must never see each other's rows.

## The primitive

```ts
import { t, withTenant } from "@/db"; // drop `db` from the import if unused

const rows = await withTenant(session.organizationId, (tx) =>
  tx.query.jobs.findMany({ ... })
);

// Multiple statements: one wrapper, tx everywhere
const result = await withTenant(session.organizationId, async (tx) => {
  const a = await tx.select().from(t.jobs)...;
  await tx.insert(t.activities).values(...);
  return a;
});
```

- `withTenant` opens a transaction and runs `SET LOCAL app.current_org`, so
  reads are RLS-filtered to the org AND inserts auto-fill `organization_id`
  from the column default. **Never set organizationId manually in values().**
- `session` comes from `await requireSession()` — it now has `organizationId`.
- In **pages**: wrap all queries of the page in ONE `withTenant` call where
  practical (fewer transactions), returning what the JSX needs.
- In **server actions**: wrap the db work in `withTenant`. Calls to `audit()`,
  `logActivity()`, `notify()` from `@/lib/actions/helpers` are ALREADY
  converted (they scope themselves) — leave those calls outside or inside your
  wrapper as-is, they are safe either way.
- Existing `revalidatePath`, `redirect`, permission checks: unchanged.
- Do NOT touch: `src/db/*`, `src/lib/auth.ts`, `src/lib/actions/helpers.ts`,
  `src/lib/actions/notifications.ts`, `src/lib/effective-permissions.ts`,
  `src/lib/knowledge/*`, `src/app/(app)/layout.tsx`, kb pages, search page,
  config files, or any file not in YOUR list. Other agents work concurrently.

## Correctness notes

- Number-sequence helpers (nextJobNumber etc.) that scan existing numbers must
  run inside withTenant too (per-org sequences are correct behavior).
- Queries filtered by userId (e.g. "my jobs") still need withTenant — RLS is
  the org boundary, userId is the ownership filter within it.
- `db.query.X.findMany({ with: ... })` works identically on `tx`.
- If a function is called from BOTH inside and outside a withTenant block,
  prefer giving it its own withTenant (nested separate transactions are fine).
- TypeScript: `tx` is typed as TenantDb — same API surface as `db`.

## Definition of done for your module

1. Zero remaining `db.` usages in your files (import `t, withTenant` only),
   except where a file legitimately reads global tables (organizations,
   trade_packs) — those stay on `db`.
2. `npx tsc --noEmit` clean for your files.
3. Report: files changed + any call sites you were unsure about.
