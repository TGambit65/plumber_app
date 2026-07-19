# Dispatch: Integrations & Intelligence Plan

*Drafted 2026-07-18 · grounded in the code as of commit `f01142d`*

## 1. How dispatch works today (current state)

### The workflow

Dispatch (`/dispatch`, `src/app/(app)/dispatch/page.tsx`) is a **day-view board**:
an amber **Unassigned lane** plus **one column per active tech** (with truck),
stat row (jobs on board / scheduled / in the field / completed / open
emergencies), a status legend, and a **Book a job** form (customer → property
cross-validated, job types composed from the org's enabled trade packs,
priority, optional schedule + tech).

Two server actions drive it (`src/lib/actions/office.ts`):

- **`bookJob`** — creates the job (`SCHEDULED` if a time was picked, else
  `UNSCHEDULED` → lands in the unassigned lane).
- **`assignJob`** — sets `assignedToId + scheduledAt`, flips status to
  `SCHEDULED`, writes a timeline activity, and **notifies the tech in-app**
  (notifications table → bell + `/my-day`).

From there the job moves through the tech's hands (`/my-day`, `/field`):
`SCHEDULED → DISPATCHED → EN_ROUTE → IN_PROGRESS → COMPLETED`, each transition
written by the offline-capable sync queue.

### How it communicates

| Channel | Mechanism today | Real delivery? |
|---|---|---|
| Dispatcher → tech | In-app notification + `/my-day` route | ✅ in-app only (no push/SMS) |
| Tech → customer ("on my way") | `EN_ROUTE` transition logs "On my way text sent" | ❌ simulated — Twilio connector is a stub |
| Office → customer | `outbound_messages` approval-gated queue (`CUSTOMER_MESSAGE` etc.) | ❌ executes via stub connectors |
| Team ↔ team | Conversations/messages module | ✅ in-app |
| Customer → office | Phone/manual — no self-serve booking or confirmation loop | ❌ none |

### Relationship to CRM

CRM connectors (Odoo live JSON-RPC, HubSpot live REST, + stubs) are **upstream
of dispatch**: they sync **leads** into `/leads`, which become estimates, which
become jobs. Dispatch itself doesn't read or write any CRM — by design: jobs,
scheduling, and crew are core-owned. The correct CRM touchpoint for dispatch is
**activity write-back** (job booked/completed events pushed to the CRM record),
not CRM-driven scheduling.

### The honest gaps

1. **No real customer communication** — the biggest one. On-my-way texts,
   booking confirmations, and reminders are simulated.
2. **No calendar surface** — techs and owners live in Google/Apple/Outlook
   calendars; the schedule is invisible outside the app.
3. **No geography** — properties have addresses but no geocoding; the board
   knows nothing about drive time, so assignment quality depends entirely on
   the dispatcher's mental map.
4. **Assignment is manual** — no skill/cert matching, no load balancing, no
   emergency-insertion help.
5. **No coexistence path** — a shop already on Jobber/ServiceTitan can't pilot
   alongside or migrate incrementally (jobs connectors are stubs).

---

## 2. The integration space, analyzed

Evaluated on: current API availability, auth model, build effort, and value to
dispatch specifically. Constraint alignment: every integration stays **optional**
(standalone-first), **typed** on the connector interface, and **loud on
failure**; anything customer-facing keeps flowing through the approval-gated
egress queue.

### Tier 1 — build first (high value, low friction)

| Integration | What it does for dispatch | API/auth | Effort | Notes |
|---|---|---|---|---|
| **ICS calendar feeds** (universal) | Per-tech + whole-org read-only feed URL; subscribable from **Apple Calendar, Google Calendar, Outlook, and anything else** | None — signed, unguessable HTTPS feed we serve | **S** | The 80% calendar win in one move. Apple has **no public REST API**, so ICS is the only zero-friction Apple path; iCloud CalDAV needs per-user app-specific passwords. |
| **Twilio SMS (real)** | Real on-my-way texts with live ETA, booking confirmations, day-before reminders | API key (already a descriptor) | **S–M** | Turns the simulated `EN_ROUTE` text into the killer dispatch feature. All sends stay approval-policy-controlled (auto-allow templated transactional, gate free-text). |
| **Google Calendar (two-way)** | Job assignments appear in each tech's Google Calendar; edits/conflicts visible; busy-blocks respected on assignment | OAuth 2.0 per org/user; stable v3 API | **M** | The dominant SMB calendar. Push notifications (watch channels) enable near-real-time sync back. |
| **Google Maps Geocoding + Routes** | Geocode properties once; show drive-time between consecutive jobs on the board; warn on impossible schedules | API key | **S–M** | Foundation for everything routing. Routes API prices per element; light usage at shop scale. |

