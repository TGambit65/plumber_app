import "server-only";
import type {
  Connector,
  ConnectorConfig,
  ConnectorHealth,
  CrmOps,
  ExternalActivity,
  ExternalContact,
  ExternalLead,
  PullResult,
  PushResult,
} from "./types";
import { missingRequiredFields } from "./types";

/**
 * HubSpot CRM connector — REAL implementation against the CRM v3/v4 REST API
 * (private-app bearer token).
 *
 *   health         GET  /crm/v3/objects/contacts?limit=1
 *   pullLeads      POST /crm/v3/objects/deals/search        (hs_lastmodifieddate ≥ since)
 *                  POST /crm/v4/associations/deal/contact/batch/read
 *                  POST /crm/v3/objects/contacts/batch/read
 *   upsertContact  POST /crm/v3/objects/contacts/search     (dedupe by email)
 *                  POST /crm/v3/objects/contacts | PATCH /crm/v3/objects/contacts/{id}
 *   pushActivity   POST /crm/v3/objects/notes                (associated to the deal,
 *                  HUBSPOT_DEFINED association type 214 = note→deal)
 *
 * `baseUrl` is configurable (default https://api.hubapi.com) so API-compatible
 * proxies/sandboxes work. Deal `amount` is a decimal string → integer cents at
 * the boundary. Failures degrade LOUDLY (message + console.error), mirroring
 * the Odoo connector (constraint 2 — never silent).
 */

const PROVIDER = "HUBSPOT";
const TIMEOUT_MS = 6000;
const DEFAULT_BASE = "https://api.hubapi.com";

type HsConfig = { baseUrl: string; apiKey: string };

function readConfig(config: ConnectorConfig): HsConfig | null {
  const apiKey = (config.apiKey ?? "").trim();
  const baseUrl = ((config.baseUrl ?? "").trim() || DEFAULT_BASE).replace(/\/+$/, "");
  if (!apiKey) return null;
  return { baseUrl, apiKey };
}

function degrade(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[Connector hubspot DEGRADED] ${msg}`);
  return msg;
}

/** Authenticated JSON call; throws with a descriptive message on any non-2xx. */
async function hs(cfg: HsConfig, method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${cfg.apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) {
    let detail = "";
    try {
      const j = (await res.json()) as { message?: string };
      detail = j.message ? `: ${j.message}` : "";
    } catch {
      /* non-JSON error body */
    }
    if (res.status === 401) throw new Error(`HubSpot ${path} → 401 unauthorized (check private-app token)${detail}`);
    if (res.status === 429) throw new Error(`HubSpot ${path} → 429 rate-limited${detail}`);
    throw new Error(`HubSpot ${method} ${path} → HTTP ${res.status}${detail}`);
  }
  return res.json();
}

type HsObject = { id: string; properties: Record<string, string | null> };

class HubSpotCrmOps implements CrmOps {
  constructor(private cfg: HsConfig) {}

  /** Deals (HubSpot's pipeline records) mapped to ExternalLead, with the
   *  primary associated contact resolved via batch association + batch read. */
  async pullLeads(since?: Date): Promise<PullResult<ExternalLead>> {
    try {
      const search = (await hs(this.cfg, "POST", "/crm/v3/objects/deals/search", {
        filterGroups: since
          ? [{ filters: [{ propertyName: "hs_lastmodifieddate", operator: "GTE", value: String(since.getTime()) }] }]
          : [],
        properties: ["dealname", "amount", "dealstage"],
        sorts: [{ propertyName: "hs_lastmodifieddate", direction: "DESCENDING" }],
        limit: 100,
      })) as { results?: HsObject[] };
      const deals = search.results ?? [];
      if (deals.length === 0) return { ok: true, degraded: false, records: [] };

      // deal → primary contact id (v4 batch association read)
      const assoc = (await hs(this.cfg, "POST", "/crm/v4/associations/deal/contact/batch/read", {
        inputs: deals.map((d) => ({ id: d.id })),
      })) as { results?: Array<{ from: { id: string }; to: Array<{ toObjectId: number | string }> }> };
      const contactIdByDeal = new Map<string, string>();
      for (const r of assoc.results ?? []) {
        const first = r.to?.[0]?.toObjectId;
        if (first != null) contactIdByDeal.set(r.from.id, String(first));
      }

      // batch-read the contacts we actually need
      const contactIds = Array.from(new Set(contactIdByDeal.values()));
      const contactById = new Map<string, HsObject>();
      if (contactIds.length > 0) {
        const contacts = (await hs(this.cfg, "POST", "/crm/v3/objects/contacts/batch/read", {
          inputs: contactIds.map((id) => ({ id })),
          properties: ["firstname", "lastname", "email", "phone"],
        })) as { results?: HsObject[] };
        for (const c of contacts.results ?? []) contactById.set(c.id, c);
      }

      const records: ExternalLead[] = deals.map((d) => {
        const contact = contactById.get(contactIdByDeal.get(d.id) ?? "");
        const p = contact?.properties ?? {};
        const contactName = [p.firstname, p.lastname].filter(Boolean).join(" ").trim();
        const amount = d.properties.amount ? Number(d.properties.amount) : NaN;
        return {
          provider: PROVIDER,
          externalId: d.id,
          title: d.properties.dealname || `HubSpot deal #${d.id}`,
          contactName: contactName || d.properties.dealname || "Unknown contact",
          phone: p.phone || undefined,
          email: p.email || undefined,
          // amount is a decimal string in portal currency → integer cents.
          expectedRevenueCents: Number.isFinite(amount) ? Math.round(amount * 100) : undefined,
          stage: d.properties.dealstage || undefined,
        };
      });
      return { ok: true, degraded: false, records };
    } catch (err) {
      return { ok: false, degraded: true, records: [], message: degrade(err) };
    }
  }

  /** Create-or-update a contact, deduped by exact email match. */
  async upsertContact(c: ExternalContact): Promise<PushResult> {
    try {
      const properties: Record<string, string> = { ...splitName(c.name) };
      if (c.email) properties.email = c.email;
      if (c.phone) properties.phone = c.phone;
      if (c.company) properties.company = c.company;

      let targetId = c.externalId;
      if (!targetId && c.email) {
        const found = (await hs(this.cfg, "POST", "/crm/v3/objects/contacts/search", {
          filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: c.email }] }],
          properties: ["email"],
          limit: 1,
        })) as { results?: HsObject[] };
        targetId = found.results?.[0]?.id;
      }

      if (targetId) {
        const updated = (await hs(this.cfg, "PATCH", `/crm/v3/objects/contacts/${targetId}`, { properties })) as HsObject;
        return { ok: true, degraded: false, externalId: updated.id ?? targetId };
      }
      const created = (await hs(this.cfg, "POST", "/crm/v3/objects/contacts", { properties })) as HsObject;
      return { ok: true, degraded: false, externalId: created.id };
    } catch (err) {
      return { ok: false, degraded: true, message: degrade(err) };
    }
  }

  /** Log a note on the deal's timeline (association type 214 = note→deal). */
  async pushActivity(a: ExternalActivity): Promise<PushResult> {
    if (!a.relatedExternalId) {
      const message = "HubSpot pushActivity requires relatedExternalId (the deal id to attach the note to)";
      console.error(`[Connector hubspot DEGRADED] ${message}`);
      return { ok: false, degraded: false, message };
    }
    try {
      const body = a.subject ? `<b>${a.subject}</b><br/>${a.body}` : a.body;
      const created = (await hs(this.cfg, "POST", "/crm/v3/objects/notes", {
        properties: { hs_note_body: body, hs_timestamp: new Date().toISOString() },
        associations: [
          {
            to: { id: a.relatedExternalId },
            types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 214 }],
          },
        ],
      })) as HsObject;
      return { ok: true, degraded: false, externalId: created.id };
    } catch (err) {
      return { ok: false, degraded: true, message: degrade(err) };
    }
  }
}

