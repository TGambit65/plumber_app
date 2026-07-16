# 02 – User Roles & Permissions

Four account types. Roles are implemented as permission bundles on top of a granular permission system, so custom roles can be added later without schema changes.

## Role summaries

### Field Technician
Mobile-first (phone). Sees own schedule and assigned jobs, full customer/property/equipment history for those jobs, price book, own truck stock, SOP/knowledge base, own timesheets and own commission/spiff earnings. Creates estimates, invoices, photos, forms, and tech-generated leads. Cannot see other techs' earnings, company financials, or marketing spend.

### Salesperson / Project Manager
Mobile + desktop. Owns leads, pipeline, estimates/proposals, follow-up sequences, and (for PM work) projects: milestones, change orders, budgets vs. actuals, subcontractors, permits/inspections. Sees own commission dashboard. Sees job costing for own projects. Cannot manage users, edit the price book (proposes changes for approval), or see company-wide financials beyond own book of business.

### Office Worker (Dispatcher / CSR)
Desktop-first. Books jobs, manages the dispatch board and all schedules, runs the communications hub (calls/SMS/email), manages customer records, invoicing, payments, and collections. Sees all jobs and customers. Cannot change pricing rules, commission rules, users, or integrations; no access to profitability dashboards unless granted.

### Admin / Owner
Everything, plus: user/role management, price book and pricing-rule control, commission rule engine, integration management (CRM/inventory/accounting connections), company settings (business units, tax, memberships), audit log, and full financial/BI dashboards. Supports more than one person (e.g., owner + GM).

## Permission matrix

Legend: ✔ full · O own-records only · R read-only · ✖ none

| Capability | Tech | Sales/PM | Office | Admin/Owner |
|---|---|---|---|---|
| **Scheduling & dispatch** |
| View own schedule/jobs | ✔ | ✔ | ✔ | ✔ |
| View all schedules / dispatch board | ✖ | R | ✔ | ✔ |
| Assign/reassign jobs | ✖ | O (own projects) | ✔ | ✔ |
| **Customers & properties** |
| View customer/property/equipment history | O (assigned) | ✔ | ✔ | ✔ |
| Create/edit customers | ✖ | ✔ | ✔ | ✔ |
| Merge/delete customers | ✖ | ✖ | ✔ | ✔ |
| **Leads & sales** |
| Create leads (incl. tech lead-flag) | ✔ | ✔ | ✔ | ✔ |
| Own/work pipeline, follow-up sequences | ✖ | ✔ | R | ✔ |
| Build/send estimates & proposals | O (from price book) | ✔ | ✔ | ✔ |
| Discount beyond threshold | ✖ | needs approval | ✖ | ✔ |
| **Projects (PM)** |
| Milestones, change orders, budgets, subs, permits | ✖ | ✔ | R | ✔ |
| **Field work** |
| Job status, photos, forms, signatures, voice notes | ✔ | ✔ | R | ✔ |
| Invoice & take payment | ✔ | ✔ | ✔ | ✔ |
| Refunds | ✖ | ✖ | needs approval | ✔ |
| **Inventory** |
| View/consume own truck stock, request parts | ✔ | R | ✔ | ✔ |
| Purchase orders, receiving, transfers | request only | O (own projects) | ✔ | ✔ |
| Edit item catalog / price book | ✖ | propose | propose | ✔ |
| **Knowledge base** |
| Search/view company info & SOPs | ✔ | ✔ | ✔ | ✔ |
| Author/approve SOPs | suggest | suggest | draft | ✔ |
| **Money & reporting** |
| Own commission/spiff dashboard | ✔ (own) | ✔ (own) | ✖ | ✔ (all) |
| Company dashboards, job costing (all), AR | ✖ | O (own projects) | AR only | ✔ |
| Commission rules, payroll export | ✖ | ✖ | ✖ | ✔ |
| **Administration** |
| User management, roles | ✖ | ✖ | ✖ | ✔ |
| Integrations (CRM, accounting, inventory) | ✖ | ✖ | ✖ | ✔ |
| Audit log | ✖ | ✖ | ✖ | ✔ |

## Design notes

- **Granular permissions, bundled roles.** Store permissions as individual grants (`estimates.create`, `pricebook.edit`, …) with the four roles as default bundles. Owners will inevitably ask for "a dispatcher who can also edit the price book."
- **Own-records scoping** is a first-class concept (`scope: own | team | all`) — most Tech and Sales/PM permissions are scoped, not binary.
- **Approval workflows instead of hard walls** where money is involved: discounts beyond threshold, refunds, price-book changes, and negative adjustments route to an approver rather than being flatly denied. Keeps the field moving without giving away the till.
- **Every sensitive action is audited** (who, what, when, before/after) — required for commission disputes, refunds, and price changes.
- **Tech privacy commitments in the product**: GPS tracking limited to work hours, techs can view their own location history, and the policy is shown in-app. (Timeero 2026: transparency moves tracking comfort from 52% → 85%; self-access → 88%.)
- **Multi-business-unit ready**: role grants attach to a business unit (e.g., Service vs. Construction divisions) to support commercial/residential splits later.
