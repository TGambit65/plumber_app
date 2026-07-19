# Management Functionality Plan — full CRUD/lifecycle across every side-menu screen

**Status: IN PROGRESS** — M1 ✅ DONE · M2–M6 pending.

## 1. The problem

A full audit of all 22 side-menu screens (every role's nav) shows a consistent
pattern: the app is excellent at **creating and advancing** records but almost
everything is **write-once**. Users cannot edit, correct, archive, cancel, or
(in one glaring case) even create the records they manage daily.

Headline findings:

- **Projects cannot be created at all.** No `createProject` action exists.
  Projects only exist via seed data. They also cannot be edited, their status
  (PLANNING/ACTIVE/ON_HOLD/COMPLETED/CLOSED) can never change, and milestones
  cannot be added, edited, or removed.
- **Edit-after-create is absent almost everywhere.** Jobs, customers,
  properties, equipment, leads, estimates (header/options/notes), invoices
  (line items), KB articles, inspection templates, certifications, carriers,
  adjusters, commission rules, pricebook non-price fields, users
  (name/email/phone), and the org profile all have zero edit UI. One typo is
  permanent.
- **Unreachable states.** Enum values exist with no UI path: `jobs.CANCELLED`,
  `estimates.EXPIRED`, `changeOrders.REJECTED`, PO `PARTIAL`/`BILLED`,
  outbound `CANCELLED`. `jobs.deletedAt/deletedById` soft-delete columns are
  never used. `scheduledEnd` (job duration) is never captured by any form.
- **No archive/delete anywhere.** Junk leads, duplicate customers, obsolete
  KB articles, and dead conversations are permanent fixtures.
- **Dead-end integrations.** The claims screen says "link an estimate from
  the estimate builder" but the builder has no such control. Settings →
  Company tab is hardcoded JSX ("Plumb Zebra LLC" is a string literal).

## 2. Design principles (apply to every phase)

1. **Archive over delete.** Default lifecycle exit is soft-archive
   (`archivedAt` or existing `deletedAt`), reversible, hidden from default
   lists behind a "Show archived" filter. Hard delete only where a record has
   no FK children AND no financial/audit meaning (e.g. an OPEN part request).
2. **Edit-in-place, no new stack.** Reuse the existing pattern: a
   `<details><summary>Edit</summary><form action={serverAction}>` block on
   detail pages, server actions in the existing `src/lib/actions/*` modules,
   `withTenant` + permission checks + `audit(...)` on every mutation. No
   client-state libraries.
3. **Status maps stay explicit.** Extend the transition-map pattern
   (`CLAIM_NEXT`) rather than free-for-all status dropdowns. Add deliberate
   back-transitions (reopen, unarchive, un-void→credit) with audit actions
   named for what happened (`JOB_CANCELLED`, `CLAIM_REOPENED`).
4. **Money is immutable once real.** Sent/paid invoices, approved estimates,
   PAID commissions are never edited in place — corrections happen through
   explicit reversal records (void + reissue, credit, un-approve with reason).
5. **Every phase ships with verification.** Unit tests for new pure logic +
   a `verify-m{n}.mjs` Playwright e2e per phase, same as D1–D5.
6. **Permissions reuse.** No new permission keys unless unavoidable; gate
   edits behind the same keys that gate creation on that screen
   (`customers.edit`, `pipeline.manage`, `projects.manage`, `claims.manage`,
   `inventory.manage`, `kb.author`, ADMIN for settings).

## 3. Phases

### Phase M1 — Core records: jobs, customers, leads ✅ DONE

The records office staff touch hourly. Highest impact, most-reported pain.
Shipped exactly as specified below, plus a shared pure rules module
(`src/lib/manage/lifecycle.ts` — revert map, reschedule/cancel/archive
guards, archive blockers with human-readable reasons) and new action modules
`src/lib/actions/jobs.ts` / `src/lib/actions/customers.ts` (+ lead actions
in `sales.ts`). Schema: `archived_at` on customers/properties/equipment/
leads (jobs reuse the existing `deleted_at`/`deleted_by_id`).
Verified: 13 new unit tests (126 total) + 38-check Playwright e2e
(`verify-m1.mjs`): every action exercised through the real UI with DB and
audit-row assertions; archive guards refuse open work; archived records
vanish from lists/pickers/pipeline and return via "📦 Show archived";
reschedule PATCHes the same calendar event and cancel deletes it.

**Jobs** (`jobs/[id]`, dispatch board)
- `updateJob`: jobType, description, internalNotes, priority.
- `cancelJob`: sets CANCELLED with required reason (stored in internalNotes +
  audit); blocked for COMPLETED; frees the dispatch slot; deletes the pushed
  calendar event.
- `rescheduleJob`: change scheduledAt **and scheduledEnd** (finally capture
  duration; default 120 min stays for legacy rows), change assigned tech, or
  **unassign** back to the lane — without clobbering an in-flight status.
- `revertJobStatus`: one safe step back (EN_ROUTE→DISPATCHED→SCHEDULED) for
  mis-taps; never backwards out of COMPLETED.
- Archive: wire the existing `deletedAt/deletedById` columns — archive
  CANCELLED/COMPLETED jobs off the list (filter chip to show them).
- Dispatch board: "Unassign" + "Edit time" on placed cards; booking form gains
  duration + internal notes.

**Customers** (`customers/[id]`)
- `updateCustomer`: name, company, email, phone, type, notes.
- `smsOptOut` manual toggle (schema comment already promises it).
- `archiveCustomer` (new `archivedAt` column): hidden from lists/pickers,
  blocked while open jobs/invoices exist, reversible.
- `updateProperty` (label/address/city/state/zip — re-geocodes on address
  change) + `archiveProperty` (blocked if open jobs reference it).
- `updateEquipment` + `removeEquipment` (archive).
- Membership management: create/edit/cancel membership (plan, status,
  renewsAt) — table exists, UI doesn't.

**Leads** (`leads/[id]`, pipeline)
- `updateLead`: title, contact fields, source, estValue, description.
- `reassignLead`: change rep any time (audited).
- `archiveLead` (new `archivedAt`): for junk/duplicates; excluded from
  pipeline + SLA stats.
- Link/unlink customer+property directly (not only via convert-to-estimate).
- Reopen: LOST/WON → back to an open stage with reason (audited).
- Pipeline board: stage **jump** dropdown per card (not just ◀/▶); moving to
  LOST via the board requires the same lostReason as the detail page.

### Phase M2 — Projects: full lifecycle (the "can't add a project" fix)

- `createProject`: name, customer, property, contract value, budgets
  (labor/materials), start/end dates — from the Projects list page, plus a
  "Promote to project" action on an approved estimate/job (links it and
  copies value).
- `updateProject`: every header field.
- `setProjectStatus`: explicit map PLANNING→ACTIVE→(ON_HOLD⇄ACTIVE)→
  COMPLETED→CLOSED, with reopen CLOSED→COMPLETED for corrections.
- `archiveProject` on CLOSED.
- **Milestones:** create, edit (name, dueDate, billing amount,
  requiresInspection), delete-if-unbilled, reorder (sortOrder), manual
  BLOCK/unblock with reason.
- **Change orders:** `rejectChangeOrder` (enum value exists), edit while
  PENDING.
- **Costs & subs:** edit + delete cost entries (with `incurredAt` picker);
  edit + remove subcontractors, COI renewal (update expiry).
- **Job linkage:** link/unlink jobs to a project (mirror the claims pattern).
- Invoices: milestone invoicing exists; add project-level ad-hoc invoice
  (feeds M3's standalone invoice creation).

### Phase M3 — Documents & money: estimates, invoices, commissions

**Estimates**
- Standalone create from the Estimates list or a customer page (no lead
  required).
- Edit options: rename, description, tier, remove option (blocked if it's the
  approved one), reorder.
- Edit notes + toggle financingOffered; line-item `optional` flag.
- `expireEstimate` (manual EXPIRED) + auto-expire past `expiresAt`;
  `reopenEstimate` DECLINED/EXPIRED→DRAFT with audit.
- **Claim linking from the builder** (closes the dead-end the claims screen
  advertises): set/clear `claimId` from a picker of open claims.
- Duplicate estimate (new DRAFT copy) — cheap and constantly requested.

**Invoices**
- **Invoice detail page** (`invoices/[id]`) — currently line items are only
  visible mid-closeout. Shows lines, payments, signature, audit trail.
- Line management while DRAFT: add / edit qty+price / remove.
- Standalone invoice creation (customer or project, pick lines from price
  book) — not only via job closeout.
- Edit `dueAt`/`issuedAt` while DRAFT; payment `reference` field captured.
- Resend / send-reminder per invoice.
- Correction path per principle 4: VOID stays terminal, add "void & duplicate
  as DRAFT" one-click.

**Commissions** (screen + settings tab)
- Edit + delete commission **rules** (currently create+toggle only; a wrong
  rate is stuck forever).
- Bulk approve / bulk mark-paid by period (payroll run is currently one click
  per row).
- Un-approve APPROVED→PENDING with reason; PAID stays immutable.
- Manual entry create/adjust (audited) for spiffs/corrections.

### Phase M4 — Knowledge, messages, approvals, compliance

**Knowledge base**
- `updateKbArticle` (title, body, category, tags) — finally makes
  `updatedAt` real; editing clears `verifiedAt` (stale content must be
  re-verified).
- Archive/unpublish article (hidden from list + search, restorable).
- Un-verify action for admins.

**Messages**
- Rename group, add/remove participants (creator or ADMIN).
- Leave conversation; archive thread (per-user hide, not global delete).
- Delete own message within a grace window (soft-delete → "message removed"
  placeholder); no edit-after-send (keeps the audit story simple).

**Approvals**
- Withdraw own pending request (sets the existing CANCELLED enum).
- Edit subject/body of own pending item before an approver acts.
- Bulk approve for low-risk kinds; paginated decision history.

**Compliance**
- Edit + deactivate inspection **templates** (the run page already tells
  users to "edit the template on the Compliance page" — make that true).
- Edit + renew + revoke certifications; EQUIPMENT holder option in the form
  (schema supports it, form doesn't).
- Reschedule inspection + reassign inspector; reopen a CANCELLED inspection.

### Phase M5 — Inventory, claims, settings/admin

**Inventory**
- Add stock row (start tracking an item at a location — the empty state
  already promises this); edit `minQty`/`maxQty`/`bin`.
- Inventory **locations** CRUD: add warehouse/truck, assign truck to a tech,
  rename, retire.
- **Transfer stock** between locations (warehouse→truck is the daily flow).
- POs: manual create, add/edit/remove lines while OPEN, cancel, supplier +
  expected-date edit, **partial receive** (per-line receivedQty — schema
  already supports PARTIAL), mark BILLED.
- Part requests: edit qty/description while OPEN; office can cancel any.

**Claims**
- Edit carrier/adjuster records (typo'd portal URL is currently permanent);
  reassign a claim's carrier/adjuster/customer/property; edit claimNumber.
- `reopenClaim` (CLOSED/DENIED → prior state, reason required); supplement
  edit while DRAFT.

**Settings / admin**
- Edit user name/email/phone; admin password reset (temp password);
  resend invite. Deactivate remains the "delete".
- Truck assignment UI on the Team tab (drives inventoryLocations.userId).
- **Company tab backed by real data**: add org columns (businessPhone,
  businessEmail, licenseNumber, serviceArea, hoursOfOperation, address) +
  `updateOrganization` action for those + name + brandPrimary (brand color
  already feeds theming). Slug stays immutable (it's in webhook/feed URLs).

### Phase M6 — Polish & cross-cutting (optional, post-pilot)

- "Show archived" filter chips on every list; restore actions.
- Dashboard: date-range picker + CSV export; drill-through links.
- Earnings: "dispute entry" button (opens a message to admins with context).
- Bulk operations pass: multi-select on jobs/leads/invoices lists.
- Pricebook: edit name/code/category/description/laborHours (small, could
  pull into M3 with the money work); CSV import/export.

## 4. Sequencing rationale

M1 first because jobs/customers/leads are every role's daily surface and the
pilot demo will be judged on them. M2 second because "can't add a project" is
a visible, embarrassing hole with zero workaround. M3 protects revenue
accuracy. M4–M5 round out the long tail. Each phase is independently
shippable and verified end-to-end before moving on.

## 5. Verification per phase

- Unit tests for every new pure helper (status maps, archive guards,
  transfer math).
- `verify-m{n}.mjs` Playwright e2e per phase against the seeded Plumb Zebra
  tenant: exercise each new action through the real UI, assert DB state,
  assert audit rows exist, assert archived records vanish from lists and
  return via the filter.
- RLS: every new action goes through `withTenant`; `db:verify-rls` stays in
  the chain.
- Reseed pristine + full suite green before each commit, as with D1–D5.