### Tier 2 — next (high value, moderate friction)

| Integration | What it does for dispatch | API/auth | Effort | Notes |
|---|---|---|---|---|
| **Microsoft 365 / Outlook (Graph)** | Two-way calendar for shops on Microsoft | OAuth 2.0 (Graph) | **M** | Same adapter shape as Google; do second. |
| **Google Route Optimization API** | True multi-stop, multi-tech day optimization (VRP): time windows, priorities, shift bounds | GCP service account | **M** | Purpose-built fleet routing (formerly Cloud Fleet Routing); per-shipment pricing. The "pro" engine behind AI routing. |
| **OSRM/VROOM (self-hosted)** | Same class of route optimization at **zero marginal cost** | None (self-hosted) | **M** | Open-source fallback/default so routing costs nothing until a shop opts into Google-grade traffic awareness. |
| **Jobber (live)** | Import/sync jobs, clients, visits — pilot alongside or migrate from Jobber | GraphQL + OAuth 2.0, webhooks | **M** | Open developer program; webhooks make near-live coexistence practical. Upgrade existing stub to live. |
| **iCloud CalDAV (push)** | True event *push* into Apple Calendar for techs who want more than the ICS feed | App-specific password per user (`caldav.icloud.com`) | **M** | Optional add-on; ICS remains the default Apple path. |

### Tier 3 — later / situational

| Integration | Why later | Notes |
|---|---|---|
| **ServiceTitan (live)** | Highest-friction API: developer-portal app registration + per-tenant approval + app key. Worth it when a target customer is on ST | Position as **migration/coexistence**, not long-term sync; upgrade existing stub |
| **Housecall Pro (live)** | Smaller overlap audience; simple token API | Upgrade stub when demand appears |
| **CRM activity write-back** (HubSpot/Odoo) | Nice-to-have: log "job booked/completed" on the CRM timeline | Small extension of existing live CRM connectors |
| **Slack/Teams alerts** | Emergency-job broadcast to an ops channel | Trivial webhook; do opportunistically |
| **Outbound webhooks / Zapier** | Long-tail "connect anything" | One generic signed-webhook emitter covers hundreds of tools |

**Explicitly not worth building:** a native Apple "API" integration (doesn't
exist — EventKit is on-device only), and CRM-driven dispatch (scheduling
belongs in core; CRMs get read-only visibility).

---

## 3. Making dispatch more valuable: the functionality plan

Sequenced so each phase ships standalone value and feeds the next.

### Phase D1 — The communication loop ✅ DONE (2026-07-18)
The board talks for real now. Shipped and verified end-to-end vs a
vendor-shaped mock Twilio:
- **Live Twilio connector** (`src/lib/connectors/twilio.ts`) — Messages API,
  basic auth, form-encoded, SMS-only (email fails loudly), baseUrl-overridable.
- **Templated transactional pipeline** (`src/lib/comms/`) — ON_MY_WAY /
  BOOKING_CONFIRMATION / REMINDER render from fixed templates (no free text →
  auto-send policy); free-text still approval-gated. EVERY attempt recorded in
  `outbound_messages` with honest `deliveryStatus`
  (SENT/FAILED/SKIPPED_OPTOUT/SKIPPED_NO_PHONE/SKIPPED_NOT_CONNECTED) + Twilio SID.
- **Hooks**: `assignJob`/`bookJob` → confirmation; `EN_ROUTE` via the online
  action AND the offline sync push (post-commit, deduped so queue replays never
  double-text) → on-my-way naming the tech; activity log states what actually
  happened.
