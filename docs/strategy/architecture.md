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

### Conversion status: ✅ COMPLETE — RLS ON everywhere

All modules (~35 files, ~220 query sites) run through `withTenant`; **FORCE RLS
is enabled on all 41 tenant-owned tables**, including `users`. The only tables
without RLS are the globals: `organizations` (the tenant roots) and
`trade_packs` (shared catalog).

- **Login bootstrap** — the one legitimate cross-tenant read — goes through
  `auth_user_by_email()`, a `SECURITY DEFINER` function (bottom of
  `src/db/rls.sql`) owned by a BYPASSRLS-capable role. Everything else reads
  users inside `withTenant`. Run `rls.sql` as a superuser (`npm run db:rls`).
- **Verified end-to-end** (Playwright + SQL, both orgs): 31-page read tour
  clean; mutations write with the correct `organization_id` (job status
  advance + time entries, follow-up sends, message sends); Summit cannot see
  Apex's customers, jobs, invoices, price book, messages, team roster, or
  search results — and vice versa; unscoped connections read **zero rows**
  (fail-safe).
- Helpers (`audit`, `logActivity`, `notify`) self-scope from the session, so
  every code path — including notification fan-outs — lands in the right
  tenant.

**Recipe for future tables** (new features must follow it):
1. Give the table an `organization_id` column with the
   `current_setting('app.current_org')` default; do reads/writes in `withTenant`.
2. Add it to `rls_tables` in `src/db/rls.sql`; run `npm run db:rls`.
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
- **Phase 2 (done):** full tenancy conversion — every module on `withTenant`,
  FORCE RLS on all 41 tenant tables (incl. users via the auth-function
  bootstrap), mutation + isolation verification for both seeded orgs.
