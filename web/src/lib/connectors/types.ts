/**
 * Typed connector interface (constraint 9 — integrations are first-class).
 *
 * Clients KEEP their existing stack; Trade-Ops layers on top, reading and
 * writing their tools through capability-typed operations. Every connector is
 * OPTIONAL (constraint 2 — standalone-first): disconnected means the app is
 * fully functional on local data. Failures never disappear — every operation
 * returns an explicit degraded result carrying the error message, mirroring
 * the OrgMemoryStore degraded-status pattern in src/lib/knowledge/store.ts.
 *
 * Money is integer cents throughout (external decimal amounts are converted
 * at the connector boundary).
 */

// ── Capabilities ─────────────────────────────────────────────────────────────

export type ConnectorCapability = "crm" | "accounting" | "jobs" | "messaging" | "pm";

export const CAPABILITY_LABELS: Record<ConnectorCapability, string> = {
  crm: "CRM",
  accounting: "Accounting",
  jobs: "Job apps",
  messaging: "Messaging",
  pm: "Project management",
};

// ── Descriptor (drives the integrations hub UI) ──────────────────────────────

export type ConnectorConfigField = {
  key: string;
  label: string;
  kind: "text" | "password" | "url";
  placeholder?: string;
  required?: boolean;
};

export interface ConnectorDescriptor {
  /** Stable uppercase key stored in integration_connections.provider. */
  provider: string;
  label: string;
  emoji: string;
  capabilities: ConnectorCapability[];
  blurb: string;
  configFields: ConnectorConfigField[];
}

/** Stored per-org in integration_connections.config (jsonb). */
export type ConnectorConfig = Record<string, string | undefined>;

// ── Shared external-record shapes (id mapping: provider + externalId) ────────

export interface ExternalLead {
  provider: string;
  externalId: string;
  title: string;
  contactName: string;
  phone?: string;
  email?: string;
  /** Integer cents (converted from the provider's decimal amount). */
  expectedRevenueCents?: number;
  stage?: string;
  /** True when the record came from a demo stub, not a live system. */
  demo?: boolean;
}

export interface ExternalContact {
  /** Present when updating a known remote record; absent → create + dedupe. */
  externalId?: string;
  name: string;
  email?: string;
  phone?: string;
  company?: string;
}

export interface ExternalActivity {
  kind: "note" | "call" | "email" | "sms";
  body: string;
  /** Remote record (e.g. CRM lead id) this activity attaches to. */
  relatedExternalId?: string;
  subject?: string;
}

export interface ExternalJob {
  provider: string;
  externalId: string;
  title: string;
  status?: string;
  customerName?: string;
  scheduledAt?: string; // ISO timestamp
  address?: string;
  demo?: boolean;
}

export interface ExternalInvoice {
  externalId?: string;
  number: string;
  customerName: string;
  /** Integer cents. */
  totalCents: number;
  issuedAt?: string; // ISO date
  memo?: string;
}

export interface ExternalPayment {
  externalId?: string;
  invoiceNumber?: string;
  /** Integer cents. */
  amountCents: number;
  method?: string;
  receivedAt?: string; // ISO timestamp
}

export interface ExternalTask {
  externalId?: string;
  title: string;
  notes?: string;
  dueAt?: string; // ISO date
  projectName?: string;
}

// ── Operation results (loud failures — degraded carries the message) ─────────

/**
 * Result of a write to an external system. `ok:false` ALWAYS carries a
 * message; `degraded` distinguishes "the remote system failed" from "the
 * connector was never configured".
 */
export type PushResult = {
  ok: boolean;
  degraded: boolean;
  externalId?: string;
  message?: string;
  demo?: boolean;
};

/** Result of a read from an external system. Failure keeps records empty. */
export type PullResult<T> = {
  ok: boolean;
  degraded: boolean;
  records: T[];
  message?: string;
  demo?: boolean;
};

export type ConnectorHealth = {
  ok: boolean;
  /** true = configured but unreachable/failing (surface LOUDLY). */
  degraded: boolean;
  message?: string;
};

// ── Capability operation interfaces ──────────────────────────────────────────

export interface CrmOps {
  pullLeads(since?: Date): Promise<PullResult<ExternalLead>>;
  pushActivity(a: ExternalActivity): Promise<PushResult>;
  upsertContact(c: ExternalContact): Promise<PushResult>;
}

export interface AccountingOps {
  pushInvoice(inv: ExternalInvoice): Promise<PushResult>;
  pushPayment(p: ExternalPayment): Promise<PushResult>;
}

export interface MessagingOps {
  sendSms(to: string, body: string): Promise<PushResult>;
  sendEmail(to: string, subject: string, body: string): Promise<PushResult>;
}

export interface JobsOps {
  pullJobs(since?: Date): Promise<PullResult<ExternalJob>>;
}

export interface PmOps {
  pushTask(task: ExternalTask): Promise<PushResult>;
}

// ── The connector ────────────────────────────────────────────────────────────

/**
 * A connector implements health() plus a factory per capability it supports.
 * Factories take the org's stored config and return typed operations; a
 * capability listed in the descriptor MUST have a matching factory.
 */
export interface Connector {
  descriptor: ConnectorDescriptor;
  health(config: ConnectorConfig): Promise<ConnectorHealth>;
  crm?: (config: ConnectorConfig) => CrmOps;
  accounting?: (config: ConnectorConfig) => AccountingOps;
  messaging?: (config: ConnectorConfig) => MessagingOps;
  jobs?: (config: ConnectorConfig) => JobsOps;
  pm?: (config: ConnectorConfig) => PmOps;
}

/** Shared helper: which required config fields are missing? */
export function missingRequiredFields(
  descriptor: ConnectorDescriptor,
  config: ConnectorConfig
): string[] {
  return descriptor.configFields
    .filter((f) => f.required && !(config[f.key] ?? "").toString().trim())
    .map((f) => f.label);
}
