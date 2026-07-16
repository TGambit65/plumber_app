# 04 – Field Technician Requirements

Design north star: **"Works in the basement, syncs in the driveway."** The tech app must be offline-first, Android-first, voice-native, and ruthlessly low-tap. The competitive bar is embarrassingly low — ServiceTitan Mobile 2.3★, Workiz 2.4★, Housecall Pro Android 3.2★ — while Jobber's 4.8★ proves techs reward simplicity.

## 1. Dispatch & scheduling — Core

- Job assignment with push notification and **full context before accepting**: job type, priority, customer, address, notes, required skills, likely parts.
- Today's route in order with drive times; deep-link navigation to Google/Apple Maps (don't rebuild nav).
- **One-tap status buttons** (Dispatched / En Route / Working / Done) that drive both the office dispatch board and automatic customer texts ("On my way" with live ETA link). Flag jobs missing a mobile number (SMS to landlines fails).
- **Tech-trusted GPS**: work-hours only, tech can see their own breadcrumb, policy shown in-app. Positioned as dispute protection — 79% of field workers have been in disputes where GPS records would have helped them. (Timeero 2026: transparent rollout = 85% comfort vs. 52% when imposed.)

## 2. Job details: customer, property, equipment — Core

- **Customer history at the door**: prior visits, invoices, estimates, membership status, outstanding balance.
- **Property memory** (differentiator): persistent location profile — gate/lockbox codes, dog on premises, parking, shutoff-valve locations, panel/heater photos from prior visits. Lives on the property record, not the job.
- **Equipment/asset records**: scan to capture model + serial; per-asset service history ("this water heater was flushed 14 months ago"). Asset-centric multi-property support for commercial accounts.
- **AI pre-job brief**: 30-second audio/text summary on the drive over (history, equipment, last tech's notes, likely parts).

## 3. Photos & video — Core (the evidence engine)

- Capture in-app → auto-attached to job, timestamped, GPS-tagged (legal guidance: contemporaneous, location-identifiable, organized by project).
- **Job-type photo checklists**: (1) before/pre-existing conditions, (2) before cover-up (anything buried behind walls/underground), (3) progress, (4) problems found (wide + close-up), (5) after, matching the before angles.
- Annotation (arrows, circles, text); auto-composed before/after pairs for the customer email and (with permission) marketing.
- **Background, resumable, compressed uploads**; WiFi-only option; never block job completion on media upload; no duplication bugs. Retention 7–10 years (defect statutes).

## 4. Forms, checklists, safety — Core

- Digital forms attached to job types: safety/risk assessment, inspection checklists, permit forms, commissioning.
- Conditional/required forms: **block "job complete" until required forms + photos exist** — quality enforcement without office nagging.
- Keep forms short; auto-fill from job status, GPS, timestamps, and equipment scans. (63% of techs say their current apps aren't user-friendly.)

## 5. Time tracking — Core

- Job-status-driven timesheets (dispatched/arrived/completed auto-generate entries) instead of separate manual clock-in; cost codes for commercial.
- **Clock-in must work offline, always.**

## 6. Parts & truck stock — Core

- **Truck-as-warehouse**: what's on my truck, quantities, bin locations; using a part on an invoice auto-decrements truck stock.
- "Which truck/warehouse/supplier has this part?" search; one-tap **part request** to the office (replaces the phone call).
- Min/max replenishment lists per truck; barcode/QR scanning via phone camera for receiving and counts. (Details in doc 06.)

## 7. Estimates, invoicing, payments — Core

- **Flat-rate price book in the app** with photos and customer-facing presentation; good-better-best options first-class (ServiceTitan claims +20% average ticket from field selling).
- Target: **estimate from price book in under 10 taps** (the "42 taps" ServiceTitan complaint is the anti-goal).
- Estimate → e-sign approval → invoice → payment in one on-site flow; financing application from the field for big-ticket work.
- Payments: tap-to-pay card, ACH, check/cash logging, saved cards; payment SDK updates must never interrupt an in-progress transaction (the Workiz failure mode); degraded offline path = store-and-forward capture or payment link. Fast payouts matter to owners.

## 8. Job sign-off & closeout — Core differentiator

**The two-minute closeout**: one guided sequence — required photos → voice note → AI-drafted summary + invoice lines → customer signature → payment → review request. Attacks the #1 tech complaint (paperwork) head-on.

## 9. Offline-first — Core, non-negotiable

Plumbing reality: basements, mechanical rooms, crawlspaces, rural routes — no signal at the exact moment work is documented.

- **Local-first data store**; all writes queue (notes, photos, forms, signatures, time, status, invoices) and sync opportunistically with visible sync-state UI (nothing silently lost).
- Proactive morning sync of the full day's route + trailing history. Benchmarks: Housecall Pro caches ~30 days, ServiceTitan ~14, Jobber ~7 — beat them.
- Conflict resolution: automatic last-write-wins with notification (not manual review queues).
- Offline must cover: job/customer/equipment history, photo capture, forms, signatures, estimates from cached price book, invoice creation, store-and-forward payments, clock-in/out.

## 10. Voice & AI — Core

- Dictation everywhere free text appears; AI turns a 30-second rambled voice memo into structured job notes, recommended repairs, and a customer-readable summary.
- Guided troubleshooting / knowledge capture tied to equipment models (mitigates the "silver tsunami" of retiring senior techs; 71% of field-service orgs are investing here).

## UX & performance budget

- Bottom-of-screen thumb-zone primary actions; tap targets ≥48dp (larger for status buttons); high contrast for sunlight; dark mode for crawlspaces; swipe-based status changes; minimal typing (pickers, chips, voice).
- **Android-first performance**: <2s cold start on a 4-year-old midrange Android; low memory/battery footprint (GPS + camera all day).
- Biometric unlock; never force daily re-login (top ServiceTitan gripe).
- Cross-cutting anti-goals from competitor complaints: instability at payment/clock-in/completion moments; tap-count bloat; Android neglect; sync losses; login friction; blocking media uploads; imposed surveillance.

## Later / V2

Route optimization across the fleet; multi-tech crew workflows; AR measurement/annotation; Spanish localization (ServiceTitan has it; do it early if hiring reality demands).

## Sources

Google Play/App Store listings & reviews (ServiceTitan Mobile 2.3★, Workiz 2.4★, Jobber 4.8★, Housecall Pro Android ~3.2★) · Timeero 2026 GPS-trust survey · TSIA State of Field Services 2026 · Fieldman tech-usability stat · Gogh Solutions "why techs hate FSM software" · CompanyCam & Remato photo-documentation guidance · fieldserviceguide.com offline comparisons · Housecall Pro notification/offline docs · ServiceTitan Field Pro/Atlas pages · BuildOps field-app resources · eTurns/QR Inventory truck-stock patterns · Smashing Magazine one-handed design.
