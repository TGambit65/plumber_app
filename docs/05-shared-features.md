# 05 – Shared Features (All Roles)

Features available to every account type — tech, sales/PM, office, and admin/owner — with visibility scoped by the permission matrix (doc 02).

## 1. Company knowledge base & SOP search

Both primary user types must be able to search company information and SOPs from anywhere in the app.

- **Content types**: SOPs (step-by-step procedures with photos/video), policies (warranty terms, callback policy, discount rules), equipment references (manuals, spec sheets, venting/wiring diagrams tied to equipment models), code references, price/warranty cheat sheets, HR basics (holidays, benefits contacts), emergency procedures.
- **Search-first UX**: global search bar in both mobile and desktop apps; full-text + semantic search ("water heater relief valve keeps tripping" should surface the T&P troubleshooting SOP, not require exact keywords). Results filtered by role where content is restricted.
- **Field-ready**: SOPs cached offline (techs need them in basements); readable in dark mode; step checklists can be launched as a job checklist.
- **Contextual surfacing**: when a job or asset references an equipment model, its manuals/SOPs appear on the job screen; guided-troubleshooting entries attach to equipment models (knowledge capture from senior techs — the "silver tsunami" mitigation).
- **Authoring & governance**: admins approve; office staff draft; techs and sales can suggest edits or record a voice note that AI drafts into an SOP for review. Version history, review dates, and "verified current" badges.
- **AI answers with citations**: ask a question in natural language, get an answer synthesized from the knowledge base with links to the source SOPs (never uncited).

## 2. Unified communications

- Per-customer timeline visible to all roles with access: calls (recorded/transcribed), SMS, email, estimate views, jobs, payments, reviews.
- Internal notes and @mentions on any record (job, lead, customer, project) — replaces the "call the office" loop.
- Team chat is out of scope (Slack et al. exist); deep-link notifications instead.

## 3. Notifications

- Role-appropriate push/SMS/email: techs (assignments, schedule changes, part-request updates), sales (hot leads, quote engagement, SLA breaches, follow-ups due), office (unassigned jobs, failed payments, form exceptions), admins (approvals pending, integration failures, daily digest).
- Per-user notification preferences with sane defaults; quiet hours.

## 4. Global search

One search bar over customers, properties, jobs, estimates, invoices, parts, and knowledge base — scoped by permissions. Search by phone number fragment, address, model/serial, invoice #, part #.

## 5. Customer & property core (shared data model)

- **Customer** (person or company) ↔ **Properties/Locations** (many-to-many; property managers and GCs are first-class) ↔ **Equipment/Assets** at properties ↔ **Jobs/Projects** at properties.
- Identity hygiene: dedupe by external CRM ID → email → E.164 phone → fuzzy name+address (see doc 06); merge tooling for office/admin.

## 6. Memberships / service agreements

Shared visibility of membership status (drives dispatch priority, pricing, and renewal selling). Full membership management is a V2 module but the data model reserves it from day one.

## 7. Security & compliance baseline

- SSO-ready auth (email+password, Google/Apple, later SAML/OIDC for larger shops); biometric unlock on mobile; device revocation.
- Tenant isolation (single-tenant-per-company data scoping), encrypted tokens/secrets, full audit log of sensitive actions.
- PCI scope minimized via payment-processor tokenization; photo/document retention policy configurable (default 7–10 years).