- **Reminder sweep** — dispatch-board button texts every customer scheduled
  tomorrow; deduped per job (safe to re-run / cron).
- **STOP/START webhook** (`/api/sms/inbound/[org]`) — Twilio-signature-verified
  (HMAC-SHA1, forged → 403); flips `customers.smsOptOut`, honored by every send.
- **Delivery visibility** — "Customer notifications" panel on the job detail
  page with per-message status + error.
Verified: confirmation/on-my-way/reminder round-trips, dedupe, opt-out honored
(SKIPPED_OPTOUT recorded, nothing sent), forged-signature rejection.

### Phase D2 — The calendar spine ✅ DONE (2026-07-18)
Shipped and verified end-to-end:
- **ICS feeds** (`src/lib/calendar/ics.ts`, `/api/calendar/[token]`) — RFC 5545
  generator (escaping, 75-octet folding, UTC, CANCELLED status); per-tech +
  whole-org feeds subscribable from **Apple Calendar, Google Calendar, Outlook**
  with zero auth (the unguessable token is the capability, resolved via a
  SECURITY DEFINER lookup; revoking in Settings 404s the URL immediately).
  Managed from Settings → Integrations → Calendar feeds.
- **Google Calendar connector** (`google-calendar.ts`, `calendar` capability on
  the typed interface: upsertEvent/deleteEvent/listBusy) — OAuth refresh-token
  → cached access token, Events insert/PATCH, freeBusy. Secrets encrypted at
  rest; loud degraded failures.
- **Outlook / Microsoft 365 connector** (`outlook-calendar.ts`) — Microsoft
  Graph, same adapter shape (calendarView busy read filters showAs=free).
- **Event push** (`src/lib/calendar/push.ts`) — assignJob/bookJob mirror the
  job into the org's connected calendar (title, tech, location, times); the
  provider event id is stored on the job so reschedules PATCH the same event.
  Calendar failures never block dispatch.
- **Busy-window soft conflicts** — the dispatch board shows the day's external
  busy windows and flags overlapping jobs with a ⚠️ marker (never blocking).
Verified: 74 unit/integration tests (ICS RFC compliance; both connectors vs
vendor-shaped mocks incl. token refresh, PATCH-vs-POST, token caching, 401s) +
12-check Playwright e2e (feed create/serve/subset/revoke-404, real event push
with stored id, busy strip + conflict flags).

### Phase D3 — Geography on the board ✅ DONE (2026-07-19)
Shipped and verified end-to-end:
- **Coordinates on properties** (`lat/lng/geocodedAt`); geocode-on-create hook
  caches coordinates via the geo connector; seed ships demo coords.
- **New `geo` capability** + **GOOGLE_MAPS connector** — real Geocoding API +
  Routes API v2 (computeRoutes with X-Goog-FieldMask); key encrypted at rest.
- **Honest drive times** (`src/lib/geo/`): routed via Google Maps when
  connected; otherwise a haversine ESTIMATE (winding factor + stop overhead)
  that the UI explicitly labels "est." — a guess is never presented as routing.
- **Chain analysis** — per-tech consecutive-job hops classified
  ok / tight (<10 min slack) / **impossible** (gap < drive) / unknown (no
  coords); chips between cards on the board, red "⛔ Can't make it" flags.
- **Day map** — self-contained SVG (no external tiles, works offline):
  stops plotted in visit order, one color per tech.
Verified: 82 unit/integration tests (geo math incl. chain classification;
GOOGLE_MAPS vs vendor-shaped mock) + 12-check Playwright e2e — estimate mode
labels + naturally-occurring impossible hop flagged; connecting the (mock)
Maps connector switches chips to routed times, clears the flag when routing
says the hop fits, and geocodes new properties on create.

> **Incident hardening (2026-07-19):** an environment restart dropped RLS
> flags from the database; the `db:verify-rls` guard caught cross-tenant
> visibility on the dispatch board during D3 verification. Fixed by
> re-applying `db:rls`, and institutionalized: `npm run db:push` now chains
> the RLS coverage guard, and **seeding refuses to run** against a database
> whose tenant tables aren't FORCE-RLS-protected (loud pre-flight in seed.ts).

