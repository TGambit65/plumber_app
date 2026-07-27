# Trade-Ops core — Status

Single source of truth for known defects and their real state. Reconciled
**against the codebase**, not against commit messages: an item is only ✅ when
someone has run the thing and watched it behave.

Modelled on the equivalent file in Kevin's App, which is the reason that
project's open problems are known rather than discovered by customers.

**Legend:** ✅ Fixed & verified · 🟡 Partial · 🔴 Open · ⚪ Accepted (understood, deliberately unchanged)

_Last reconciled: 2026-07-27._

## Critical

| # | Issue | Status | Evidence |
|---|-------|--------|----------|
| 1 | `rls.sql` hardcoded `GRANT EXECUTE … TO plumber`, so any deployment whose DB role was named anything else came up with the REVOKEs applied and the GRANTs missing. `auth_user_by_email` is the login bootstrap — **nobody could log in**, and the public proposal/pay/calendar/punchout capabilities were dead too. `psql` still exited 0. | ✅ | Grants now discover the table owner (`pg_tables.tableowner`) and are asserted in a follow-up `DO` block; `\set ON_ERROR_STOP on` at the top of `rls.sql`. Reproduced under a role named `app` (all five functions `has_function_privilege = false`, `permission denied for function auth_user_by_email`), then verified green under `app` and `tradeops_ci`. |

## High

| # | Issue | Status | Evidence |
|---|-------|--------|----------|
| 2 | Job photos were written to `public/uploads/<orgId>/` and referenced by raw path. Anything under `public/` is served by Next with **no session check**, so photos were readable by anyone holding or guessing a URL, across tenants, with the org id in the path. Compounding it, `next start` snapshots `public/` at boot, so uploads 404'd until the next restart and then became publicly readable. | ✅ | Reproduced: `curl` of a runtime-written file returned `200` with its bytes after a restart. Files now live under `$UPLOADS_DIR` (default `var/uploads`, outside the web root) and are served only by `GET /api/photos/[id]`, which re-checks the session and resolves the row inside `withTenant()`. Verified matrix: no session `401`, other tenant `404`, owner `200`, `?v=thumb` `200`, traversal `404`, old static path `404`. |
| 3 | `middleware.ts` sat at the repo root while the app lives in `src/`, so Next never registered it — `middleware-manifest.json` listed none. The intended second layer of auth had never run. | ✅ | Moved to `src/middleware.ts`; build now reports `ƒ Middleware`. Scope deliberately narrowed to **page routes only** — `/api/*` is excluded because Stripe/Jobber webhooks, Twilio inbound SMS, the ICS feed, punchout return and the customer proposal/pay links are sessionless by design and authenticate themselves. Covered by `middleware-routing.test.ts`. |

## Medium

| # | Issue | Status | Evidence |
|---|-------|--------|----------|
| 4 | No CI. 140 tests existed and nothing ran them; the `db:verify-rls` guard only ran if a human remembered. | ✅ | `.github/workflows/ci.yml`: lint → typecheck → test → build, plus a database job that pushes the schema, applies `rls.sql`, runs the RLS coverage guard, asserts all five capability grants, and seeds. The DB job's role is deliberately **not** named `plumber`, which is what makes issue #1 fail in CI instead of in production. Every step was run locally against Postgres 16 before being written. |
| 5 | Middleware fell back to a literal `"dev-secret"` when `SESSION_SECRET` was unset — a token forged with a publicly known key would have verified. Latent only because the middleware never ran. | ✅ | Now fails closed: missing secret logs an error and redirects to `/login`. Note `src/lib/auth.ts` still has the same `?? "dev-secret"` fallback — see #7. |
| 6 | Docs claimed "FORCE RLS on all 41 tenant tables" in two places and 51 in another; the real number is 52. | ✅ | Corrected in `architecture.md` and `web/README.md`. `verify-rls.ts` remains the authoritative check. |

## Open

| # | Issue | Status | Notes |
|---|-------|--------|-------|
| 7 | `src/lib/auth.ts` still defaults `SESSION_SECRET` to `"dev-secret"`. | 🔴 | Same class as #5 but on the primary session path, so changing it is a deployment-breaking move if any environment is relying on the default. Should fail closed in production; needs a decision on whether to hard-fail at boot. |
| 8 | Offline outbox queue is not encrypted at rest. | 🔴 | Carried over from the Phase 4 notes. IndexedDB contents are readable by anything with device access. |
| 9 | Per-field merge UI for sync conflicts is unbuilt; conflicts resolve server-wins. | 🟡 | Documented in `offline-sync-spec.md`. Acceptable while single-writer-per-job holds; will bite on shared jobs. |
| 10 | QuickBooks connector takes a live access token; no OAuth refresh. | 🔴 | Tokens expire in ~1h, so the integration silently stops working. |
| 11 | Test coverage is thin relative to surface area — 158 tests against ~39k lines, with no coverage gate. | 🟡 | The tenancy spine (`withTenant`, RLS isolation, sync conflict resolution) is where a silent regression is most expensive and least covered. |
| 12 | No deployment tooling — no Docker Compose, no backup/restore scripts, no runbook. | 🔴 | Kevin's App has all three with a verified restore round-trip. Nothing here has been proven recoverable. |

## Verification commands

```bash
cd web
npm run test                 # unit tests
npx tsc --noEmit             # typecheck
npm run build                # production build
npx tsx src/db/verify-rls.ts # every tenant table RLS-enabled, forced, policied
```
