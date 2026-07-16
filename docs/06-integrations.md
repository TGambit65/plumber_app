# 06 – Integrations: CRM, Inventory, Suppliers, Accounting

Requirement: connect to **any number of CRM platforms**, integrate with **inventory/parts management**, and sync with accounting.

## 1. CRM integration strategy

### Recommendation: hybrid — native connectors for the top 1–2 CRMs + a unified integration layer for the long tail

1. **Native connectors for HubSpot first, Salesforce later.** HubSpot's API is free on all tiers, developer-friendly, and has the best activity-logging surface (timeline events). Salesforce is where larger commercial buyers appear — note API access requires Enterprise edition or an AppExchange ISV partner token for Professional.
2. **Nango (or similar per-connection-priced platform) for the long tail** — Zoho, Pipedrive, Monday, Close, Copper, Zendesk Sell, Dynamics 365. Nango is open source, ~$50/mo + $1/connection, provides OAuth token management, webhook ingestion, cached incremental syncs, and per-API templates — without forcing a lowest-common-denominator data model. Self-hostable escape hatch.
3. **Own the canonical domain model** (Customer, Property, Lead, Job/Opportunity, Activity, Invoice) and map each connector into it. Never adopt a vendor's common model as the internal schema — connectors can then be swapped or promoted to native without migration.

### Why not a fully unified API (Merge/Apideck/Unified.to)?

- Cost scales painfully: Merge free (3 accounts) → $650/mo (10) → $65/account (~$39K/mo at 600 accounts); Apideck from $599/mo; Unified.to from $750/mo. Heavy fixed costs pre-revenue — though **Merge's free tier is a legitimate prototyping path**.
- Lowest-common-denominator models handle reads well but get awkward for rich writes (job-status activities, custom objects) — you end up in passthrough mode anyway.

### Why not fully native?

~40–80 engineering hours per production-grade connector, ~$16K/yr each all-in with maintenance. Five native connectors ≈ $80K/yr of undifferentiated auth/pagination/rate-limit plumbing.

### Vendor comparison

| Vendor | Entry price | Pricing driver | Notes |
|---|---|---|---|
| **Nango** ✅ | Free (10 conns) → $50/mo + $1/conn | Per connection | Open source, 400+ APIs, you control mapping |
| Merge.dev | Free (3 accounts) → $650/mo | Per linked account | Best docs/model; expensive at scale; good POC tier |
| Unified.to | $750/mo (750k calls) | Per API call | 57 CRM connectors; real-time proxy; chatty syncs cost |
| Apideck | $599/mo (25 consumers) | Per consumer | Real-time proxy + webhooks |
| Paragon | Custom (~mid-5-figures/yr) | Per connected tenant | Embedded iPaaS; overkill pre-PMF |

### Sync architecture (implement once, reuse per provider)

- **Webhook-first ingestion**: single ingress per provider → verify HMAC signature → 200 immediately + enqueue → worker fetches full entity (most webhooks are ID-only) → canonical upsert with idempotency keys → DLQ + replay.
- **Cursor-based incremental polling fallback** (modified-since) where webhooks are absent; **nightly reconciliation sweep** for deletes/missed events.
- **Identity map** table (`provider, provider_object_id ↔ internal_id` per tenant); dedupe precedence: external ID → normalized email → E.164 phone → fuzzy name+address. Never rely on email alone (shared landlord/office emails are common in trades).
- **Field-of-record policy per attribute** to prevent sync ping-pong (e.g., phone: plumber_app wins after first job; lifecycle stage: CRM wins); echo suppression via origin tagging.
- **OAuth token vault**: encrypted at rest, refresh-rotation handling (QuickBooks rotates refresh tokens on every use), refresh mutex per connection, proactive "reconnect" prompts before expiry.
- **Integration marketplace UX**: in-app directory → guided OAuth connect → field-mapping screen with defaults (pipeline stage ↔ job status) → health dashboard (last sync, errors, reconnect CTA) → per-integration activity log.

### CRM data contract

Inbound: new leads / closed-won deals → plumber_app lead or job draft (carry source, stage, value, service address); contact/company upsert. Outbound: job lifecycle events as CRM activities (+ configurable stage transitions), estimate amounts/status onto deals, invoice/payment summaries as activities (links, not blobs, for photos/signatures). CRM is system of record for pre-sale pipeline only.

