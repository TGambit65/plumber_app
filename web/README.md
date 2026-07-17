# plumber_app — web

The plumber_app application: a field-service platform for plumbing companies with four role-based experiences (Field Tech, Sales/PM, Office, Admin/Owner). Built per the product spec in [`../docs`](../docs).

## Stack

- **Next.js 14** (App Router, server components + server actions, TypeScript)
- **PostgreSQL** with **Drizzle ORM** (pure-TS, migrations in `drizzle/`)
- **Tailwind CSS** with a small in-repo UI kit (`src/components/ui.tsx`)
- Cookie-session auth (jose JWT, bcrypt passwords), granular RBAC (`src/lib/permissions.ts`)
- **Vitest** unit tests, Playwright smoke-tour script (`scripts/screenshot-tour.mjs`)

## Getting started

```bash
# 1. Postgres — any instance works; create a database
createdb plumber_app

# 2. Configure
cp .env.example .env   # set DATABASE_URL + a strong SESSION_SECRET

# 3. Install, migrate, seed
npm install
npm run db:push        # apply schema (drizzle-kit)
npm run db:seed        # realistic demo data + demo accounts

# 4. Run
npm run dev            # http://localhost:3000
```

### Demo accounts (password `demo1234`)

Two tenants are seeded to demonstrate isolation (see Multi-tenancy below):

| Email | Org | Role |
|---|---|---|
| `owner@apexplumbing.demo` | Apex Plumbing | Admin / Owner |
| `office@apexplumbing.demo` | Apex Plumbing | Office / Dispatch |
| `sales@apexplumbing.demo` | Apex Plumbing | Sales / Project Manager |
| `tech@apexplumbing.demo` | Apex Plumbing | Field Technician |
| `owner@summithvac.demo` | Summit HVAC | Admin / Owner |
| `tech@summithvac.demo` | Summit HVAC | Field Technician |

### Multi-tenancy (Trade-Ops core)

This app is the multi-tenant **Trade-Ops** core (see
[`../docs/strategy/architecture.md`](../docs/strategy/architecture.md)). Every
tenant-owned row carries `organization_id`; isolation is enforced by Postgres
**FORCE RLS on all 41 tenant tables** via the `withTenant(orgId, …)` primitive
(login uses the `auth_user_by_email()` SECURITY DEFINER bootstrap). Verified
end-to-end: neither org can see the other's customers, jobs, invoices, price
book, messages, team, SOPs, or search results, and unscoped connections read
zero rows. Run `npm run db:rls` (as a superuser) after `npm run db:seed`.

## What's implemented

**Field tech (mobile-first):** My Day route with status-advance flow (auto "on my way" texts, auto time entries), job detail with property memory + equipment history, photo checklists, required forms, truck-stock consumption, part requests, tech lead-flagging with spiffs, and the guided **two-minute closeout** (photos → forms → AI-draft summary → invoice → sign → pay → review request).

**Sales/PM:** sales cockpit (follow-ups due, hot signals, SLA timers, pipeline, live commission), unified lead inbox with source attribution + speed-to-lead SLAs, kanban pipeline, **good-better-best estimates** with monthly-financing framing, e-sign approval (auto job + commission creation), default-on 7-day follow-up sequences, and projects with milestones, progress billing, e-signed change orders, permits/inspections (with completion blocking), budget vs. actuals, and subcontractor COI tracking.

**Office:** dispatch board with unassigned lane + booking flow, all-jobs list, customer 360 (timeline, property memory editing), invoices/AR with aging sweep + payment capture.

**Admin/Owner:** company dashboard (revenue, close rate, scoreboards, AR aging), settings (team management, **integrations hub** with CRM/accounting/supplier connector stubs, commission rules + approvals, audit log), price book with margin guardrails, company-wide commissions. Full team administration: change a user's role, **grant/revoke individual permissions on top of their role** (per-user overrides), and **deactivate a user with one-step reassignment** of their open jobs, leads, and estimates to another user.

**Shared:** knowledge base with search + markdown SOPs + verification workflow, **in-app messaging** (1:1 and group threads between any users, unread badges in the nav), inventory (warehouse + truck-as-warehouse, min/max replenishment → auto-PO, receiving), global search, notifications, full audit logging.

### Company knowledge base & OrgMemory

The knowledge base runs behind a pluggable `KnowledgeStore` interface (`src/lib/knowledge/`). By default it uses local Postgres keyword search. When **OrgMemory** (the on-prem MCP-native memory substrate) is connected in Settings → Integrations, the KB switches to semantic search over OrgMemory's gateway and **mirrors every authored SOP into OrgMemory** on save (mirror-both-ways). The adapter targets OrgMemory's MCP-over-HTTP `tools/call` surface (`memory.search`, `document.ingest`) with JWT auth, and gracefully falls back to local keyword search whenever the gateway is unreachable — so the KB never hard-fails while OrgMemory is still pre-MVP.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` / `build` / `start` | Next.js lifecycle |
| `npm run db:push` | Apply schema to `DATABASE_URL` |
| `npm run db:generate` | Generate SQL migration files |
| `npm run db:seed` | Reset + seed demo data (destructive) |
| `npm test` | Vitest unit tests |
| `node scripts/screenshot-tour.mjs` | Authenticated smoke tour + screenshots (needs `npm run start` + Playwright) |

## Architecture notes

- **Money is integer cents** everywhere; format at the edge with `money()`.
- **Server components fetch, server actions mutate** — no client data fetching; forms work without JS (progressive enhancement).
- **RBAC**: granular permissions bundled into four roles; `can(role, permission)` guards every sensitive action server-side; scoped "own vs all" reads are enforced in queries.
- **Audit + timeline**: sensitive mutations write `audit_logs`; customer-facing events write `activities` (the per-customer unified timeline).
- **Integrations** are deliberately stubbed behind the `integration_connections` table + hub UI — the sync architecture (webhook-first, identity map, field-of-record policy) is specified in [`../docs/06-integrations.md`](../docs/06-integrations.md) and slots in without schema changes.
- **Offline-first mobile** is Phase-1-groundwork only in this web build (mobile-first layouts, big tap targets); the local-first sync layer is specified in [`../docs/04-field-tech-requirements.md`](../docs/04-field-tech-requirements.md).