- **Phase 3 (done):** typed connector interface + claims core +
  compliance/inspection engine:
  - `src/lib/connectors/` — capability-typed Connector interface (crm /
    accounting / jobs / messaging / pm), **Odoo CRM live JSON-RPC impl**
    (authenticate + crm.lead search_read + res.partner upsert + message_post),
    registry of 13 further providers as descriptor-complete stubs, config-driven
    settings hub grouped by capability, loud ERROR + lastError on failure,
    CRM sync-in inserts new leads and stages each into OrgMemory as
    provenance-tagged candidates.
  - Claims core: carriers/adjusters/claims/supplements (+ claimId on
    jobs/estimates), claim command center with claim-linked photo documentation,
    status workflow, supplements, and an audited carrier-format export package;
    policy numbers masked in audit detail (PII).
  - Compliance engine: inspection templates (steps jsonb, pack-specialized via
    the org's ENABLED packs only), mobile-first run-inspection flow with
    required-step gating, auto certification issuance on PASS
    (certValidityDays), certification registry (user/equipment/org holders),
    expiring-soon panel + renewal sweep notifications. All seven new tables
    under FORCE RLS; isolation verified across both seeded orgs.
- **Phase 4 (done):** offline-first field capture + approval-gated egress +
  AA field-ops pack + SSO federation:
  - **Offline sync**: `/api/sync/{initial,delta,push}` org-scoped route handlers
    (server-wins conflicts, soft-delete tombstones, role-scoped snapshots) +
    `src/lib/offline/*` (dependency-free IndexedDB store, durable outbox queue,
    local-ID generation + remap incl. FK rewrites, delta merge) + `/field`
    offline workspace with a live sync-state chip. `updated_at` touch triggers
    (`db/sync.sql`) drive delta. Verified: local-ID create round-trips to a
    server ID with FK + org preserved, zero `local:` leakage, stale updates
    rejected as conflicts (no clobber).
  - **Offline photo pipeline (done)**: field photo capture works fully offline.
    `<input capture="environment">` grabs the shot, it lands in a `photoQueue`
    IndexedDB store (`idb.ts` DB v2) as a durable `Blob`, and the sync client
    (`syncClient.ts` `enqueuePhoto`/`flushPhotos`) uploads it on reconnect —
    resolving any `local:` job ID to its server ID first. `/api/photos/upload`
    verifies the job belongs to the caller's org **before** writing anything,
    re-encodes to JPEG + thumbnail via `sharp`, stores under
    `public/uploads/<orgId>/`, inserts an org-scoped `jobPhotos` row, and audits
    `UPLOAD_PHOTO`. The sync chip counts queued photos as pending. Verified:
    captured offline → queued → survived reload → auto-uploaded on reconnect
    (server 1→2, file on disk); cross-tenant upload attempt correctly 404'd.
  - **PWA app shell (done)**: `public/manifest.json` (installable, standalone,
    `/field` start URL, brand icons) + `public/sw.js` (network-first navigation
    with `/offline` fallback, cache-first static, network-only for
    `/api`·`/auth`·`/uploads`·`/login`) registered via `PwaRegister`; `/offline`
    fallback page. Verified: SW registers on the client after load.
  - TODOs remaining: at-rest queue encryption, per-field merge UI (spec §§ noted).
  - **Approval-gated egress**: `outbound_messages` queue; estimate sends and
    follow-up touches now create PENDING_APPROVAL rows instead of firing;
    `/approvals` card UI (office/admin) approves (executes the real send +
    starts the follow-up cadence) or rejects (notifies requester); licensed
    sign-offs approvable only by ADMIN or a holder of a valid matching
    certification (server-enforced). All audited.
  - **AA field-ops pack**: trade-pack `config.jobTypes` compose the booking
    job-type picker from the org's ENABLED packs only (`src/lib/trade-packs.ts`);
    seeded `American Automators` org (Acorn install line, Mascott customer,
    on-prem-server equipment, install checklist) sees ONLY field-ops job types —
    zero plumbing/insurance leakage. Dispatch header shows enabled-pack chips.
  - **SSO federation**: per-org OIDC config in Settings → Identity
    (`ssoProvider/ssoIssuerUrl/ssoClientId/ssoClientSecret` on organizations);
    `/auth/sso/[org]` builds the authorize redirect, `/auth/sso/callback`
    exchanges + resolves the user within the org and creates the session; login
    page has an SSO workspace-slug path. **Local auth stays the default.**
    Verified: config persists and the per-org entry builds a correct OIDC
    authorize URL to the tenant IdP.

## Status: Phases 0–4 complete + Fuel Equipment vertical

The Trade-Ops core satisfies all 12 ratified constraints. **Trade packs are now
first-class and self-service**, proving "one core, many packs" at depth:

- **Rich pack config**: `tradePacks.config` carries `jobTypes`,
  `equipmentKinds`, `certTypes`, `safetyDocs`, and `inspectionTemplates` — all
  data-driven; the core schema stays trade-neutral (no fuel enums, no plumbing
  assumptions). Helpers in `src/lib/trade-packs.ts` compose these from the org's
  ENABLED packs only.
- **Pack management + provisioning** (`src/lib/actions/packs.ts`, Settings →
  Trade Packs): admins enable/disable packs live and **provision** a pack's
  inspection templates into the tenant (idempotent, audited). Verified: enabling
  Fuel Equipment on Summit added it live, provisioning created its 2 templates,
  re-provisioning was a no-op.
- **Fuel Equipment vertical** (Kevin's-App harvest target): the `fuel_equipment`
  pack ships 8 job types, 7 equipment kinds (UST/AST/dispenser/cardlock/lube…),
  2 compliance templates (UST Annual Tightness Test → cert; Weights & Measures
  Dispenser Calibration → seal), 5 cert types, and safety docs. Seeded
  **Mascott Fuel Services** tenant (QuikTrip site, 3 USTs + dispensers +
  cardlock, UST/W&M jobs, Class B operator cert expiring, provisioned
  templates). Verified: Mascott sees ONLY fuel job types (zero plumbing
  leakage); Apex never sees fuel types or Mascott data.

Four seeded tenants now demonstrate composition + isolation: Apex Plumbing
(plumbing+sewer), Summit HVAC (hvac+plumbing), American Automators
(aa_field_ops), Mascott Fuel Services (fuel_equipment).

Remaining depth: real IdP/OIDC signature verification, supplier punchout, live
connector implementations beyond Odoo, and the fuel domain's richer equipment
records (dispenser/tank sub-attributes) as pack-scoped custom fields.
(Offline-first is now complete end-to-end — capture, durable queue, binary
photo upload, and PWA app shell all shipped and verified.)
