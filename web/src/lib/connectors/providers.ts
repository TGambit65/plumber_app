import "server-only";
import type {
  AccountingOps,
  Connector,
  ConnectorCapability,
  ConnectorConfig,
  ConnectorDescriptor,
  ConnectorHealth,
  CrmOps,
  ExternalJob,
  ExternalLead,
  JobsOps,
  MessagingOps,
  PmOps,
  PullResult,
  PushResult,
} from "./types";
import { missingRequiredFields } from "./types";
import { odooConnector } from "./odoo";
import { hubspotConnector } from "./hubspot";
import { quickbooksConnector } from "./quickbooks";
import { cxmlSupplierConnector } from "./cxml-supplier";
import { twilioConnector } from "./twilio";
import { googleCalendarConnector } from "./google-calendar";
import { outlookCalendarConnector } from "./outlook-calendar";
import { googleMapsConnector } from "./google-maps";

/**
 * Connector registry. Odoo (JSON-RPC), HubSpot (CRM v3 REST) and QuickBooks
 * Online (Accounting API v3) are REAL implementations (constraint 9 — Odoo CRM
 * required); the rest are descriptor-complete stubs that return realistic-
 * shaped data marked { demo: true } until real credentials/impls land.
 *
 * ORGMEMORY is deliberately NOT in this registry — the knowledge substrate has
 * its own hub card and resolver (src/lib/knowledge/store.ts).
 *
 * Constraint 2: every connector is optional; a stub with missing required
 * config reports ok:false with a message rather than silently connecting.
 */

// ── Stub plumbing ─────────────────────────────────────────────────────────────

function stubHealth(descriptor: ConnectorDescriptor, config: ConnectorConfig): Promise<ConnectorHealth> {
  const missing = missingRequiredFields(descriptor, config);
  if (missing.length > 0) {
    return Promise.resolve({
      ok: false,
      degraded: false,
      message: `Missing required field(s): ${missing.join(", ")}`,
    });
  }
  return Promise.resolve({
    ok: true,
    degraded: false,
    message: "Demo connector — accepts any credentials and returns sample data",
  });
}

function demoPush(provider: string): Promise<PushResult> {
  return Promise.resolve({
    ok: true,
    degraded: false,
    demo: true,
    externalId: `${provider.toLowerCase()}-demo-${Math.floor(Math.random() * 9000) + 1000}`,
    message: "Demo stub — nothing was sent to a live system",
  });
}

function stubCrm(provider: string, leads: Array<Omit<ExternalLead, "provider" | "demo">>): (config: ConnectorConfig) => CrmOps {
  return () => ({
    async pullLeads(): Promise<PullResult<ExternalLead>> {
      return {
        ok: true,
        degraded: false,
        demo: true,
        records: leads.map((l) => ({ ...l, provider, demo: true })),
      };
    },
    pushActivity: () => demoPush(provider),
    upsertContact: () => demoPush(provider),
  });
}

function stubAccounting(provider: string): (config: ConnectorConfig) => AccountingOps {
  return () => ({
    pushInvoice: () => demoPush(provider),
    pushPayment: () => demoPush(provider),
  });
}

function stubMessaging(provider: string): (config: ConnectorConfig) => MessagingOps {
  return () => ({
    sendSms: () => demoPush(provider),
    sendEmail: () => demoPush(provider),
  });
}

function stubJobs(provider: string, jobs: Array<Omit<ExternalJob, "provider" | "demo">>): (config: ConnectorConfig) => JobsOps {
  return () => ({
    async pullJobs(): Promise<PullResult<ExternalJob>> {
      return {
        ok: true,
        degraded: false,
        demo: true,
        records: jobs.map((j) => ({ ...j, provider, demo: true })),
      };
    },
  });
}

function stubPm(provider: string): (config: ConnectorConfig) => PmOps {
  return () => ({
    pushTask: () => demoPush(provider),
  });
}

type StubSpec = {
  descriptor: ConnectorDescriptor;
  crmLeads?: Array<Omit<ExternalLead, "provider" | "demo">>;
  jobRecords?: Array<Omit<ExternalJob, "provider" | "demo">>;
};

