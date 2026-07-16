# 03 – Salesperson / Project Manager Requirements

The sales/PM experience is the product's spearhead: incumbents either lack these features or gate them behind expensive add-ons. Everything in "Core" below ships in the base SKU.

## 1. Lead capture & unified lead inbox — Core

- Auto-ingest leads from every source into one queue: Google Local Services Ads, Angi, website forms, phone calls (recording + transcription), SMS, Facebook, referrals, and **technician-generated leads** (tech flags an opportunity on a service call → pipeline record → assigned salesperson → spiff attribution to the tech).
- **Automatic lead-source attribution** via tracking numbers and UTM/form capture. Manual CSR tagging mis-attributes 30–50% of leads; auto-attribution makes per-source ROI reporting trustworthy.
- **Speed-to-lead automation**: auto-text/auto-call new web leads within seconds; missed-call text-back; after-hours auto-responder. (5-minute response = ~21x qualification odds; 62% of home-service calls go unanswered; 35–45% arrive after hours.)
- Lead SLA timers with escalation to the next rep; push notifications for hot leads.

## 2. Sales pipeline — Core

- Kanban pipeline with plumbing defaults (New → Contacted → Estimate Scheduled → Estimate Sent → Follow-up → Won/Lost), customizable per workflow.
- Residential-service and **commercial-bid** modes (bid board: invited-to-bid → takeoff → submitted → awarded; GC/property-manager accounts; bid due dates).
- Per-rep views, aging alerts ("estimate sent 5 days, no touch"), required lost-reason codes.
- **Second-chance queue**: unbooked calls and aged unsold estimates (30/60/90-day rehash) resurfaced for outbound.

## 3. Quoting / estimating — Core

- **Good-better-best multi-option proposals as the default flow** (4+ options closes 52% vs. 42%; ServiceTitan credits it with 15–25% higher tickets). Templates per job type.
- Price book / flat-rate catalog with photos, task bundles, markup rules, supplier cost sync (see doc 06).
- Customer-facing presentation mode (tablet/phone), photo/video attachments, optional line items/add-ons.
- **E-signature on every proposal in the base plan** (competitors gate this), online self-serve approval, deposit collection at approval.
- **Monthly-payment-first pricing**: every option shows "$/mo with financing" by default; financing prequal link auto-embedded above a configurable price threshold. (Financing lifts close 38%→49%, financed jobs average 4.5x larger, yet only 37% of contractors mention it consistently. Wisetack-style embedded partner.)
- Proposal engagement intelligence: viewed/dwell-time signals → "customer opened your quote 3 times today — call now."

## 4. Follow-up automation — Core (biggest ROI)

- **Default-on automated sequences for unsold estimates**, pre-loaded with the statistically optimal cadence: ~7 messages over 7 days (5 SMS + 2 email) starting within 48 hours. (Hatch 163k-campaign analysis: 60–90% response rates; 80% of deals need 8–12 touches.)
- Auto-stop on reply or booking; quiet hours; AI-drafted replies with human approval; per-rep follow-up-compliance tracking.
- Aged-estimate rehash campaigns at 30/60/90 days.

## 5. Customer communication — Core

- Two-way SMS + email from a company number, threaded per customer; templates; call tracking/recording tied to the customer record.
- Single timeline per customer: every call, text, email, estimate view, job, and payment.

## 6. Reviews & reputation — Core

- Automated post-job review request (SMS, direct Google link), throttling, response management, and **rep/tech attribution feeding scorecards** (uncommon among incumbents).

## 7. Commission & compensation — Core differentiator

- Rules engine: % of sold revenue, % of gross margin, per-item spiffs, lead-setter/closer splits, membership bonuses.
- **Real-time "what I've earned this period" dashboard** for reps and techs; approval + payroll export flow for admins. Incumbents are universally weak here; transparency kills the spreadsheet and the disputes.

## 8. Project management for larger jobs — Core differentiator

For repipes, remodels, new-construction, and commercial work — the biggest structural gap in the market (residential platforms have none of it; BuildOps is enterprise-priced commercial-only):

- **Milestones/phases** scheduled across multiple days/crews; progress (AIA-style) billing tied to milestones.
- **Change orders**: created in the field, priced from the price book, e-signed by customer/GC before work proceeds, auto-rolled into contract value and budget.
- **Budget vs. actuals / job costing**: labor hours, materials/POs, sub invoices against estimate; margin-erosion alerts; simple WIP view.
- **Subcontractor management**: assignments, COI/license tracking, sub invoices against budget.
- **Permits & inspections** (category whitespace): per-job permit checklist (jurisdiction, permit #, status, fees), inspection scheduling with reminders, photo documentation, and blocking dependencies ("can't close milestone until rough-in inspection passes").
- Punch lists, daily logs, document storage (plans/submittals), customer/GC status portal.

## 9. Reporting & scorecards — Core

- Sales leaderboard: close rate, average ticket, options-presented rate, financing-mention rate, follow-up compliance, revenue per lead source.
- Benchmarks for context: average home-services close rate ~43% (residential 45% / commercial 38%); proposal-to-close median ~25%, top quartile ~35%.

## The sales cockpit (home screen)

One mobile-first screen: follow-ups due today · hot leads (quote opened, SLA breached) · pipeline value by stage · commission earned this period.

## Later / V2

AI call answering and booking; marketing campaign builder (email/postcard); membership/service-agreement selling motions; multi-location rollups; sales-coaching AI (call scoring).

## Sources

ACHR News close-rate survey · Hatch HVAC follow-up analysis (163k campaigns) · CaseyResponse lead-response statistics (MIT/HBR/Velocify) · CallJolt missed-call statistics · Wisetack financing report · Optifai proposal-to-close benchmarks · ServiceTitan good-better-best & Second Chance Leads docs · Housecall Pro Pipeline docs · Jobber optional line items · RivetOps/FieldCamp/Projul pricing analyses · OneCrew ServiceTitan review compilation · Nerdisa/GetApp BuildOps reviews · PermitFlow (permit whitespace evidence). Full URLs in the research appendix (see repo history / project notes).
