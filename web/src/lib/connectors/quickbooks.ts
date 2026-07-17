import "server-only";
import type {
  AccountingOps,
  Connector,
  ConnectorConfig,
  ConnectorHealth,
  ExternalInvoice,
  ExternalPayment,
  PushResult,
} from "./types";
import { missingRequiredFields } from "./types";

/**
 * QuickBooks Online connector — REAL implementation against the QBO
 * Accounting API v3 (OAuth2 bearer + company realm).
 *
 *   health       GET  /v3/company/{realm}/companyinfo/{realm}
 *   pushInvoice  GET  /v3/company/{realm}/query?query=select … from Customer   (find)
 *                POST /v3/company/{realm}/customer                              (create if absent)
 *                POST /v3/company/{realm}/invoice
 *   pushPayment  GET  /v3/company/{realm}/query?query=select … from Invoice    (by DocNumber)
 *                POST /v3/company/{realm}/payment                               (LinkedTxn → Invoice)
 *
 * `baseUrl` is configurable: production https://quickbooks.api.intuit.com,
 * sandbox https://sandbox-quickbooks.api.intuit.com (default), or an
 * API-compatible proxy. QBO amounts are decimal — integer cents convert at
 * the boundary. Failures degrade LOUDLY, mirroring Odoo (constraint 2).
 */

const PROVIDER = "QUICKBOOKS";
const TIMEOUT_MS = 6000;
const DEFAULT_BASE = "https://sandbox-quickbooks.api.intuit.com";

type QbConfig = { baseUrl: string; realmId: string; apiKey: string };

function readConfig(config: ConnectorConfig): QbConfig | null {
  const realmId = (config.realmId ?? "").trim();
  const apiKey = (config.apiKey ?? "").trim();
  const baseUrl = ((config.baseUrl ?? "").trim() || DEFAULT_BASE).replace(/\/+$/, "");
  if (!realmId || !apiKey) return null;
  return { baseUrl, realmId, apiKey };
}

function degrade(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[Connector quickbooks DEGRADED] ${msg}`);
  return msg;
}

const centsToDecimal = (cents: number) => Math.round(cents) / 100;

/** Authenticated JSON call; throws with a descriptive message on any non-2xx. */
async function qb(cfg: QbConfig, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${cfg.baseUrl}/v3/company/${encodeURIComponent(cfg.realmId)}${path}`, {
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
      const j = (await res.json()) as { Fault?: { Error?: Array<{ Message?: string; Detail?: string }> } };
      const e = j.Fault?.Error?.[0];
      detail = e?.Message ? `: ${e.Message}${e.Detail ? ` — ${e.Detail}` : ""}` : "";
    } catch {
      /* non-JSON error body */
    }
    if (res.status === 401) throw new Error(`QuickBooks ${path} → 401 unauthorized (token expired?)${detail}`);
    if (res.status === 429) throw new Error(`QuickBooks ${path} → 429 rate-limited${detail}`);
    throw new Error(`QuickBooks ${method} ${path} → HTTP ${res.status}${detail}`);
  }
  return res.json();
}

/** QBO SQL-ish query endpoint. */
async function qbQuery<T>(cfg: QbConfig, query: string): Promise<T | undefined> {
  const json = (await qb(cfg, "GET", `/query?query=${encodeURIComponent(query)}&minorversion=73`)) as {
    QueryResponse?: Record<string, unknown>;
  };
  return json.QueryResponse as T | undefined;
}