function makeStub(spec: StubSpec): Connector {
  const { descriptor } = spec;
  const conn: Connector = {
    descriptor,
    health: (config) => stubHealth(descriptor, config),
  };
  if (descriptor.capabilities.includes("crm")) conn.crm = stubCrm(descriptor.provider, spec.crmLeads ?? []);
  if (descriptor.capabilities.includes("accounting")) conn.accounting = stubAccounting(descriptor.provider);
  if (descriptor.capabilities.includes("messaging")) conn.messaging = stubMessaging(descriptor.provider);
  if (descriptor.capabilities.includes("jobs")) conn.jobs = stubJobs(descriptor.provider, spec.jobRecords ?? []);
  if (descriptor.capabilities.includes("pm")) conn.pm = stubPm(descriptor.provider);
  return conn;
}

const apiKeyField = (placeholder: string) =>
  ({ key: "apiKey", label: "API key", kind: "password", placeholder, required: true }) as const;

// ── Registry ─────────────────────────────────────────────────────────────────

export const REGISTRY: Record<string, Connector> = {
  // CRM — Odoo is the real implementation.
  ODOO: odooConnector,

  // CRM — HubSpot is a real CRM v3 REST implementation.
  HUBSPOT: hubspotConnector,

  SALESFORCE: makeStub({
    descriptor: {
      provider: "SALESFORCE",
      label: "Salesforce",
      emoji: "☁️",
      capabilities: ["crm"],
      blurb: "CRM — enterprise pipeline sync",
      configFields: [
        { key: "instanceUrl", label: "Instance URL", kind: "url", placeholder: "https://mycompany.my.salesforce.com", required: true },
        apiKeyField("Connected-app access token"),
      ],
    },
    crmLeads: [
      { externalId: "sf-00Q5e01", title: "Repipe quote — 40-unit complex", contactName: "Priya Raman", phone: "555-0177", email: "praman@example.com", expectedRevenueCents: 4200000, stage: "Working" },
    ],
  }),

  GOHIGHLEVEL: makeStub({
    descriptor: {
      provider: "GOHIGHLEVEL",
      label: "GoHighLevel",
      emoji: "📈",
      capabilities: ["crm"],
      blurb: "CRM — agency funnels, pipelines & follow-up automation",
      configFields: [
        { key: "locationId", label: "Location ID", kind: "text", placeholder: "ve9EPM428h8vShlRW1KT", required: true },
        apiKeyField("Agency/location API key"),
      ],
    },
    crmLeads: [
      { externalId: "ghl-7742", title: "Sewer camera inspection request", contactName: "Marcus Bell", phone: "555-0188", expectedRevenueCents: 35000, stage: "New inquiry" },
    ],
  }),

  // Accounting — QuickBooks Online is a real Accounting API v3 implementation.
  QUICKBOOKS: quickbooksConnector,

  // Procurement — real cXML 1.2 punchout handshake (supplier-agnostic).
  CXML_SUPPLIER: cxmlSupplierConnector,

  // Calendars (D2) — real Google Calendar v3 + Microsoft Graph implementations.
  GOOGLE_CALENDAR: googleCalendarConnector,
  OUTLOOK_CALENDAR: outlookCalendarConnector,

  // Maps & routing (D3) — real Geocoding + Routes API implementation.
  GOOGLE_MAPS: googleMapsConnector,

  XERO: makeStub({
    descriptor: {
      provider: "XERO",
      label: "Xero",
      emoji: "🔵",
      capabilities: ["accounting"],
      blurb: "Accounting — invoices & payments sync",
      configFields: [
        { key: "tenantId", label: "Tenant ID", kind: "text", placeholder: "xero tenant GUID", required: true },
        apiKeyField("OAuth access token"),
      ],
    },
  }),

  // Job apps
  JOBBER: makeStub({
    descriptor: {
      provider: "JOBBER",
      label: "Jobber",
      emoji: "🧰",
      capabilities: ["jobs"],
      blurb: "Field service — pull jobs & visits from your existing Jobber account",
      configFields: [apiKeyField("Jobber API token")],
    },
    jobRecords: [
      { externalId: "job-5501", title: "Annual boiler service — Hartley residence", status: "scheduled", customerName: "J. Hartley", scheduledAt: "2026-07-21T13:00:00Z", address: "18 Birchwood Ln" },
    ],
  }),

  SERVICETITAN: makeStub({
    descriptor: {
      provider: "SERVICETITAN",
      label: "ServiceTitan",
      emoji: "🛠️",
      capabilities: ["jobs"],
      blurb: "Field service — read jobs/dispatch from ServiceTitan",
      configFields: [
        { key: "tenantId", label: "Tenant ID", kind: "text", placeholder: "123456789", required: true },
        apiKeyField("App key + access token"),
      ],
    },
    jobRecords: [
      { externalId: "st-88213", title: "No-heat call — rooftop unit 4", status: "dispatched", customerName: "Grandview Plaza", scheduledAt: "2026-07-18T15:30:00Z", address: "400 Grandview Ave" },
    ],
  }),

  HOUSECALL_PRO: makeStub({
    descriptor: {
      provider: "HOUSECALL_PRO",
      label: "Housecall Pro",
      emoji: "🏠",
      capabilities: ["jobs"],
      blurb: "Field service — pull scheduled jobs from Housecall Pro",
      configFields: [apiKeyField("Housecall Pro API key")],
    },
    jobRecords: [
      { externalId: "hcp-2210", title: "Garbage disposal replacement", status: "scheduled", customerName: "T. Nguyen", scheduledAt: "2026-07-19T17:00:00Z", address: "77 Elm Ct" },
    ],
  }),

  // Messaging
  // Messaging — Twilio is a real Messages API implementation (SMS-only).
  TWILIO: twilioConnector,

  EMAIL: makeStub({
    descriptor: {
      provider: "EMAIL",
      label: "Email (SMTP)",
      emoji: "✉️",
      capabilities: ["messaging"],
      blurb: "Outbound email — estimates, invoices & follow-ups via your SMTP relay",
      configFields: [
        { key: "host", label: "SMTP host", kind: "text", placeholder: "smtp.mailgun.org", required: true },
        { key: "fromAddress", label: "From address", kind: "text", placeholder: "office@yourcompany.com", required: true },
        { key: "password", label: "SMTP password", kind: "password", placeholder: "app password", required: true },
      ],
    },
  }),

  SLACK: makeStub({
    descriptor: {
      provider: "SLACK",
      label: "Slack",
      emoji: "💠",
      capabilities: ["messaging"],
      blurb: "Team messaging — post job & lead alerts to channels",
      configFields: [
        { key: "webhookUrl", label: "Incoming webhook URL", kind: "url", placeholder: "https://hooks.slack.com/services/…", required: true },
      ],
    },
  }),

  // PM
  PROCORE: makeStub({
    descriptor: {
      provider: "PROCORE",
      label: "Procore",
      emoji: "🏗️",
      capabilities: ["pm"],
      blurb: "Construction PM — push punch-list tasks to Procore projects",
      configFields: [
        { key: "companyId", label: "Company ID", kind: "text", placeholder: "562949953425469", required: true },
        apiKeyField("OAuth access token"),
      ],
    },
  }),

  ASANA: makeStub({
    descriptor: {
      provider: "ASANA",
      label: "Asana",
      emoji: "🎯",
      capabilities: ["pm"],
      blurb: "Project management — push tasks to Asana projects",
      configFields: [
        { key: "projectGid", label: "Project GID", kind: "text", placeholder: "1200000000000000", required: true },
        apiKeyField("Personal access token"),
      ],
    },
  }),
};

// ── Helpers ──────────────────────────────────────────────────────────────────

export function getConnector(provider: string): Connector | undefined {
  return REGISTRY[provider];
}

const CAPABILITY_ORDER: ConnectorCapability[] = ["crm", "accounting", "calendar", "geo", "procurement", "jobs", "messaging", "pm"];

/** Registry grouped by capability, in hub display order (CRM first — required). */
export function listByCapability(): Array<{ capability: ConnectorCapability; connectors: Connector[] }> {
  return CAPABILITY_ORDER.map((capability) => ({
    capability,
    connectors: Object.values(REGISTRY).filter((c) => c.descriptor.capabilities.includes(capability)),
  })).filter((g) => g.connectors.length > 0);
}
