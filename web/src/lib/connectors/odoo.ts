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
 * Odoo CRM connector — the REQUIRED, most complete implementation
 * (constraint 9). Speaks Odoo's external API: JSON-RPC 2.0 against
 * `${baseUrl}/jsonrpc`.
 *
 *   authenticate:  service "common", method "authenticate",
 *                  args [db, username, apiKey, {}]            → uid | false
 *   everything:    service "object", method "execute_kw",
 *                  args [db, uid, apiKey, model, method, args, kwargs]
 *
 * Every call has a 6-second AbortSignal timeout. Any failure returns a
 * degraded result carrying the error message and logs
 * `[Connector odoo DEGRADED] ...` — mirroring OrgMemoryStore.degrade
 * (constraint 2: loud, never silent).
 */

const PROVIDER = "ODOO";
const TIMEOUT_MS = 6000;

type OdooConfig = {
  baseUrl: string;
  database: string;
  username: string;
  apiKey: string;
};

function readConfig(config: ConnectorConfig): OdooConfig | null {
  const baseUrl = (config.baseUrl ?? "").trim().replace(/\/$/, "");
  const database = (config.database ?? "").trim();
  const username = (config.username ?? "").trim();
  const apiKey = (config.apiKey ?? "").trim();
  if (!baseUrl || !database || !username || !apiKey) return null;
  return { baseUrl, database, username, apiKey };
}

function degrade(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Loud log — never silently pretend an external call worked.
  console.error(`[Connector odoo DEGRADED] ${msg}`);
  return msg;
}

/** Raw JSON-RPC 2.0 call to `${baseUrl}/jsonrpc`. */
async function jsonRpc(
  cfg: OdooConfig,
  service: "common" | "object",
  method: string,
  args: unknown[]
): Promise<unknown> {
  const res = await fetch(`${cfg.baseUrl}/jsonrpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "call",
      params: { service, method, args },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Odoo ${service}.${method} → HTTP ${res.status}`);
  const json = (await res.json()) as {
    result?: unknown;
    error?: { message?: string; data?: { message?: string } };
  };
  if (json.error) {
    throw new Error(
      `Odoo ${service}.${method}: ${json.error.data?.message ?? json.error.message ?? "unknown JSON-RPC error"}`
    );
  }
  return json.result;
}

/** service "common" / method "authenticate" → numeric uid (false = bad creds). */
async function authenticate(cfg: OdooConfig): Promise<number> {
  const uid = await jsonRpc(cfg, "common", "authenticate", [
    cfg.database,
    cfg.username,
    cfg.apiKey,
    {},
  ]);
  if (typeof uid !== "number" || !uid) {
    throw new Error("Odoo authenticate: invalid credentials (uid=false)");
  }
  return uid;
}

/** service "object" / method "execute_kw" → [db, uid, apiKey, model, method, args, kwargs]. */
async function executeKw(
  cfg: OdooConfig,
  uid: number,
  model: string,
  method: string,
  args: unknown[],
  kwargs?: Record<string, unknown>
): Promise<unknown> {
  return jsonRpc(cfg, "object", "execute_kw", [
    cfg.database,
    uid,
    cfg.apiKey,
    model,
    method,
    args,
    kwargs ?? {},
  ]);
}

/** Odoo datetime domain literal: "YYYY-MM-DD HH:MM:SS" (UTC). */
function odooDateTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

type OdooLeadRow = {
  id: number;
  name: string | false;
  contact_name: string | false;
  phone: string | false;
  email_from: string | false;
  expected_revenue: number | false;
  stage_id: [number, string] | false;
};

class OdooCrmOps implements CrmOps {
  private uidPromise?: Promise<number>;

  constructor(private cfg: OdooConfig) {}

  /** Authenticate once per ops instance; retry-able after failure. */
  private uid(): Promise<number> {
    if (!this.uidPromise) {
      this.uidPromise = authenticate(this.cfg).catch((err) => {
        this.uidPromise = undefined; // allow re-auth on next call
        throw err;
      });
    }
    return this.uidPromise;
  }

  /** crm.lead search_read: id, name, contact_name, phone, email_from, expected_revenue, stage_id. */
  async pullLeads(since?: Date): Promise<PullResult<ExternalLead>> {
    try {
      const uid = await this.uid();
      const domain: unknown[] = since ? [["write_date", ">=", odooDateTime(since)]] : [];
      const rows = (await executeKw(this.cfg, uid, "crm.lead", "search_read", [domain], {
        fields: ["id", "name", "contact_name", "phone", "email_from", "expected_revenue", "stage_id"],
        limit: 200,
        order: "write_date desc",
      })) as OdooLeadRow[];

      const records: ExternalLead[] = (rows ?? []).map((r) => ({
        provider: PROVIDER,
        externalId: String(r.id),
        title: r.name || `Odoo lead #${r.id}`,
        contactName: r.contact_name || r.name || "Unknown contact",
        phone: r.phone || undefined,
        email: r.email_from || undefined,
        // Odoo expected_revenue is a decimal in company currency → integer cents.
        expectedRevenueCents:
          typeof r.expected_revenue === "number" ? Math.round(r.expected_revenue * 100) : undefined,
        stage: Array.isArray(r.stage_id) ? r.stage_id[1] : undefined,
      }));
      return { ok: true, degraded: false, records };
    } catch (err) {
      return { ok: false, degraded: true, records: [], message: degrade(err) };
    }
  }

