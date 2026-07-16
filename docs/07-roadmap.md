# 07 – Roadmap & Open Questions

Sequencing principle: ship the loop that makes money first (lead → estimate → job → invoice → payment), make it work offline, then widen.

## Phase 1 — MVP: the revenue loop (core product)

**Goal: a small shop can run its day entirely in plumber_app.**

- Accounts & roles: all four account types, permission bundles, audit log basics.
- Customer/property/equipment core with global search.
- Scheduling & dispatch: booking flow, dispatch board (office), tech mobile app with status buttons + automatic customer texts.
- Tech field app (offline-first from day one — retrofitting offline is a rewrite): job details, property memory, photo capture with checklists, forms, signatures, job-status timesheets.
- Price book + good-better-best estimates + e-sign + invoicing + payments (tap-to-pay, financing partner).
- Two-minute closeout flow; review requests.
- Lead inbox with manual + web-form + missed-call-text-back capture; basic pipeline; **default-on 7-day follow-up sequences**.
- SMS/voice infrastructure (Twilio or similar); per-customer communication timeline.
- Knowledge base with search, offline SOP cache.

## Phase 2 — Sales depth + money plumbing

- Lead-source auto-attribution (tracking numbers, UTM); Google LSA + Angi ingestion; speed-to-lead SLA timers and escalation.
- Proposal engagement signals; aged-estimate rehash queues; AI-drafted follow-up replies.
- Commission rules engine + real-time earnings dashboards + payroll export.
- Tech lead-flag → sales handoff with spiff attribution.
- Inventory: item catalog, truck stock, consumption decrement, part requests, min/max replenishment, POs, barcode scanning.
- QuickBooks Online sync; HubSpot native connector; Nango-based long-tail CRM connections.
- Sales cockpit home screen; reporting/scorecards v1.
- Voice-native notes + AI job summaries; AI pre-job brief.

## Phase 3 — Projects & platform

- Project module: milestones/phases, progress billing, change orders with e-sign, budget vs. actuals, subcontractors, daily logs, punch lists, customer/GC portal.
- **Permits & inspections workflow** (category whitespace).
- Commercial mode: bid board, GC/property-manager accounts, cost codes.
- Supplier integrations: Ferguson punchout, Winsupply P2P (BD-dependent); punchout gateway.
- Salesforce native connector; Xero; Zapier + public API + outbound webhooks.
- Memberships/service agreements module; guided troubleshooting knowledge capture.

## Phase 4 — Scale & intelligence

- Route optimization; capacity planning; multi-location/business-unit rollups.
- AI call answering & booking; marketing campaigns; sales-coaching AI.
- Benchmarking dashboards; WIP/job-cost accounting depth; SAML/OIDC SSO.

## Success metrics (tie to the research)

| Metric | Target rationale |
|---|---|
| Median lead response time | < 5 min (21x qualification odds) |
| Estimates with 3+ options | > 50% (vs. industry 10%) |
| Unsold estimates entering follow-up automatically | 100% (default-on) |
| Estimate creation taps (field) | < 10 (vs. "42 taps") |
| Job closeout time | < 2 min |
| Android app rating | ≥ 4.5★ (category leader is the wedge) |
| Onboarding time to first live job | Days, not months |

## Open questions (decide before build)

1. **Tech stack**: mobile framework choice is driven by offline-first + camera + payments hardware — evaluate React Native/Expo vs. Flutter vs. native, with a local-first sync layer (e.g., SQLite + sync engine such as PowerSync/ElectricSQL/WatermelonDB or custom).
2. **Payments partner**: Stripe (fast to ship, Tap to Pay) vs. trades-focused processors; financing partner (Wisetack is the incumbent pattern).
3. **Pricing model**: published per-seat (counter-positioning vs. ServiceTitan) — validate price points against Jobber Grow ($249/mo) and Housecall Pro MAX (~$299/mo) ceilings.
4. **Multi-tenant architecture**: single DB row-level tenancy vs. schema-per-tenant; affects everything downstream.
5. **CRM scope for MVP**: is any CRM sync needed in Phase 1, or is the internal pipeline enough until Phase 2? (Research suggests internal-first; most target shops have no CRM.)
6. **Serialized inventory & bin tracking**: Phase 2 or Phase 3?
7. **Spanish localization timing** for the tech app.
8. **Team chat**: confirmed out of scope (integrate, don't build)?
