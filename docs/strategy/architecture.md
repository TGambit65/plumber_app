# Trade-Ops — Architecture Direction

Ratified 2026-07-16 (Kelly). This is the current architectural north star for
the app in this repo. `plumber_app` is the **Trade-Ops APPLICATION core**: one
multi-tenant field-service platform that any of ~21 trades runs, specialized by
composable per-tenant **trade packs**. Plumbing is the reference pack.

Stack: Next.js 14 (App Router) · Drizzle · PostgreSQL · Tailwind (automators-brand v2).

## The five load-bearing principles (priority order)

When principles conflict, prefer higher on this list (the "if in doubt" order):

1. **Standalone works alone.** Every trade app deployment is fully functional on
   its own, wired into the *client's* existing stack, with zero hard dependency
   on the rest of our platform. Local auth, local knowledge search, the app's own
   connectors/notifications are the defaults.
2. **Composes upward when connected.** OrgMemory (governed memory), Ember (front
   office), our SSO, the agency platform are **optional additive upgrades** that
   light up via `integrationConnections` and **degrade gracefully** (loudly) when
   absent.
3. **Multi-tenant and org-scoped.** Every tenant-owned row carries
   `organization_id`; isolation is enforced by Postgres RLS.
4. **One core, many packs.** No per-trade forks. Trade-specific content is
   data/config-driven packs on the tenant; a tenant may enable **many** at once.
5. **Human-gated memory.** Anything submitted to OrgMemory is a **staged
   candidate**; canon is written only by a human governance reviewer. No reliance
   on STM→LTM auto-promotion.

## Multi-tenancy model (implemented foundation)

- `organizations` — the tenant root (name, slug, brand, optional SSO provider).
- `trade_packs` — global catalog of composable capability bundles
  (`plumbing`, `hvac`, `sewer`, `electrical`, `restoration`, `roofing`,
  `fuel_equipment`, `aa_field_ops`, …); each carries a `config` JSON for its
  templates / line-item catalog / compliance rules / equipment models.
- `organization_trade_packs` — which packs a tenant has enabled (many per org).
- **`organization_id` on every tenant-owned table**, with a column default of
  `current_setting('app.current_org')` so inserts auto-fill the tenant.

### Enforcement: Postgres RLS + `withTenant`

- `withTenant(orgId, tx => …)` (`src/db/index.ts`) runs a unit of work in a
  transaction with `SET LOCAL app.current_org`, so RLS filters reads and the
  column default fills inserts — on one connection, GUC auto-reset at commit,
  pool-safe.
- RLS policies (`src/db/rls.sql`) are `FORCE`d (the app's DB role owns the tables
  and would otherwise bypass them). Policy: `organization_id =
  current_setting('app.current_org', true)` for USING and WITH CHECK.
- **Fail-safe:** with no tenant context set, RLS returns **zero rows** (never a
  cross-tenant leak). Verified: Summit HVAC cannot read Apex's SOPs even by exact
  slug; no-context reads return 0.

### Incremental conversion status (IMPORTANT)

RLS is enabled **table-by-table**, only after every code path touching a table
runs through `withTenant`. This keeps the app working during conversion.

- ✅ **Converted + RLS ON:** `kb_articles` (Knowledge Base module) — the proven,
  isolation-tested vertical slice (KB pages, KB actions, global-search KB facet,
  OrgMemory store all org-scoped).
- ⏳ **Pending (RLS OFF, still functional):** jobs, customers, properties,
  equipment, leads, estimates, invoices, projects, price_book_items, inventory,
  commissions, activities, notifications, messaging, integration_connections,
  users. These have `organization_id` columns and are seeded per-org, but their
  read/write paths (~35 files, ~220 query sites) still use the base `db` client.
  Each module is converted the same way KB was, then its table is added to the
  `rls_tables` array in `rls.sql`.

**Conversion recipe per module** (repeatable, low-risk):
1. Wrap the module's reads/writes in `withTenant(session.organizationId, …)`.
2. Add the table(s) to `rls_tables` in `src/db/rls.sql`; run `npm run db:rls`.
3. Verify isolation (org A cannot see org B) via a Playwright + SQL check.

## Core capabilities beyond the trade packs (constraints 3–12)

These live in the **core**, not in packs, and are on the roadmap after tenancy
conversion completes:

- **Insurance / Claims (core).** Carriers/adjusters, claim numbers on
  jobs/estimates, claim-linked photo documentation, supplement docs,
  carrier-format estimate export. PII-sensitive. Roofing & restoration depend on
  it; all trades may use it.
- **Compliance / Inspection engine (core).** Generic inspection templates +
  results, certification records with issue/expiry dates, renewal
  scheduling/alerts. Packs specialize (fuel: UST testing, weights-&-measures;
  electrical: permits). Greenfield differentiator.
- **Typed connector interface.** Generalize `integrationConnections`/`provider`
  into a typed connector interface with provider impls: CRM (**Odoo CRM
  required**, HubSpot, Salesforce, GoHighLevel), Accounting (QuickBooks, Xero),
  Job apps (Jobber, ServiceTitan, Housecall Pro), Messaging (Twilio, email,
  Slack/Teams), PM (Procore, Asana/Monday). Assume clients KEEP their stack — the
  app layers on top (read/write), not only system-of-record. Synced records flow
  into OrgMemory (when connected) as provenance-tagged **staged** candidates.
- **Offline-first field capture (core).** See
  [`specs/offline-sync-spec.md`](specs/offline-sync-spec.md) — harvested from the
  live Kevin's-App stack, re-targeted to multi-tenant Drizzle. Local-ID remap,
  durable queue, delta sync, per-field conflict resolution, encrypted local
  store, all org-scoped.
- **Approval-gated egress.** Nothing customer-facing (messages/quotes) leaves
  without owner/office approval (approval-card pattern). Licensed work (permits,
  sign-offs) routes to the licensed human.
- **Identity federation.** Local auth is the standalone default; map users/orgs
  to our `organization_id` model so external SSO can be configured per tenant.
- **AA field-ops profile (dogfood).** The core must serve American Automators'
  own field ops (selling Acorn tiers, installing on-prem hardware: site surveys,
  install checklists, serial/warranty inventory, dispatch) with no
  plumbing/insurance assumptions leaking in — an `aa_field_ops` trade pack.

## Boundary & licensing

- Proprietary [`LICENSE`](../../LICENSE) (American Automators).
- **Do not** copy private/AA business logic into the Apache-2.0 public
  `orgmemory` repo; OrgMemory is integrated only via its published contracts
  (`search_memories`, `store_document`, `recall_memories`, `store_memory`).

## Phased roadmap

- **Phase 0 (done):** LICENSE, brand v2, OrgMemory contract fix (real tools,
  loud degraded status, staged/human-gated), offline-sync spec.
- **Phase 1 (this pass):** multi-tenant schema + trade packs + RLS spine +
  `withTenant` + 2-org seed + KB module converted & isolation-verified + session
  org + org-aware shell.
- **Phase 2:** finish the tenancy conversion module-by-module (recipe above);
  flip RLS on for every core table.
- **Phase 3:** typed connector interface (Odoo CRM first) + claims core +
  compliance/inspection engine.
- **Phase 4:** offline-first implementation + approval-gated egress + AA
  field-ops pack + SSO federation.