## 2. Inventory & parts management

### Feature bar (from ServiceTitan, the category ceiling; Housecall Pro and Jobber have essentially no native inventory — a differentiation opportunity)

- **Item catalog = price book**: part number, description, multi-vendor supplier SKUs, cost, markup/flat-rate price, GL mapping, image, category. Single source for both stock and invoice line items.
- **Locations**: warehouse(s) + **each truck as a stock location**; transfers (warehouse→truck replenishment), adjustments, cycle counts; serialized + bin tracking later.
- **Consumption**: materials logged on the job (mobile, offline-capable) auto-decrement truck stock.
- **Replenishment**: min/max reorder points per location → suggested/auto POs grouped by preferred supplier; PO lifecycle (draft → sent → partially received → received → billed); receiving updates quantity-on-hand and landed cost.
- **Barcode/QR scanning** via phone camera (no dedicated hardware); UPC lookup.
- **Job costing**: actual material cost per job feeding margin reporting and accounting sync.

### Supplier connectivity (BD-gated, not self-serve — plan accordingly)

| Supplier | Access | Plan |
|---|---|---|
| **Ferguson** | PunchOut catalogs (cXML, customer-specific pricing, real-time availability); direct procure-to-pay integrations; no public self-serve REST API | Priority partnership target — proven willingness (ServiceTitan is their preferred provider; Ferguson Ventures funded Ply) |
| **Winsupply** | Full procure-to-pay per participating *local company*; no public API | Model connectivity per-branch, not per-brand |
| **SupplyHouse.com** | No public API or punchout found | CSV/order-email import fallback; revisit |

Architecture: (1) **catalog/price-file import (CSV) as the universal fallback**, (2) cXML punchout round-trip via a punchout gateway (TradeCentric etc.) rather than hand-rolled, (3) native REST where partnerships mature.

## 3. Accounting sync

**QuickBooks Online first** — the SMB-trades default. Xero fast-follow (needed for Canada/UK/ANZ).

- **System-of-record matrix (resolves every conflict question)**: accounting = financials; plumber_app = jobs & stock; CRM = pre-sale pipeline. Encode explicitly per entity.
- Flows: invoice → QBO Invoice (lines mapped to Items/Accounts); payments bidirectional (bank-feed payments come back); PO → Bill on receipt; customer upsert through the same identity map.
- QBO API facts to design around: OAuth2 with **refresh tokens that rotate on every use** (store atomically; losing one = customer re-auth); 500 req/min per realm; webhooks are ID-only (re-fetch entity); CDC endpoint for catch-up; **inventory tracking requires QBO Plus/Advanced** and QBO is single-location FIFO — **it cannot represent truck stock**, so plumber_app owns stock and pushes only invoices/POs/bills/items.
- Xero: 60 calls/min and 5,000/day per tenant — forces batched, delta-based sync design.

## 4. Other integrations (roadmap order)

1. Payments processor (Stripe or trades-focused; tap-to-pay, financing partner e.g. Wisetack) — MVP, not optional.
2. Google Local Services Ads + Angi lead ingestion — MVP-adjacent (feeds the lead inbox).
3. Twilio (or similar) for SMS/voice/tracking numbers — MVP.
4. QuickBooks Online — Phase 2.
5. HubSpot native + Nango long-tail CRMs — Phase 2.
6. Ferguson punchout, Winsupply P2P — Phase 3 (BD-dependent).
7. Zapier/Make + public API + webhooks out — Phase 3 (long-tail escape valve and platform play).

## Sources

Merge/Nango/Apideck/Paragon/Unified.to pricing pages · Truto 2026 unified-API pricing breakdown · Salesforce edition API-access docs · ServiceTitan inventory-module docs & Ferguson/Winsupply partner pages · Ferguson eProcurement/punchout pages · Ply (+$8.5M Ferguson Ventures round) · Housecall Pro API & Ply integration docs · Jobber developer center · TradeCentric punchout explainer · Intuit QBO API/webhook docs · Xero rate-limit docs. Confidence flags: Paragon pricing is sales-gated (reported figure); SupplyHouse "no API" is absence-of-evidence — confirm with their partnerships team; re-verify Salesforce Professional-edition API status at build time.