/** Escape a string literal for a QBO query (single quotes double up). */
const q = (s: string) => s.replace(/'/g, "\\'");

type QbRef = { value: string; name?: string };
type QbCustomer = { Id: string; DisplayName: string };
type QbInvoice = { Id: string; DocNumber?: string; CustomerRef?: QbRef; Balance?: number };

class QuickBooksAccountingOps implements AccountingOps {
  constructor(private cfg: QbConfig) {}

  /** Find the customer by DisplayName, creating it if absent. */
  private async ensureCustomer(displayName: string): Promise<QbCustomer> {
    const found = await qbQuery<{ Customer?: QbCustomer[] }>(
      this.cfg,
      `select Id, DisplayName from Customer where DisplayName = '${q(displayName)}'`
    );
    const existing = found?.Customer?.[0];
    if (existing) return existing;
    const created = (await qb(this.cfg, "POST", "/customer?minorversion=73", {
      DisplayName: displayName,
    })) as { Customer?: QbCustomer };
    if (!created.Customer?.Id) throw new Error("QuickBooks customer create returned no Id");
    return created.Customer;
  }

  async pushInvoice(inv: ExternalInvoice): Promise<PushResult> {
    try {
      const customer = await this.ensureCustomer(inv.customerName);
      const created = (await qb(this.cfg, "POST", "/invoice?minorversion=73", {
        DocNumber: inv.number,
        TxnDate: inv.issuedAt?.slice(0, 10),
        CustomerRef: { value: customer.Id },
        PrivateNote: inv.memo,
        Line: [
          {
            Amount: centsToDecimal(inv.totalCents),
            DetailType: "SalesItemLineDetail",
            Description: inv.memo ?? `Invoice ${inv.number}`,
            SalesItemLineDetail: { ItemRef: { value: "1", name: "Services" } },
          },
        ],
      })) as { Invoice?: QbInvoice };
      if (!created.Invoice?.Id) throw new Error("QuickBooks invoice create returned no Id");
      return { ok: true, degraded: false, externalId: created.Invoice.Id };
    } catch (err) {
      return { ok: false, degraded: true, message: degrade(err) };
    }
  }

  async pushPayment(p: ExternalPayment): Promise<PushResult> {
    try {
      if (!p.invoiceNumber) {
        throw new Error("QuickBooks pushPayment requires invoiceNumber (payments apply to an invoice)");
      }
      const found = await qbQuery<{ Invoice?: QbInvoice[] }>(
        this.cfg,
        `select Id, DocNumber, CustomerRef, Balance from Invoice where DocNumber = '${q(p.invoiceNumber)}'`
      );
      const invoice = found?.Invoice?.[0];
      if (!invoice?.Id || !invoice.CustomerRef?.value) {
        throw new Error(`QuickBooks invoice with DocNumber '${p.invoiceNumber}' not found`);
      }
      const created = (await qb(this.cfg, "POST", "/payment?minorversion=73", {
        TotalAmt: centsToDecimal(p.amountCents),
        TxnDate: p.receivedAt?.slice(0, 10),
        CustomerRef: invoice.CustomerRef,
        PrivateNote: p.method ? `Method: ${p.method}` : undefined,
        Line: [
          {
            Amount: centsToDecimal(p.amountCents),
            LinkedTxn: [{ TxnId: invoice.Id, TxnType: "Invoice" }],
          },
        ],
      })) as { Payment?: { Id: string } };
      if (!created.Payment?.Id) throw new Error("QuickBooks payment create returned no Id");
      return { ok: true, degraded: false, externalId: created.Payment.Id };
    } catch (err) {
      return { ok: false, degraded: true, message: degrade(err) };
    }
  }
}

export const quickbooksConnector: Connector = {
  descriptor: {
    provider: PROVIDER,
    label: "QuickBooks",
    emoji: "📗",
    capabilities: ["accounting"],
    blurb: "QuickBooks Online — push invoices & applied payments (Accounting API v3, OAuth2)",
    configFields: [
      { key: "realmId", label: "Company (realm) ID", kind: "text", placeholder: "9341453888888", required: true },
      { key: "apiKey", label: "OAuth access token", kind: "password", placeholder: "Bearer token from OAuth2", required: true },
      { key: "baseUrl", label: "API base URL (optional)", kind: "url", placeholder: DEFAULT_BASE },
    ],
  },

  async health(config: ConnectorConfig): Promise<ConnectorHealth> {
    const missing = missingRequiredFields(quickbooksConnector.descriptor, config);
    if (missing.length > 0) {
      return { ok: false, degraded: false, message: `Missing required field(s): ${missing.join(", ")}` };
    }
    const cfg = readConfig(config)!;
    try {
      const info = (await qb(cfg, "GET", `/companyinfo/${encodeURIComponent(cfg.realmId)}?minorversion=73`)) as {
        CompanyInfo?: { CompanyName?: string };
      };
      const name = info.CompanyInfo?.CompanyName;
      return { ok: true, degraded: false, message: name ? `Connected to ${name}` : "Connected" };
    } catch (err) {
      return { ok: false, degraded: true, message: degrade(err) };
    }
  },

  accounting(config: ConnectorConfig): AccountingOps {
    const cfg = readConfig(config);
    if (!cfg) {
      const message = "QuickBooks connector is not configured (realmId + OAuth access token required)";
      const fail: PushResult = { ok: false, degraded: false, message };
      return {
        async pushInvoice() {
          console.error(`[Connector quickbooks DEGRADED] ${message}`);
          return fail;
        },
        async pushPayment() {
          console.error(`[Connector quickbooks DEGRADED] ${message}`);
          return fail;
        },
      };
    }
    return new QuickBooksAccountingOps(cfg);
  },
};
