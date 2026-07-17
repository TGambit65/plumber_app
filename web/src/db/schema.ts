// plumber_app — Drizzle schema. Money is integer cents throughout.
import {
  pgTable,
  pgEnum,
  text,
  integer,
  doublePrecision,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

const id = () =>
  text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`);

// ── Enums ────────────────────────────────────────────────────────────────────
export const roleEnum = pgEnum("role", ["TECH", "SALES_PM", "OFFICE", "ADMIN"]);
export const customerTypeEnum = pgEnum("customer_type", ["RESIDENTIAL", "COMMERCIAL"]);
export const leadSourceEnum = pgEnum("lead_source", [
  "PHONE", "WEB_FORM", "GOOGLE_LSA", "ANGI", "REFERRAL", "TECH_FLAGGED", "SMS", "OTHER",
]);
export const leadStageEnum = pgEnum("lead_stage", [
  "NEW", "CONTACTED", "ESTIMATE_SCHEDULED", "ESTIMATE_SENT", "FOLLOW_UP", "WON", "LOST",
]);
export const followUpChannelEnum = pgEnum("follow_up_channel", ["SMS", "EMAIL", "CALL"]);
export const followUpStatusEnum = pgEnum("follow_up_status", ["PENDING", "SENT", "SKIPPED"]);
export const estimateStatusEnum = pgEnum("estimate_status", [
  "DRAFT", "SENT", "VIEWED", "APPROVED", "DECLINED", "EXPIRED",
]);
export const optionTierEnum = pgEnum("option_tier", ["GOOD", "BETTER", "BEST", "CUSTOM"]);
export const jobStatusEnum = pgEnum("job_status", [
  "UNSCHEDULED", "SCHEDULED", "DISPATCHED", "EN_ROUTE", "IN_PROGRESS", "COMPLETED", "CANCELLED",
]);
export const jobPriorityEnum = pgEnum("job_priority", ["LOW", "NORMAL", "HIGH", "EMERGENCY"]);
export const photoKindEnum = pgEnum("photo_kind", ["BEFORE", "DURING", "AFTER", "PROBLEM", "COVERUP"]);
export const timeEntryKindEnum = pgEnum("time_entry_kind", ["TRAVEL", "WORK"]);
export const projectStatusEnum = pgEnum("project_status", [
  "PLANNING", "ACTIVE", "ON_HOLD", "COMPLETED", "CLOSED",
]);
export const milestoneStatusEnum = pgEnum("milestone_status", [
  "PENDING", "IN_PROGRESS", "BLOCKED", "COMPLETE",
]);
export const changeOrderStatusEnum = pgEnum("change_order_status", [
  "DRAFT", "PENDING_SIGNATURE", "APPROVED", "REJECTED",
]);
export const permitStatusEnum = pgEnum("permit_status", [
  "NOT_APPLIED", "APPLIED", "ISSUED", "INSPECTION_SCHEDULED", "PASSED", "FAILED", "CLOSED",
]);
export const costKindEnum = pgEnum("cost_kind", ["LABOR", "MATERIAL", "SUBCONTRACTOR", "OTHER"]);
export const invoiceStatusEnum = pgEnum("invoice_status", [
  "DRAFT", "SENT", "PARTIAL", "PAID", "OVERDUE", "VOID",
]);
export const paymentMethodEnum = pgEnum("payment_method", ["CARD", "ACH", "CASH", "CHECK", "FINANCING"]);
export const locationKindEnum = pgEnum("location_kind", ["WAREHOUSE", "TRUCK"]);
export const partRequestStatusEnum = pgEnum("part_request_status", [
  "OPEN", "ORDERED", "FULFILLED", "CANCELLED",
]);
export const poStatusEnum = pgEnum("po_status", ["DRAFT", "SENT", "PARTIAL", "RECEIVED", "BILLED"]);
export const commissionKindEnum = pgEnum("commission_kind", [
  "PERCENT_REVENUE", "PERCENT_MARGIN", "SPIFF",
]);
export const commissionStatusEnum = pgEnum("commission_status", ["PENDING", "APPROVED", "PAID"]);
export const kbCategoryEnum = pgEnum("kb_category", [
  "SOP", "POLICY", "EQUIPMENT", "SAFETY", "HR", "EMERGENCY",
]);
export const activityKindEnum = pgEnum("activity_kind", [
  "CALL", "SMS", "EMAIL", "NOTE", "STATUS", "SYSTEM", "ESTIMATE_VIEW", "PAYMENT", "REVIEW",
]);
export const integrationStatusEnum = pgEnum("integration_status", [
  "DISCONNECTED", "CONNECTED", "ERROR",
]);

// ── Users ────────────────────────────────────────────────────────────────────
export const users = pgTable("users", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  phone: text("phone"),
  role: roleEnum("role").notNull(),
  passwordHash: text("password_hash").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Customers, properties, equipment ────────────────────────────────────────
export const customers = pgTable("customers", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  type: customerTypeEnum("type").notNull().default("RESIDENTIAL"),
  name: text("name").notNull(),
  company: text("company"),
  email: text("email"),
  phone: text("phone"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const properties = pgTable("properties", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  customerId: text("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  label: text("label"),
  address: text("address").notNull(),
  city: text("city").notNull(),
  state: text("state").notNull(),
  zip: text("zip").notNull(),
  gateCode: text("gate_code"),
  accessNotes: text("access_notes"),
  shutoffLocation: text("shutoff_location"),
  parkingNotes: text("parking_notes"),
  petNotes: text("pet_notes"),
});

export const equipment = pgTable("equipment", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  propertyId: text("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  brand: text("brand"),
  model: text("model"),
  serial: text("serial"),
  installedAt: timestamp("installed_at", { withTimezone: true }),
  notes: text("notes"),
  /** Pack-scoped custom field values (defs live in tradePacks.config.customFields). */
  customFields: jsonb("custom_fields"),
});

export const memberships = pgTable("memberships", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  customerId: text("customer_id").notNull().unique().references(() => customers.id, { onDelete: "cascade" }),
  plan: text("plan").notNull(),
  status: text("status").notNull().default("ACTIVE"),
  renewsAt: timestamp("renews_at", { withTimezone: true }),
});

// ── Leads & follow-ups ───────────────────────────────────────────────────────
export const leads = pgTable("leads", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  source: leadSourceEnum("source").notNull().default("PHONE"),
  stage: leadStageEnum("stage").notNull().default("NEW"),
  title: text("title").notNull(),
  contactName: text("contact_name").notNull(),
  phone: text("phone"),
  email: text("email"),
  description: text("description"),
  estValueCents: integer("est_value_cents"),
  lostReason: text("lost_reason"),
  respondBy: timestamp("respond_by", { withTimezone: true }),
  firstTouchAt: timestamp("first_touch_at", { withTimezone: true }),
  lastContactAt: timestamp("last_contact_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  customerId: text("customer_id").references(() => customers.id),
  propertyId: text("property_id").references(() => properties.id),
  assignedToId: text("assigned_to_id").references(() => users.id),
  createdById: text("created_by_id").references(() => users.id),
  techFlagged: boolean("tech_flagged").notNull().default(false),
  spiffCents: integer("spiff_cents"),
});

export const followUps = pgTable("follow_ups", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  leadId: text("lead_id").references(() => leads.id, { onDelete: "cascade" }),
  estimateId: text("estimate_id").references(() => estimates.id, { onDelete: "cascade" }),
  channel: followUpChannelEnum("channel").notNull(),
  status: followUpStatusEnum("status").notNull().default("PENDING"),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  body: text("body").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
});

// ── Estimates ────────────────────────────────────────────────────────────────
export const estimates = pgTable("estimates", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  number: text("number").notNull().unique(),
  status: estimateStatusEnum("status").notNull().default("DRAFT"),
  customerId: text("customer_id").notNull().references(() => customers.id),
  propertyId: text("property_id").references(() => properties.id),
  leadId: text("lead_id").references(() => leads.id),
  jobId: text("job_id").references(() => jobs.id),
  claimId: text("claim_id").references(() => claims.id), // insurance claim linkage (core)
  createdById: text("created_by_id").notNull().references(() => users.id),
  notes: text("notes"),
  financingOffered: boolean("financing_offered").notNull().default(true),
  viewCount: integer("view_count").notNull().default(0),
  lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  signedName: text("signed_name"),
  signedAt: timestamp("signed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const estimateOptions = pgTable("estimate_options", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  estimateId: text("estimate_id").notNull().references(() => estimates.id, { onDelete: "cascade" }),
  tier: optionTierEnum("tier").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  selected: boolean("selected").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const estimateLineItems = pgTable("estimate_line_items", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  optionId: text("option_id").notNull().references(() => estimateOptions.id, { onDelete: "cascade" }),
  priceBookItemId: text("price_book_item_id").references(() => priceBookItems.id),
  description: text("description").notNull(),
  qty: doublePrecision("qty").notNull().default(1),
  unitPriceCents: integer("unit_price_cents").notNull(),
  unitCostCents: integer("unit_cost_cents").notNull().default(0),
  optional: boolean("optional").notNull().default(false),
});

// ── Jobs ─────────────────────────────────────────────────────────────────────
export const jobs = pgTable("jobs", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  number: text("number").notNull().unique(),
  status: jobStatusEnum("status").notNull().default("UNSCHEDULED"),
  priority: jobPriorityEnum("priority").notNull().default("NORMAL"),
  jobType: text("job_type").notNull(),
  description: text("description"),
  internalNotes: text("internal_notes"),
  customerId: text("customer_id").notNull().references(() => customers.id),
  propertyId: text("property_id").notNull().references(() => properties.id),
  assignedToId: text("assigned_to_id").references(() => users.id),
  projectId: text("project_id").references(() => projects.id),
  claimId: text("claim_id").references(() => claims.id), // insurance claim linkage (core)
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  scheduledEnd: timestamp("scheduled_end", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedById: text("deleted_by_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const jobPhotos = pgTable("job_photos", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  jobId: text("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
  kind: photoKindEnum("kind").notNull(),
  url: text("url").notNull(),
  caption: text("caption"),
  takenById: text("taken_by_id").notNull().references(() => users.id),
  takenAt: timestamp("taken_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedById: text("deleted_by_id"),
});

export const jobForms = pgTable("job_forms", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  jobId: text("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  required: boolean("required").notNull().default(false),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  data: jsonb("data"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedById: text("deleted_by_id"),
});

export const timeEntries = pgTable("time_entries", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  userId: text("user_id").notNull().references(() => users.id),
  jobId: text("job_id").references(() => jobs.id),
  kind: timeEntryKindEnum("kind").notNull().default("WORK"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedById: text("deleted_by_id"),
});

// ── Projects ─────────────────────────────────────────────────────────────────
export const projects = pgTable("projects", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  name: text("name").notNull(),
  status: projectStatusEnum("status").notNull().default("PLANNING"),
  customerId: text("customer_id").notNull().references(() => customers.id),
  propertyId: text("property_id").notNull().references(() => properties.id),
  contractValueCents: integer("contract_value_cents").notNull().default(0),
  budgetLaborCents: integer("budget_labor_cents").notNull().default(0),
  budgetMaterialsCents: integer("budget_materials_cents").notNull().default(0),
  startDate: timestamp("start_date", { withTimezone: true }),
  endDate: timestamp("end_date", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const milestones = pgTable("milestones", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: milestoneStatusEnum("status").notNull().default("PENDING"),
  dueDate: timestamp("due_date", { withTimezone: true }),
  billingAmountCents: integer("billing_amount_cents").notNull().default(0),
  billed: boolean("billed").notNull().default(false),
  requiresInspection: boolean("requires_inspection").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const changeOrders = pgTable("change_orders", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  number: text("number").notNull(),
  description: text("description").notNull(),
  amountCents: integer("amount_cents").notNull(),
  status: changeOrderStatusEnum("status").notNull().default("DRAFT"),
  signedName: text("signed_name"),
  signedAt: timestamp("signed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const permits = pgTable("permits", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  jurisdiction: text("jurisdiction").notNull(),
  permitNumber: text("permit_number"),
  status: permitStatusEnum("status").notNull().default("NOT_APPLIED"),
  feeCents: integer("fee_cents"),
  inspectionAt: timestamp("inspection_at", { withTimezone: true }),
  notes: text("notes"),
});

export const costEntries = pgTable("cost_entries", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  kind: costKindEnum("kind").notNull(),
  description: text("description").notNull(),
  amountCents: integer("amount_cents").notNull(),
  incurredAt: timestamp("incurred_at", { withTimezone: true }).notNull().defaultNow(),
});

export const subcontractors = pgTable("subcontractors", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  trade: text("trade").notNull(),
  phone: text("phone"),
  licenseNumber: text("license_number"),
  coiExpiresAt: timestamp("coi_expires_at", { withTimezone: true }),
});

// ── Invoices & payments ──────────────────────────────────────────────────────
export const invoices = pgTable("invoices", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  number: text("number").notNull().unique(),
  status: invoiceStatusEnum("status").notNull().default("DRAFT"),
  customerId: text("customer_id").notNull().references(() => customers.id),
  jobId: text("job_id").references(() => jobs.id),
  projectId: text("project_id").references(() => projects.id),
  issuedAt: timestamp("issued_at", { withTimezone: true }),
  dueAt: timestamp("due_at", { withTimezone: true }),
  signedName: text("signed_name"),
  signedAt: timestamp("signed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const invoiceLineItems = pgTable("invoice_line_items", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  invoiceId: text("invoice_id").notNull().references(() => invoices.id, { onDelete: "cascade" }),
  priceBookItemId: text("price_book_item_id").references(() => priceBookItems.id),
  description: text("description").notNull(),
  qty: doublePrecision("qty").notNull().default(1),
  unitPriceCents: integer("unit_price_cents").notNull(),
});

export const payments = pgTable("payments", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  invoiceId: text("invoice_id").notNull().references(() => invoices.id, { onDelete: "cascade" }),
  amountCents: integer("amount_cents").notNull(),
  method: paymentMethodEnum("method").notNull(),
  reference: text("reference"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Price book & inventory ───────────────────────────────────────────────────
export const priceBookItems = pgTable("price_book_items", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  category: text("category").notNull(),
  unitCostCents: integer("unit_cost_cents").notNull().default(0),
  unitPriceCents: integer("unit_price_cents").notNull(),
  laborHours: doublePrecision("labor_hours"),
  active: boolean("active").notNull().default(true),
});

export const inventoryLocations = pgTable("inventory_locations", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  name: text("name").notNull(),
  kind: locationKindEnum("kind").notNull(),
  userId: text("user_id").unique().references(() => users.id),
});

export const stockLevels = pgTable(
  "stock_levels",
  {
    id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
    locationId: text("location_id").notNull().references(() => inventoryLocations.id, { onDelete: "cascade" }),
    priceBookItemId: text("price_book_item_id").notNull().references(() => priceBookItems.id, { onDelete: "cascade" }),
    qtyOnHand: doublePrecision("qty_on_hand").notNull().default(0),
    minQty: doublePrecision("min_qty").notNull().default(0),
    maxQty: doublePrecision("max_qty").notNull().default(0),
    bin: text("bin"),
  },
  (t) => ({
    locItem: uniqueIndex("stock_levels_location_item_idx").on(t.locationId, t.priceBookItemId),
  })
);

export const materialUsages = pgTable("material_usages", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  jobId: text("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
  priceBookItemId: text("price_book_item_id").notNull().references(() => priceBookItems.id),
  qty: doublePrecision("qty").notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }).notNull().defaultNow(),
});

export const partRequests = pgTable("part_requests", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  requestedById: text("requested_by_id").notNull().references(() => users.id),
  jobId: text("job_id").references(() => jobs.id),
  priceBookItemId: text("price_book_item_id").references(() => priceBookItems.id),
  description: text("description").notNull(),
  qty: doublePrecision("qty").notNull().default(1),
  status: partRequestStatusEnum("status").notNull().default("OPEN"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const purchaseOrders = pgTable("purchase_orders", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  number: text("number").notNull().unique(),
  supplier: text("supplier").notNull(),
  status: poStatusEnum("status").notNull().default("DRAFT"),
  expectedAt: timestamp("expected_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const purchaseOrderLines = pgTable("purchase_order_lines", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  purchaseOrderId: text("purchase_order_id").notNull().references(() => purchaseOrders.id, { onDelete: "cascade" }),
  priceBookItemId: text("price_book_item_id").notNull().references(() => priceBookItems.id),
  qty: doublePrecision("qty").notNull(),
  receivedQty: doublePrecision("received_qty").notNull().default(0),
  unitCostCents: integer("unit_cost_cents").notNull(),
});

// ── Commissions ──────────────────────────────────────────────────────────────
export const commissionRules = pgTable("commission_rules", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  name: text("name").notNull(),
  kind: commissionKindEnum("kind").notNull(),
  rate: doublePrecision("rate").notNull(), // percent for PERCENT_*, cents for SPIFF
  role: roleEnum("applies_role"),
  category: text("category"),
  active: boolean("active").notNull().default(true),
});

export const commissionEntries = pgTable("commission_entries", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  userId: text("user_id").notNull().references(() => users.id),
  description: text("description").notNull(),
  amountCents: integer("amount_cents").notNull(),
  period: text("period").notNull(), // "2026-07"
  status: commissionStatusEnum("status").notNull().default("PENDING"),
  sourceType: text("source_type"),
  sourceId: text("source_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Knowledge base ───────────────────────────────────────────────────────────
export const kbArticles = pgTable(
  "kb_articles",
  {
    id: id(),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    category: kbCategoryEnum("category").notNull(),
    body: text("body").notNull(),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    authorId: text("author_id").notNull().references(() => users.id),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (tb) => ({
    orgSlug: uniqueIndex("kb_articles_org_slug_idx").on(tb.organizationId, tb.slug),
  })
);

// ── Timeline, notifications, audit, integrations ────────────────────────────
export const activities = pgTable("activities", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  kind: activityKindEnum("kind").notNull(),
  body: text("body").notNull(),
  userId: text("user_id").references(() => users.id),
  customerId: text("customer_id").references(() => customers.id, { onDelete: "cascade" }),
  jobId: text("job_id").references(() => jobs.id, { onDelete: "cascade" }),
  leadId: text("lead_id").references(() => leads.id, { onDelete: "cascade" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const notifications = pgTable("notifications", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body"),
  href: text("href"),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditLogs = pgTable("audit_logs", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  userId: text("user_id").references(() => users.id),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id"),
  detail: jsonb("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const integrationConnections = pgTable(
  "integration_connections",
  {
    id: id(),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
    provider: text("provider").notNull(),
    status: integrationStatusEnum("status").notNull().default("DISCONNECTED"),
    config: jsonb("config"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  },
  (tb) => ({
    orgProvider: uniqueIndex("integration_connections_org_provider_idx").on(tb.organizationId, tb.provider),
  })
);

// ── Relations (query-layer joins) ────────────────────────────────────────────
export const usersRelations = relations(users, ({ many, one }) => ({
  assignedJobs: many(jobs),
  truck: one(inventoryLocations, { fields: [users.id], references: [inventoryLocations.userId] }),
}));

export const customersRelations = relations(customers, ({ many, one }) => ({
  properties: many(properties),
  jobs: many(jobs),
  estimates: many(estimates),
  invoices: many(invoices),
  projects: many(projects),
  activities: many(activities),
  membership: one(memberships, { fields: [customers.id], references: [memberships.customerId] }),
}));

export const propertiesRelations = relations(properties, ({ many, one }) => ({
  customer: one(customers, { fields: [properties.customerId], references: [customers.id] }),
  equipment: many(equipment),
  jobs: many(jobs),
}));

export const equipmentRelations = relations(equipment, ({ one }) => ({
  property: one(properties, { fields: [equipment.propertyId], references: [properties.id] }),
}));

export const leadsRelations = relations(leads, ({ one, many }) => ({
  customer: one(customers, { fields: [leads.customerId], references: [customers.id] }),
  property: one(properties, { fields: [leads.propertyId], references: [properties.id] }),
  assignedTo: one(users, { fields: [leads.assignedToId], references: [users.id] }),
  createdBy: one(users, { fields: [leads.createdById], references: [users.id] }),
  followUps: many(followUps),
  estimates: many(estimates),
  activities: many(activities),
}));

export const followUpsRelations = relations(followUps, ({ one }) => ({
  lead: one(leads, { fields: [followUps.leadId], references: [leads.id] }),
  estimate: one(estimates, { fields: [followUps.estimateId], references: [estimates.id] }),
}));

export const estimatesRelations = relations(estimates, ({ one, many }) => ({
  customer: one(customers, { fields: [estimates.customerId], references: [customers.id] }),
  property: one(properties, { fields: [estimates.propertyId], references: [properties.id] }),
  lead: one(leads, { fields: [estimates.leadId], references: [leads.id] }),
  job: one(jobs, { fields: [estimates.jobId], references: [jobs.id] }),
  claim: one(claims, { fields: [estimates.claimId], references: [claims.id] }),
  createdBy: one(users, { fields: [estimates.createdById], references: [users.id] }),
  options: many(estimateOptions),
  followUps: many(followUps),
}));

export const estimateOptionsRelations = relations(estimateOptions, ({ one, many }) => ({
  estimate: one(estimates, { fields: [estimateOptions.estimateId], references: [estimates.id] }),
  items: many(estimateLineItems),
}));

export const estimateLineItemsRelations = relations(estimateLineItems, ({ one }) => ({
  option: one(estimateOptions, { fields: [estimateLineItems.optionId], references: [estimateOptions.id] }),
  priceBookItem: one(priceBookItems, { fields: [estimateLineItems.priceBookItemId], references: [priceBookItems.id] }),
}));

export const jobsRelations = relations(jobs, ({ one, many }) => ({
  customer: one(customers, { fields: [jobs.customerId], references: [customers.id] }),
  property: one(properties, { fields: [jobs.propertyId], references: [properties.id] }),
  assignedTo: one(users, { fields: [jobs.assignedToId], references: [users.id] }),
  project: one(projects, { fields: [jobs.projectId], references: [projects.id] }),
  claim: one(claims, { fields: [jobs.claimId], references: [claims.id] }),
  photos: many(jobPhotos),
  forms: many(jobForms),
  timeEntries: many(timeEntries),
  estimates: many(estimates),
  invoices: many(invoices),
  materials: many(materialUsages),
  activities: many(activities),
}));

export const jobPhotosRelations = relations(jobPhotos, ({ one }) => ({
  job: one(jobs, { fields: [jobPhotos.jobId], references: [jobs.id] }),
  takenBy: one(users, { fields: [jobPhotos.takenById], references: [users.id] }),
}));

export const jobFormsRelations = relations(jobForms, ({ one }) => ({
  job: one(jobs, { fields: [jobForms.jobId], references: [jobs.id] }),
}));

export const timeEntriesRelations = relations(timeEntries, ({ one }) => ({
  user: one(users, { fields: [timeEntries.userId], references: [users.id] }),
  job: one(jobs, { fields: [timeEntries.jobId], references: [jobs.id] }),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  customer: one(customers, { fields: [projects.customerId], references: [customers.id] }),
  property: one(properties, { fields: [projects.propertyId], references: [properties.id] }),
  milestones: many(milestones),
  changeOrders: many(changeOrders),
  permits: many(permits),
  costs: many(costEntries),
  subs: many(subcontractors),
  jobs: many(jobs),
  invoices: many(invoices),
}));

export const milestonesRelations = relations(milestones, ({ one }) => ({
  project: one(projects, { fields: [milestones.projectId], references: [projects.id] }),
}));

export const changeOrdersRelations = relations(changeOrders, ({ one }) => ({
  project: one(projects, { fields: [changeOrders.projectId], references: [projects.id] }),
}));

export const permitsRelations = relations(permits, ({ one }) => ({
  project: one(projects, { fields: [permits.projectId], references: [projects.id] }),
}));

export const costEntriesRelations = relations(costEntries, ({ one }) => ({
  project: one(projects, { fields: [costEntries.projectId], references: [projects.id] }),
}));

export const subcontractorsRelations = relations(subcontractors, ({ one }) => ({
  project: one(projects, { fields: [subcontractors.projectId], references: [projects.id] }),
}));

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  customer: one(customers, { fields: [invoices.customerId], references: [customers.id] }),
  job: one(jobs, { fields: [invoices.jobId], references: [jobs.id] }),
  project: one(projects, { fields: [invoices.projectId], references: [projects.id] }),
  items: many(invoiceLineItems),
  payments: many(payments),
}));

export const invoiceLineItemsRelations = relations(invoiceLineItems, ({ one }) => ({
  invoice: one(invoices, { fields: [invoiceLineItems.invoiceId], references: [invoices.id] }),
  priceBookItem: one(priceBookItems, { fields: [invoiceLineItems.priceBookItemId], references: [priceBookItems.id] }),
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  invoice: one(invoices, { fields: [payments.invoiceId], references: [invoices.id] }),
}));

export const priceBookItemsRelations = relations(priceBookItems, ({ many }) => ({
  stockLevels: many(stockLevels),
}));

export const inventoryLocationsRelations = relations(inventoryLocations, ({ one, many }) => ({
  user: one(users, { fields: [inventoryLocations.userId], references: [users.id] }),
  stockLevels: many(stockLevels),
}));

export const stockLevelsRelations = relations(stockLevels, ({ one }) => ({
  location: one(inventoryLocations, { fields: [stockLevels.locationId], references: [inventoryLocations.id] }),
  priceBookItem: one(priceBookItems, { fields: [stockLevels.priceBookItemId], references: [priceBookItems.id] }),
}));

export const materialUsagesRelations = relations(materialUsages, ({ one }) => ({
  job: one(jobs, { fields: [materialUsages.jobId], references: [jobs.id] }),
  priceBookItem: one(priceBookItems, { fields: [materialUsages.priceBookItemId], references: [priceBookItems.id] }),
}));

export const partRequestsRelations = relations(partRequests, ({ one }) => ({
  requestedBy: one(users, { fields: [partRequests.requestedById], references: [users.id] }),
  job: one(jobs, { fields: [partRequests.jobId], references: [jobs.id] }),
  priceBookItem: one(priceBookItems, { fields: [partRequests.priceBookItemId], references: [priceBookItems.id] }),
}));

export const purchaseOrdersRelations = relations(purchaseOrders, ({ many }) => ({
  lines: many(purchaseOrderLines),
}));

export const purchaseOrderLinesRelations = relations(purchaseOrderLines, ({ one }) => ({
  purchaseOrder: one(purchaseOrders, { fields: [purchaseOrderLines.purchaseOrderId], references: [purchaseOrders.id] }),
  priceBookItem: one(priceBookItems, { fields: [purchaseOrderLines.priceBookItemId], references: [priceBookItems.id] }),
}));

export const commissionEntriesRelations = relations(commissionEntries, ({ one }) => ({
  user: one(users, { fields: [commissionEntries.userId], references: [users.id] }),
}));

export const kbArticlesRelations = relations(kbArticles, ({ one }) => ({
  author: one(users, { fields: [kbArticles.authorId], references: [users.id] }),
}));

export const activitiesRelations = relations(activities, ({ one }) => ({
  user: one(users, { fields: [activities.userId], references: [users.id] }),
  customer: one(customers, { fields: [activities.customerId], references: [customers.id] }),
  job: one(jobs, { fields: [activities.jobId], references: [jobs.id] }),
  lead: one(leads, { fields: [activities.leadId], references: [leads.id] }),
  project: one(projects, { fields: [activities.projectId], references: [projects.id] }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
}));

// ── Per-user permission overrides ────────────────────────────────────────────
// Effective permissions = role bundle + granted overrides − revoked overrides.
export const userPermissionOverrides = pgTable(
  "user_permission_overrides",
  {
    id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
    granted: boolean("granted").notNull(), // true = add, false = revoke
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (tb) => ({
    userPerm: uniqueIndex("user_permission_overrides_user_perm_idx").on(tb.userId, tb.permission),
  })
);

export const userPermissionOverridesRelations = relations(userPermissionOverrides, ({ one }) => ({
  user: one(users, { fields: [userPermissionOverrides.userId], references: [users.id] }),
}));

// ── In-app messaging ─────────────────────────────────────────────────────────
export const conversations = pgTable("conversations", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  title: text("title"), // null for 1:1 (derived from participants); set for groups
  isGroup: boolean("is_group").notNull().default(false),
  createdById: text("created_by_id").references(() => users.id),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const conversationParticipants = pgTable(
  "conversation_participants",
  {
    id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
    conversationId: text("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
  },
  (tb) => ({
    convUser: uniqueIndex("conversation_participants_conv_user_idx").on(tb.conversationId, tb.userId),
  })
);

export const messages = pgTable("messages", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  conversationId: text("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  senderId: text("sender_id").notNull().references(() => users.id),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const conversationsRelations = relations(conversations, ({ many, one }) => ({
  participants: many(conversationParticipants),
  messages: many(messages),
  createdBy: one(users, { fields: [conversations.createdById], references: [users.id] }),
}));

export const conversationParticipantsRelations = relations(conversationParticipants, ({ one }) => ({
  conversation: one(conversations, { fields: [conversationParticipants.conversationId], references: [conversations.id] }),
  user: one(users, { fields: [conversationParticipants.userId], references: [users.id] }),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, { fields: [messages.conversationId], references: [conversations.id] }),
  sender: one(users, { fields: [messages.senderId], references: [users.id] }),
}));

// ── Multi-tenancy: organizations & trade packs ───────────────────────────────
// Every tenant-owned row carries organization_id (RLS-enforced). Organizations
// are the tenant root; trade packs are composable capability bundles a tenant
// enables (a tenant may enable MANY — plumbing + sewer, GC + restoration).

export const organizations = pgTable("organizations", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  // Standalone-first: local auth by default; external SSO when configured.
  ssoProvider: text("sso_provider"), // e.g. "oidc"
  ssoIssuerUrl: text("sso_issuer_url"),
  ssoClientId: text("sso_client_id"),
  ssoClientSecret: text("sso_client_secret"),
  brandPrimary: text("brand_primary").default("#0057FF"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Global catalog of available trade packs (not tenant-scoped).
export const tradePacks = pgTable("trade_packs", {
  id: id(),
  key: text("key").notNull().unique(), // e.g. "plumbing", "hvac", "fuel_equipment", "aa_field_ops"
  name: text("name").notNull(),
  description: text("description"),
  // Data/config-driven content: job & estimate templates, line-item catalog,
  // compliance/credential rules, safety docs, seasonality, equipment models.
  config: jsonb("config"),
  active: boolean("active").notNull().default(true),
});

// Which packs a tenant has enabled (composition point — many per org).
export const organizationTradePacks = pgTable(
  "organization_trade_packs",
  {
    id: id(),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    tradePackId: text("trade_pack_id").notNull().references(() => tradePacks.id, { onDelete: "cascade" }),
    enabledAt: timestamp("enabled_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (tb) => ({
    orgPack: uniqueIndex("organization_trade_packs_org_pack_idx").on(tb.organizationId, tb.tradePackId),
  })
);

export const organizationsRelations = relations(organizations, ({ many }) => ({
  users: many(users),
  tradePacks: many(organizationTradePacks),
}));

export const tradePacksRelations = relations(tradePacks, ({ many }) => ({
  organizations: many(organizationTradePacks),
}));

export const organizationTradePacksRelations = relations(organizationTradePacks, ({ one }) => ({
  organization: one(organizations, { fields: [organizationTradePacks.organizationId], references: [organizations.id] }),
  tradePack: one(tradePacks, { fields: [organizationTradePacks.tradePackId], references: [tradePacks.id] }),
}));

// ── Insurance / Claims (CORE, not a pack — constraint 3) ────────────────────
// Restoration & roofing depend on this; every trade may use it.
// Claims data is PII-sensitive: writes are audited, exports logged.

export const claimStatusEnum = pgEnum("claim_status", [
  "OPEN", "DOCUMENTING", "SUBMITTED", "SUPPLEMENT", "APPROVED", "PAID", "DENIED", "CLOSED",
]);
export const supplementStatusEnum = pgEnum("supplement_status", [
  "DRAFT", "SUBMITTED", "APPROVED", "DENIED",
]);

export const carriers = pgTable("carriers", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  name: text("name").notNull(),
  phone: text("phone"),
  email: text("email"),
  claimsPortalUrl: text("claims_portal_url"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const adjusters = pgTable("adjusters", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  carrierId: text("carrier_id").notNull().references(() => carriers.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  phone: text("phone"),
  email: text("email"),
  notes: text("notes"),
});

export const claims = pgTable(
  "claims",
  {
    id: id(),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
    claimNumber: text("claim_number").notNull(),
    status: claimStatusEnum("status").notNull().default("OPEN"),
    customerId: text("customer_id").notNull().references(() => customers.id),
    propertyId: text("property_id").references(() => properties.id),
    carrierId: text("carrier_id").references(() => carriers.id),
    adjusterId: text("adjuster_id").references(() => adjusters.id),
    policyNumber: text("policy_number"), // PII-sensitive
    dateOfLoss: timestamp("date_of_loss", { withTimezone: true }),
    lossDescription: text("loss_description"),
    deductibleCents: integer("deductible_cents"),
    approvedAmountCents: integer("approved_amount_cents"),
    createdById: text("created_by_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (tb) => ({
    orgClaimNo: uniqueIndex("claims_org_claim_number_idx").on(tb.organizationId, tb.claimNumber),
  })
);

export const claimSupplements = pgTable("claim_supplements", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  claimId: text("claim_id").notNull().references(() => claims.id, { onDelete: "cascade" }),
  number: text("number").notNull(), // SUP-01
  description: text("description").notNull(),
  amountCents: integer("amount_cents").notNull(),
  status: supplementStatusEnum("status").notNull().default("DRAFT"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Compliance / Inspection engine (CORE — constraint 4) ────────────────────
// Generic engine; trade packs specialize via templates (fuel: UST testing,
// weights-&-measures; electrical: permits; plumbing: backflow).

export const inspectionStatusEnum = pgEnum("inspection_status", [
  "SCHEDULED", "IN_PROGRESS", "PASSED", "FAILED", "CANCELLED",
]);
export const certHolderEnum = pgEnum("cert_holder", ["USER", "EQUIPMENT", "ORGANIZATION"]);

export const inspectionTemplates = pgTable("inspection_templates", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  name: text("name").notNull(),
  tradePackKey: text("trade_pack_key"), // null = generic/core template
  description: text("description"),
  // Ordered steps: [{ key, label, kind: "check"|"measurement"|"photo"|"note", required, unit? }]
  steps: jsonb("steps").notNull(),
  // Passing this inspection can issue a certification automatically:
  issuesCertification: text("issues_certification"), // cert name, e.g. "Backflow Prevention Test"
  certValidityDays: integer("cert_validity_days"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const inspections = pgTable("inspections", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  templateId: text("template_id").notNull().references(() => inspectionTemplates.id),
  status: inspectionStatusEnum("status").notNull().default("SCHEDULED"),
  jobId: text("job_id").references(() => jobs.id),
  propertyId: text("property_id").references(() => properties.id),
  equipmentId: text("equipment_id").references(() => equipment.id),
  inspectorId: text("inspector_id").references(() => users.id),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  // Results keyed by step key: { [key]: { value, pass, note } }
  results: jsonb("results"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const certifications = pgTable("certifications", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  name: text("name").notNull(), // e.g. "Journeyman Plumber License", "UST Operator A/B"
  holderType: certHolderEnum("holder_type").notNull(),
  userId: text("user_id").references(() => users.id),
  equipmentId: text("equipment_id").references(() => equipment.id),
  certificateNumber: text("certificate_number"),
  issuingAuthority: text("issuing_authority"),
  issuedAt: timestamp("issued_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  sourceInspectionId: text("source_inspection_id").references(() => inspections.id),
  renewalNotifiedAt: timestamp("renewal_notified_at", { withTimezone: true }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Phase-3 relations ────────────────────────────────────────────────────────
export const carriersRelations = relations(carriers, ({ many }) => ({
  adjusters: many(adjusters),
  claims: many(claims),
}));
export const adjustersRelations = relations(adjusters, ({ one, many }) => ({
  carrier: one(carriers, { fields: [adjusters.carrierId], references: [carriers.id] }),
  claims: many(claims),
}));
export const claimsRelations = relations(claims, ({ one, many }) => ({
  customer: one(customers, { fields: [claims.customerId], references: [customers.id] }),
  property: one(properties, { fields: [claims.propertyId], references: [properties.id] }),
  carrier: one(carriers, { fields: [claims.carrierId], references: [carriers.id] }),
  adjuster: one(adjusters, { fields: [claims.adjusterId], references: [adjusters.id] }),
  createdBy: one(users, { fields: [claims.createdById], references: [users.id] }),
  supplements: many(claimSupplements),
  jobs: many(jobs),
  estimates: many(estimates),
}));
export const claimSupplementsRelations = relations(claimSupplements, ({ one }) => ({
  claim: one(claims, { fields: [claimSupplements.claimId], references: [claims.id] }),
}));
export const inspectionTemplatesRelations = relations(inspectionTemplates, ({ many }) => ({
  inspections: many(inspections),
}));
export const inspectionsRelations = relations(inspections, ({ one }) => ({
  template: one(inspectionTemplates, { fields: [inspections.templateId], references: [inspectionTemplates.id] }),
  job: one(jobs, { fields: [inspections.jobId], references: [jobs.id] }),
  property: one(properties, { fields: [inspections.propertyId], references: [properties.id] }),
  equipmentRef: one(equipment, { fields: [inspections.equipmentId], references: [equipment.id] }),
  inspector: one(users, { fields: [inspections.inspectorId], references: [users.id] }),
}));
export const certificationsRelations = relations(certifications, ({ one }) => ({
  user: one(users, { fields: [certifications.userId], references: [users.id] }),
  equipmentRef: one(equipment, { fields: [certifications.equipmentId], references: [equipment.id] }),
  sourceInspection: one(inspections, { fields: [certifications.sourceInspectionId], references: [inspections.id] }),
}));

// ── Approval-gated egress (constraint 8) ─────────────────────────────────────
// Nothing customer-facing leaves without owner/office approval. Licensed work
// routes to a human holding a valid certification (requiredCertName).

export const outboundStatusEnum = pgEnum("outbound_status", [
  "PENDING_APPROVAL", "APPROVED_SENT", "REJECTED", "CANCELLED",
]);
export const outboundKindEnum = pgEnum("outbound_kind", [
  "ESTIMATE_SEND", "FOLLOW_UP_TOUCH", "CUSTOMER_MESSAGE", "LICENSED_SIGNOFF",
]);

export const outboundMessages = pgTable("outbound_messages", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  kind: outboundKindEnum("kind").notNull(),
  status: outboundStatusEnum("status").notNull().default("PENDING_APPROVAL"),
  // Who/what it's about:
  customerId: text("customer_id").references(() => customers.id),
  recipient: text("recipient"), // phone/email snapshot
  subject: text("subject"),
  body: text("body").notNull(),
  // What executing the approval should do:
  estimateId: text("estimate_id").references(() => estimates.id),
  followUpId: text("follow_up_id").references(() => followUps.id),
  jobId: text("job_id").references(() => jobs.id),
  permitId: text("permit_id").references(() => permits.id),
  // Licensed-work routing: only holders of a valid cert with this name (or ADMIN) may approve.
  requiredCertName: text("required_cert_name"),
  requestedById: text("requested_by_id").notNull().references(() => users.id),
  approvedById: text("approved_by_id").references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  rejectReason: text("reject_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Supplier punchout (cXML procurement) ─────────────────────────────────────

/**
 * One punchout round-trip to a supplier catalog (cXML PunchOutSetupRequest →
 * supplier StartPage → PunchOutOrderMessage cart return). The cart NEVER
 * lands on the estimate directly — an office/admin approves it first
 * (constraint 8: approval-gated), converting lines to estimate_line_items.
 * `buyerCookie` is the unguessable capability token the supplier echoes back.
 */
export const punchoutSessions = pgTable("punchout_sessions", {
  id: id(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).default(sql`current_setting('app.current_org', true)`),
  provider: text("provider").notNull(), // integration_connections.provider key
  supplierName: text("supplier_name"),
  status: text("status").notNull().default("STARTED"), // STARTED | CART_RETURNED | APPROVED | REJECTED
  estimateOptionId: text("estimate_option_id").notNull().references(() => estimateOptions.id, { onDelete: "cascade" }),
  buyerCookie: text("buyer_cookie").notNull().unique(),
  /** Parsed PunchOutOrderMessage lines: [{supplierPartId, description, qty, unitPriceCents, uom}] */
  cart: jsonb("cart"),
  requestedById: text("requested_by_id").notNull().references(() => users.id),
  decidedById: text("decided_by_id").references(() => users.id),
  returnedAt: timestamp("returned_at", { withTimezone: true }),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const punchoutSessionsRelations = relations(punchoutSessions, ({ one }) => ({
  estimateOption: one(estimateOptions, { fields: [punchoutSessions.estimateOptionId], references: [estimateOptions.id] }),
  requestedBy: one(users, { fields: [punchoutSessions.requestedById], references: [users.id] }),
  decidedBy: one(users, { fields: [punchoutSessions.decidedById], references: [users.id] }),
}));

export const outboundMessagesRelations = relations(outboundMessages, ({ one }) => ({
  customer: one(customers, { fields: [outboundMessages.customerId], references: [customers.id] }),
  estimate: one(estimates, { fields: [outboundMessages.estimateId], references: [estimates.id] }),
  followUp: one(followUps, { fields: [outboundMessages.followUpId], references: [followUps.id] }),
  job: one(jobs, { fields: [outboundMessages.jobId], references: [jobs.id] }),
  permit: one(permits, { fields: [outboundMessages.permitId], references: [permits.id] }),
  requestedBy: one(users, { fields: [outboundMessages.requestedById], references: [users.id] }),
  approvedBy: one(users, { fields: [outboundMessages.approvedById], references: [users.id] }),
}));