/** "Dana Whitfield" → { firstname: "Dana", lastname: "Whitfield" }. */
function splitName(name: string): { firstname: string; lastname: string } {
  const parts = name.trim().split(/\s+/);
  return { firstname: parts[0] ?? "", lastname: parts.slice(1).join(" ") };
}

export const hubspotConnector: Connector = {
  descriptor: {
    provider: PROVIDER,
    label: "HubSpot",
    emoji: "🟠",
    capabilities: ["crm"],
    blurb: "HubSpot CRM — pull deals + contacts, push contacts & timeline notes (CRM v3 REST, private-app token)",
    configFields: [
      { key: "apiKey", label: "Private app token", kind: "password", placeholder: "pat-na1-…", required: true },
      { key: "baseUrl", label: "API base URL (optional)", kind: "url", placeholder: DEFAULT_BASE },
    ],
  },

  async health(config: ConnectorConfig): Promise<ConnectorHealth> {
    const missing = missingRequiredFields(hubspotConnector.descriptor, config);
    if (missing.length > 0) {
      return { ok: false, degraded: false, message: `Missing required field(s): ${missing.join(", ")}` };
    }
    const cfg = readConfig(config)!;
    try {
      await hs(cfg, "GET", "/crm/v3/objects/contacts?limit=1");
      return { ok: true, degraded: false, message: `Authenticated against ${cfg.baseUrl}` };
    } catch (err) {
      return { ok: false, degraded: true, message: degrade(err) };
    }
  },

  crm(config: ConnectorConfig): CrmOps {
    const cfg = readConfig(config);
    if (!cfg) {
      const message = "HubSpot connector is not configured (private app token required)";
      const fail: PushResult = { ok: false, degraded: false, message };
      return {
        async pullLeads(): Promise<PullResult<ExternalLead>> {
          console.error(`[Connector hubspot DEGRADED] ${message}`);
          return { ok: false, degraded: false, records: [], message };
        },
        async pushActivity() {
          console.error(`[Connector hubspot DEGRADED] ${message}`);
          return fail;
        },
        async upsertContact() {
          console.error(`[Connector hubspot DEGRADED] ${message}`);
          return fail;
        },
      };
    }
    return new HubSpotCrmOps(cfg);
  },
};