### Phase D4 — AI-assisted dispatch ✅ DONE (2026-07-19)
Philosophy held: **the engine proposes, the dispatcher disposes** — nothing
auto-applies, every decision audited. Shipped and verified end-to-end:

- **Pure suggestion engine** (`src/lib/dispatch/engine.ts`, fully unit-tested):
  - `scoreTechsForJob` — ranks techs by cheapest feasible insertion slot:
    added drive · load · transparent cert↔job-type match · feasibility, with
    human-readable reasons + score parts.
  - `emergencyInsertion` — least-disruption analysis ("absorbs it without
    moving any job" vs "pushes 2 jobs by 45 min total").
  - `optimizeDay` — nearest-neighbor + 2-opt over the drive matrix, retimed
    schedule preserving durations, returned as before/after totals.
- **Board suggestions** — unassigned jobs show "✨ Suggested: Jake · 3:30 PM"
  (EMERGENCY jobs get "🚨 Least disruption" framing) with reasons + runner-up;
  **Accept** runs the exact manual-assign pipeline (activity, tech notify,
  confirmation SMS, calendar push) + `AI_SUGGESTION_ACCEPTED` audit;
  **Dismiss** records `AI_SUGGESTION_REJECTED` — the training signal.
- **Optimize-my-day diff** (`/dispatch/optimize`) — current vs proposed
  schedules side by side, drive before/after, minutes saved, day-end change,
  "moved" badges; Apply retimes + re-pushes calendar events + notifies the
  tech + audits `AI_OPTIMIZE_APPLIED`; Cancel walks away. In-progress jobs are
  never touched. Applying the retimed plan clears impossible back-to-backs.
- **Anomaly nudges** — quiet amber strip: unassigned jobs aging past 48h,
  overbooked techs. Advisory only.
- D3 gap closed en route: same-tech **double-booking** hops now flagged
  ("overlap" status) even without coordinates.
- Engine drive times ride the D3 geo service (routed when Google Maps is
  connected, labeled estimates otherwise). Built-in optimizer = zero marginal
  cost; the premium Route Optimization API remains a future opt-in.
Verified: 89 unit tests (scoring order, infeasibility, slot math, emergency
ranking, 2-opt improvement + retiming, overlap detection) + 16-check
Playwright e2e (suggestion + runner-up render, dismiss/accept audits, full
accept pipeline incl. SMS attempt, optimize diff → apply → impossible hop
cleared → tech notified, aging-job nudge).

### Phase D5 — FSM coexistence (when a prospect needs it)
Live Jobber sync (import clients/jobs, webhook near-live updates) first;
ServiceTitan migration tooling when a real ST shop is at the table.

---

## 4. Risks & mitigations

- **SMS compliance (A2P 10DLC)** — US SMS requires campaign registration;
  transactional service messages are the easy category. Bake opt-out handling in.
- **Calendar sync loops** — two-way sync must tag app-owned events and ignore
  echoes; ICS-first strategy avoids the problem for v1.
- **ServiceTitan partner approval lead time** — start the portal application
  early if an ST-shop prospect appears; don't block roadmap on it.
- **Routing cost creep** — default to self-hosted VROOM; meter and pass through
  any Google optimizer usage at cost.
- **Trust in AI suggestions** — transparent score breakdown + diff-style
  previews + never auto-apply. Suggestion quality is auditable from day one.

## 5. Sources

- ServiceTitan developer portal & access model: developer.servicetitan.io
  (Getting Access, Environments, FAQs); help.servicetitan.com (API dev portal V2)
- Jobber developer center: developer.getjobber.com (GraphQL API, OAuth 2.0 app
  authorization, webhooks)
- Google Route Optimization API: developers.google.com/maps/documentation/route-optimization
  (overview, usage & billing, cost model); Routes API usage & billing
- Apple calendar integration reality (no public REST API; CalDAV via
  app-specific passwords; EventKit on-device): developer.apple.com (CalDAV,
  EventKit, forums), nylas/aurinko/onecal CalDAV guides
