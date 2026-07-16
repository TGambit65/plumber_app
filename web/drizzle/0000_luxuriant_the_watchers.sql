CREATE TYPE "public"."activity_kind" AS ENUM('CALL', 'SMS', 'EMAIL', 'NOTE', 'STATUS', 'SYSTEM', 'ESTIMATE_VIEW', 'PAYMENT', 'REVIEW');--> statement-breakpoint
CREATE TYPE "public"."change_order_status" AS ENUM('DRAFT', 'PENDING_SIGNATURE', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."commission_kind" AS ENUM('PERCENT_REVENUE', 'PERCENT_MARGIN', 'SPIFF');--> statement-breakpoint
CREATE TYPE "public"."commission_status" AS ENUM('PENDING', 'APPROVED', 'PAID');--> statement-breakpoint
CREATE TYPE "public"."cost_kind" AS ENUM('LABOR', 'MATERIAL', 'SUBCONTRACTOR', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."customer_type" AS ENUM('RESIDENTIAL', 'COMMERCIAL');--> statement-breakpoint
CREATE TYPE "public"."estimate_status" AS ENUM('DRAFT', 'SENT', 'VIEWED', 'APPROVED', 'DECLINED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."follow_up_channel" AS ENUM('SMS', 'EMAIL', 'CALL');--> statement-breakpoint
CREATE TYPE "public"."follow_up_status" AS ENUM('PENDING', 'SENT', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "public"."integration_status" AS ENUM('DISCONNECTED', 'CONNECTED', 'ERROR');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('DRAFT', 'SENT', 'PARTIAL', 'PAID', 'OVERDUE', 'VOID');--> statement-breakpoint
CREATE TYPE "public"."job_priority" AS ENUM('LOW', 'NORMAL', 'HIGH', 'EMERGENCY');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('UNSCHEDULED', 'SCHEDULED', 'DISPATCHED', 'EN_ROUTE', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."kb_category" AS ENUM('SOP', 'POLICY', 'EQUIPMENT', 'SAFETY', 'HR', 'EMERGENCY');--> statement-breakpoint
CREATE TYPE "public"."lead_source" AS ENUM('PHONE', 'WEB_FORM', 'GOOGLE_LSA', 'ANGI', 'REFERRAL', 'TECH_FLAGGED', 'SMS', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."lead_stage" AS ENUM('NEW', 'CONTACTED', 'ESTIMATE_SCHEDULED', 'ESTIMATE_SENT', 'FOLLOW_UP', 'WON', 'LOST');--> statement-breakpoint
CREATE TYPE "public"."location_kind" AS ENUM('WAREHOUSE', 'TRUCK');--> statement-breakpoint
CREATE TYPE "public"."milestone_status" AS ENUM('PENDING', 'IN_PROGRESS', 'BLOCKED', 'COMPLETE');--> statement-breakpoint
CREATE TYPE "public"."option_tier" AS ENUM('GOOD', 'BETTER', 'BEST', 'CUSTOM');--> statement-breakpoint
CREATE TYPE "public"."part_request_status" AS ENUM('OPEN', 'ORDERED', 'FULFILLED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('CARD', 'ACH', 'CASH', 'CHECK', 'FINANCING');--> statement-breakpoint
CREATE TYPE "public"."permit_status" AS ENUM('NOT_APPLIED', 'APPLIED', 'ISSUED', 'INSPECTION_SCHEDULED', 'PASSED', 'FAILED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."photo_kind" AS ENUM('BEFORE', 'DURING', 'AFTER', 'PROBLEM', 'COVERUP');--> statement-breakpoint
CREATE TYPE "public"."po_status" AS ENUM('DRAFT', 'SENT', 'PARTIAL', 'RECEIVED', 'BILLED');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('TECH', 'SALES_PM', 'OFFICE', 'ADMIN');--> statement-breakpoint
CREATE TYPE "public"."time_entry_kind" AS ENUM('TRAVEL', 'WORK');--> statement-breakpoint
CREATE TABLE "activities" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "activity_kind" NOT NULL,
	"body" text NOT NULL,
	"user_id" text,
	"customer_id" text,
	"job_id" text,
	"lead_id" text,
	"project_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_orders" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"number" text NOT NULL,
	"description" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" "change_order_status" DEFAULT 'DRAFT' NOT NULL,
	"signed_name" text,
	"signed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commission_entries" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"description" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"period" text NOT NULL,
	"status" "commission_status" DEFAULT 'PENDING' NOT NULL,
	"source_type" text,
	"source_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commission_rules" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" "commission_kind" NOT NULL,
	"rate" double precision NOT NULL,
	"applies_role" "role",
	"category" text,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_entries" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"kind" "cost_kind" NOT NULL,
	"description" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"incurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "customer_type" DEFAULT 'RESIDENTIAL' NOT NULL,
	"name" text NOT NULL,
	"company" text,
	"email" text,
	"phone" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "equipment" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" text NOT NULL,
	"kind" text NOT NULL,
	"brand" text,
	"model" text,
	"serial" text,
	"installed_at" timestamp with time zone,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "estimate_line_items" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"option_id" text NOT NULL,
	"price_book_item_id" text,
	"description" text NOT NULL,
	"qty" double precision DEFAULT 1 NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"unit_cost_cents" integer DEFAULT 0 NOT NULL,
	"optional" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estimate_options" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"estimate_id" text NOT NULL,
	"tier" "option_tier" NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"selected" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estimates" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"status" "estimate_status" DEFAULT 'DRAFT' NOT NULL,
	"customer_id" text NOT NULL,
	"property_id" text,
	"lead_id" text,
	"job_id" text,
	"created_by_id" text NOT NULL,
	"notes" text,
	"financing_offered" boolean DEFAULT true NOT NULL,
	"view_count" integer DEFAULT 0 NOT NULL,
	"last_viewed_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"signed_name" text,
	"signed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "estimates_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "follow_ups" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" text,
	"estimate_id" text,
	"channel" "follow_up_channel" NOT NULL,
	"status" "follow_up_status" DEFAULT 'PENDING' NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"body" text NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "integration_connections" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"status" "integration_status" DEFAULT 'DISCONNECTED' NOT NULL,
	"config" jsonb,
	"last_sync_at" timestamp with time zone,
	CONSTRAINT "integration_connections_provider_unique" UNIQUE("provider")
);
--> statement-breakpoint
CREATE TABLE "inventory_locations" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" "location_kind" NOT NULL,
	"user_id" text,
	CONSTRAINT "inventory_locations_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "invoice_line_items" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" text NOT NULL,
	"price_book_item_id" text,
	"description" text NOT NULL,
	"qty" double precision DEFAULT 1 NOT NULL,
	"unit_price_cents" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"status" "invoice_status" DEFAULT 'DRAFT' NOT NULL,
	"customer_id" text NOT NULL,
	"job_id" text,
	"project_id" text,
	"issued_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"signed_name" text,
	"signed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "job_forms" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" text NOT NULL,
	"name" text NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp with time zone,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE "job_photos" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" text NOT NULL,
	"kind" "photo_kind" NOT NULL,
	"url" text NOT NULL,
	"caption" text,
	"taken_by_id" text NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"status" "job_status" DEFAULT 'UNSCHEDULED' NOT NULL,
	"priority" "job_priority" DEFAULT 'NORMAL' NOT NULL,
	"job_type" text NOT NULL,
	"description" text,
	"internal_notes" text,
	"customer_id" text NOT NULL,
	"property_id" text NOT NULL,
	"assigned_to_id" text,
	"project_id" text,
	"scheduled_at" timestamp with time zone,
	"scheduled_end" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "kb_articles" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"category" "kb_category" NOT NULL,
	"body" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"author_id" text NOT NULL,
	"verified_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_articles_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "lead_source" DEFAULT 'PHONE' NOT NULL,
	"stage" "lead_stage" DEFAULT 'NEW' NOT NULL,
	"title" text NOT NULL,
	"contact_name" text NOT NULL,
	"phone" text,
	"email" text,
	"description" text,
	"est_value_cents" integer,
	"lost_reason" text,
	"respond_by" timestamp with time zone,
	"first_touch_at" timestamp with time zone,
	"last_contact_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"customer_id" text,
	"property_id" text,
	"assigned_to_id" text,
	"created_by_id" text,
	"tech_flagged" boolean DEFAULT false NOT NULL,
	"spiff_cents" integer
);
--> statement-breakpoint
CREATE TABLE "material_usages" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" text NOT NULL,
	"price_book_item_id" text NOT NULL,
	"qty" double precision NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" text NOT NULL,
	"plan" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"renews_at" timestamp with time zone,
	CONSTRAINT "memberships_customer_id_unique" UNIQUE("customer_id")
);
--> statement-breakpoint
CREATE TABLE "milestones" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"status" "milestone_status" DEFAULT 'PENDING' NOT NULL,
	"due_date" timestamp with time zone,
	"billing_amount_cents" integer DEFAULT 0 NOT NULL,
	"billed" boolean DEFAULT false NOT NULL,
	"requires_inspection" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"href" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "part_requests" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requested_by_id" text NOT NULL,
	"job_id" text,
	"price_book_item_id" text,
	"description" text NOT NULL,
	"qty" double precision DEFAULT 1 NOT NULL,
	"status" "part_request_status" DEFAULT 'OPEN' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"method" "payment_method" NOT NULL,
	"reference" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permits" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"jurisdiction" text NOT NULL,
	"permit_number" text,
	"status" "permit_status" DEFAULT 'NOT_APPLIED' NOT NULL,
	"fee_cents" integer,
	"inspection_at" timestamp with time zone,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "price_book_items" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text NOT NULL,
	"unit_cost_cents" integer DEFAULT 0 NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"labor_hours" double precision,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "price_book_items_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"status" "project_status" DEFAULT 'PLANNING' NOT NULL,
	"customer_id" text NOT NULL,
	"property_id" text NOT NULL,
	"contract_value_cents" integer DEFAULT 0 NOT NULL,
	"budget_labor_cents" integer DEFAULT 0 NOT NULL,
	"budget_materials_cents" integer DEFAULT 0 NOT NULL,
	"start_date" timestamp with time zone,
	"end_date" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" text NOT NULL,
	"label" text,
	"address" text NOT NULL,
	"city" text NOT NULL,
	"state" text NOT NULL,
	"zip" text NOT NULL,
	"gate_code" text,
	"access_notes" text,
	"shutoff_location" text,
	"parking_notes" text,
	"pet_notes" text
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_order_id" text NOT NULL,
	"price_book_item_id" text NOT NULL,
	"qty" double precision NOT NULL,
	"received_qty" double precision DEFAULT 0 NOT NULL,
	"unit_cost_cents" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"supplier" text NOT NULL,
	"status" "po_status" DEFAULT 'DRAFT' NOT NULL,
	"expected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_orders_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "stock_levels" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" text NOT NULL,
	"price_book_item_id" text NOT NULL,
	"qty_on_hand" double precision DEFAULT 0 NOT NULL,
	"min_qty" double precision DEFAULT 0 NOT NULL,
	"max_qty" double precision DEFAULT 0 NOT NULL,
	"bin" text
);
--> statement-breakpoint
CREATE TABLE "subcontractors" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"trade" text NOT NULL,
	"phone" text,
	"license_number" text,
	"coi_expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "time_entries" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"job_id" text,
	"kind" time_entry_kind DEFAULT 'WORK' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"role" "role" NOT NULL,
	"password_hash" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_orders" ADD CONSTRAINT "change_orders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_line_items" ADD CONSTRAINT "estimate_line_items_option_id_estimate_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."estimate_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_line_items" ADD CONSTRAINT "estimate_line_items_price_book_item_id_price_book_items_id_fk" FOREIGN KEY ("price_book_item_id") REFERENCES "public"."price_book_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_options" ADD CONSTRAINT "estimate_options_estimate_id_estimates_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_estimate_id_estimates_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_locations" ADD CONSTRAINT "inventory_locations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_price_book_item_id_price_book_items_id_fk" FOREIGN KEY ("price_book_item_id") REFERENCES "public"."price_book_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_forms" ADD CONSTRAINT "job_forms_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_photos" ADD CONSTRAINT "job_photos_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_photos" ADD CONSTRAINT "job_photos_taken_by_id_users_id_fk" FOREIGN KEY ("taken_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_assigned_to_id_users_id_fk" FOREIGN KEY ("assigned_to_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_assigned_to_id_users_id_fk" FOREIGN KEY ("assigned_to_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_usages" ADD CONSTRAINT "material_usages_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_usages" ADD CONSTRAINT "material_usages_price_book_item_id_price_book_items_id_fk" FOREIGN KEY ("price_book_item_id") REFERENCES "public"."price_book_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_requests" ADD CONSTRAINT "part_requests_requested_by_id_users_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_requests" ADD CONSTRAINT "part_requests_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_requests" ADD CONSTRAINT "part_requests_price_book_item_id_price_book_items_id_fk" FOREIGN KEY ("price_book_item_id") REFERENCES "public"."price_book_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permits" ADD CONSTRAINT "permits_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_price_book_item_id_price_book_items_id_fk" FOREIGN KEY ("price_book_item_id") REFERENCES "public"."price_book_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_location_id_inventory_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."inventory_locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_price_book_item_id_price_book_items_id_fk" FOREIGN KEY ("price_book_item_id") REFERENCES "public"."price_book_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcontractors" ADD CONSTRAINT "subcontractors_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_levels_location_item_idx" ON "stock_levels" USING btree ("location_id","price_book_item_id");