  /** res.partner create/write, deduped by exact email match (search first). */
  async upsertContact(c: ExternalContact): Promise<PushResult> {
    try {
      const uid = await this.uid();
      const values: Record<string, unknown> = {
        name: c.name,
        email: c.email ?? false,
        phone: c.phone ?? false,
      };
      if (c.company) values.comment = `Company: ${c.company}`;

      // Resolve the target id: explicit externalId wins, else dedupe by email.
      let targetId: number | undefined = c.externalId ? Number(c.externalId) : undefined;
      if (!targetId && c.email) {
        const found = (await executeKw(
          this.cfg,
          uid,
          "res.partner",
          "search",
          [[["email", "=", c.email]]],
          { limit: 1 }
        )) as number[];
        targetId = found?.[0];
      }

      if (targetId) {
        await executeKw(this.cfg, uid, "res.partner", "write", [[targetId], values]);
        return { ok: true, degraded: false, externalId: String(targetId) };
      }
      const created = (await executeKw(this.cfg, uid, "res.partner", "create", [values])) as number;
      return { ok: true, degraded: false, externalId: String(created) };
    } catch (err) {
      return { ok: false, degraded: true, message: degrade(err) };
    }
  }

  /** crm.lead message_post — logs the activity on the lead's chatter thread. */
  async pushActivity(a: ExternalActivity): Promise<PushResult> {
    if (!a.relatedExternalId) {
      const message = "Odoo pushActivity requires relatedExternalId (the crm.lead id to post on)";
      console.error(`[Connector odoo DEGRADED] ${message}`);
      return { ok: false, degraded: false, message };
    }
    try {
      const uid = await this.uid();
      const leadId = Number(a.relatedExternalId);
      const body = a.subject ? `<b>${a.subject}</b><br/>${a.body}` : a.body;
      const messageId = (await executeKw(
        this.cfg,
        uid,
        "crm.lead",
        "message_post",
        [[leadId]],
        { body, message_type: "comment", subtype_xmlid: "mail.mt_note" }
      )) as number | number[];
      const id = Array.isArray(messageId) ? messageId[0] : messageId;
      return { ok: true, degraded: false, externalId: id != null ? String(id) : undefined };
    } catch (err) {
      return { ok: false, degraded: true, message: degrade(err) };
    }
  }
}

export const odooConnector: Connector = {
  descriptor: {
    provider: PROVIDER,
    label: "Odoo CRM",
    emoji: "🟣",
    capabilities: ["crm"],
    blurb: "Odoo CRM — pull crm.lead pipeline, push contacts & chatter activity (JSON-RPC external API)",
    configFields: [
      { key: "baseUrl", label: "Base URL", kind: "url", placeholder: "https://mycompany.odoo.com", required: true },
      { key: "database", label: "Database", kind: "text", placeholder: "mycompany", required: true },
      { key: "username", label: "Username (login email)", kind: "text", placeholder: "admin@mycompany.com", required: true },
      { key: "apiKey", label: "API key", kind: "password", placeholder: "Odoo API key (Settings → Security)", required: true },
    ],
  },

  async health(config: ConnectorConfig): Promise<ConnectorHealth> {
    const missing = missingRequiredFields(odooConnector.descriptor, config);
    if (missing.length > 0) {
      // Not configured ≠ degraded — nothing to reach yet.
      return { ok: false, degraded: false, message: `Missing required field(s): ${missing.join(", ")}` };
    }
    const cfg = readConfig(config)!;
    try {
      const uid = await authenticate(cfg);
      return { ok: true, degraded: false, message: `Authenticated as uid ${uid} on ${cfg.database}` };
    } catch (err) {
      return { ok: false, degraded: true, message: degrade(err) };
    }
  },

  crm(config: ConnectorConfig): CrmOps {
    const cfg = readConfig(config);
    if (!cfg) {
      // Unconfigured ops fail loudly (with a message) instead of throwing.
      const message = "Odoo connector is not configured (baseUrl, database, username, apiKey required)";
      const fail: PushResult = { ok: false, degraded: false, message };
      return {
        async pullLeads(): Promise<PullResult<ExternalLead>> {
          console.error(`[Connector odoo DEGRADED] ${message}`);
          return { ok: false, degraded: false, records: [], message };
        },
        async pushActivity() {
          console.error(`[Connector odoo DEGRADED] ${message}`);
          return fail;
        },
        async upsertContact() {
          console.error(`[Connector odoo DEGRADED] ${message}`);
          return fail;
        },
      };
    }
    return new OdooCrmOps(cfg);
  },
};
