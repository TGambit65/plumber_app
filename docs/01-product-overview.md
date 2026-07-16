# 01 – Product Overview

*Research date: July 2026. Sources are listed at the bottom of each doc.*

## The problem

Plumbing companies run on two badly connected worlds. In the office, leads arrive from a dozen sources (Google Local Services Ads, Angi, web forms, phone) and die in inboxes — 62% of calls to home-service businesses go unanswered, 86% of callers won't leave a voicemail, and estimates that get no follow-up quietly rot even though 80% of deals need 8–12 touches to close. In the field, techs fight software that crashes during payment collection, demands "42 taps" to email an estimate, and stops working the moment they descend into a basement with no signal.

The market splits into two unsatisfying tiers:

- **SMB tools** (Jobber $39–249/mo, Housecall Pro $59–299/mo, Workiz): easy to adopt, but thin on sales features, no real project management, weak commission tracking, and they cap out around 15 techs. Key sales features (pipelines, follow-up automation, e-sign) are plan-gated.
- **Enterprise platforms** (ServiceTitan $245–500+/tech/mo + $5–50K implementation; BuildOps, commercial-only): powerful but expensive, with 3–12 month onboarding, 12-month contracts, and documented complaints about rigidity and complexity. Even ServiceTitan is weak at multi-day project work (no project phases, change-order budgeting).

## The opportunity (validated gaps)

1. **The mid-market void** — nothing serious between "Jobber caps out" and "ServiceTitan costs $50–70K in year one." A transparent per-seat price with days-not-months onboarding attacks both flanks.
2. **Residential service + commercial projects in one tool** — mixed shops (very common in plumbing) currently run two systems or spreadsheets. Residential platforms lack change orders/budgets; BuildOps is enterprise-priced and commercial-only. This is the largest unoccupied feature space in the category.
3. **Follow-up automation included, not gated** — incumbents sell it as expensive add-ons (ServiceTitan Marketing Pro $200–600/mo) or gate it to top plans (Housecall Pro MAX).
4. **Commission transparency** — universally weak across the category; a real-time "what I've earned" screen is a proven motivator and a differentiator.
5. **Permits & inspections** — whitespace across the entire category; contractors bolt on PermitFlow or spreadsheets.
6. **Offline-first with first-class Android** — Housecall Pro Android sits at ~3.2★, Service Fusion at 2.8★, ServiceTitan Mobile at 2.3★, Workiz at 2.4★. Field devices skew Android. Jobber's 4.8★ proves techs reward simplicity.
7. **Lead-source auto-attribution** — manual CSR tagging mis-attributes 30–50% of leads, wrecking marketing-ROI reporting.

## Key statistics driving the design

| Fact | Implication |
|---|---|
| Responding to a lead in 5 minutes vs. 30 = ~100x more likely to connect, 21x to qualify | Speed-to-lead automation is the #1 revenue feature |
| 35–45% of calls arrive after hours | After-hours auto-response / missed-call text-back |
| Presenting 4+ options closes 52% vs. 42% for 1–3 options; only 10% of contractors do it | Good-better-best proposals as the default flow |
| Financing lifts close rates 38% → 49%; financed jobs average 4.5x larger; monthly-payment framing doubles financed sales | Monthly-payment-first proposals with embedded financing |
| Optimal follow-up: ~7 messages over 7 days (5 SMS + 2 email) starting within 48 hours | Default-on unsold-estimate sequences |
| 63% of field techs say their apps are not user-friendly | Thumb-zone UI, minimal typing, voice-native input |
| 82.6% of trades workers accept GPS tracking *when introduced transparently* (vs. 52.2% when imposed) | Work-hours-only, tech-visible tracking policy |

## Personas

### 1. Field technician ("Tech")
On the truck all day, often in basements/crawlspaces with no signal, gloved hands, wet screens, older Android phone. Hates paperwork and re-logins. Needs: today's route, full job context before knocking, fast photo capture, estimates from a price book in under 10 taps, payment that never fails in front of the customer, and a two-minute closeout. Can also *generate leads* (spots a failing water heater) — needs a one-tap handoff to sales with spiff attribution.

### 2. Salesperson / Project Manager ("Sales/PM")
Lives in the pipeline. Needs: every lead from every source in one queue with SLA timers, automated follow-up on unsold estimates, good-better-best proposal builder with e-sign and financing, engagement signals ("customer opened your quote 3x today"), and — for larger jobs — milestones, change orders, budget vs. actuals, subcontractors, and permit/inspection tracking. Wants a live view of commission earned.

### 3. Office worker ("Dispatcher/CSR")
Answers phones, books jobs, dispatches techs, chases paperwork, runs invoicing/collections. Needs: booking flow with customer/property lookup, drag-and-drop dispatch board, live tech status, messaging hub (calls/SMS/email in one timeline), and exception queues (unsigned forms, unpaid invoices, stalled estimates).

### 4. Admin / Owner
Accountable for margin. Needs: company-wide dashboards (close rate, average ticket, revenue per lead source, tech utilization, AR aging), pricing/price-book control, user and permission management, commission rule configuration, integration management, and audit trails.

## Positioning

"The sales-first, field-tough platform for plumbing companies that do both service calls and real projects — at a published price, live in days."

## Sources

See per-document source lists in docs 03, 04, and 06. Competitive figures: RivetOps, OneCrew, FieldCamp, Capterra/G2 reviews, Google Play/App Store ratings (July 2026). Statistics: MIT/InsideSales lead-response research, CallJolt missed-call statistics, ACHR News close-rate survey, Wisetack financing report, Hatch follow-up-cadence analysis (163k campaigns), Fieldman tech-usability stat, Timeero 2026 GPS-trust survey.
