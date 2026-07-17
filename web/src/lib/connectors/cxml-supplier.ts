import "server-only";
import { randomUUID } from "crypto";
import type { Connector, ConnectorConfig, ConnectorHealth, ProcurementOps } from "./types";
import { missingRequiredFields } from "./types";
import { buildSetupRequest, parseSetupResponse } from "@/lib/punchout/cxml";

/**
 * Generic cXML supplier punchout connector — REAL implementation of the
 * PunchOutSetupRequest handshake (cXML 1.2). Works with any cXML-speaking
 * supplier (Grainger, Ferguson, Winsupply, HD Supply, …): configure the
 * supplier's punchout setup URL + NetworkID identities + shared secret.
 *
 * The cart comes back OUT-OF-BAND (supplier BrowserFormPost →
 * /api/punchout/return), so this connector only implements the setup leg.
 * Failures degrade LOUDLY (constraint 2 — never silent).
 */

const PROVIDER = "CXML_SUPPLIER";
const TIMEOUT_MS = 8000;

type CxmlConfig = {
  setupUrl: string;
  supplierName: string;
  fromIdentity: string;
  toIdentity: string;
  sharedSecret: string;
};

function readConfig(config: ConnectorConfig): CxmlConfig | null {
  const setupUrl = (config.setupUrl ?? "").trim();
  const supplierName = (config.supplierName ?? "").trim();
  const fromIdentity = (config.fromIdentity ?? "").trim();
  const toIdentity = (config.toIdentity ?? "").trim();
  const sharedSecret = (config.sharedSecret ?? "").trim();
  if (!setupUrl || !supplierName || !fromIdentity || !toIdentity || !sharedSecret) return null;
  return { setupUrl, supplierName, fromIdentity, toIdentity, sharedSecret };
}

function degrade(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[Connector cxml-supplier DEGRADED] ${msg}`);
  return msg;
}

async function postSetup(cfg: CxmlConfig, params: { buyerCookie: string; returnUrl: string; userEmail?: string }) {
  const xml = buildSetupRequest({
    buyerCookie: params.buyerCookie,
    fromIdentity: cfg.fromIdentity,
    toIdentity: cfg.toIdentity,
    sharedSecret: cfg.sharedSecret,
    returnUrl: params.returnUrl,
    payloadId: `${Date.now()}.${randomUUID()}@trade-ops`,
    timestamp: new Date().toISOString(),
    userEmail: params.userEmail,
  });
  const res = await fetch(cfg.setupUrl, {
    method: "POST",
    headers: { "content-type": "text/xml; charset=utf-8" },
    body: xml,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Supplier setup URL → HTTP ${res.status}`);
  return parseSetupResponse(await res.text());
}

export const cxmlSupplierConnector: Connector = {
  descriptor: {
    provider: PROVIDER,
    label: "Supplier punchout (cXML)",
    emoji: "🛒",
    capabilities: ["procurement"],
    blurb: "Punch out to a supplier's catalog (cXML 1.2) and pull the cart back for approval — Grainger, Ferguson, Winsupply, …",
    configFields: [
      { key: "supplierName", label: "Supplier name", kind: "text", placeholder: "Ferguson", required: true },
      { key: "setupUrl", label: "Punchout setup URL", kind: "url", placeholder: "https://punchout.supplier.com/cxml/setup", required: true },
      { key: "fromIdentity", label: "Your NetworkID identity", kind: "text", placeholder: "AN01000000001", required: true },
      { key: "toIdentity", label: "Supplier NetworkID identity", kind: "text", placeholder: "AN01000000002", required: true },
      { key: "sharedSecret", label: "Shared secret", kind: "password", placeholder: "supplier-issued secret", required: true },
    ],
  },

  async health(config: ConnectorConfig): Promise<ConnectorHealth> {
    const missing = missingRequiredFields(cxmlSupplierConnector.descriptor, config);
    if (missing.length > 0) {
      return { ok: false, degraded: false, message: `Missing required field(s): ${missing.join(", ")}` };
    }
    const cfg = readConfig(config)!;
    try {
      // A real setup handshake IS the health check — a probe cookie whose
      // StartPage we never visit.
      const result = await postSetup(cfg, { buyerCookie: `health-${randomUUID()}`, returnUrl: "https://invalid.local/health" });
      if (!result.ok) return { ok: false, degraded: true, message: degrade(result.error) };
      return { ok: true, degraded: false, message: `Punchout handshake OK with ${cfg.supplierName}` };
    } catch (err) {
      return { ok: false, degraded: true, message: degrade(err) };
    }
  },

  procurement(config: ConnectorConfig): ProcurementOps {
    const cfg = readConfig(config);
    return {
      async setupPunchout(params) {
        if (!cfg) {
          const message = "Supplier punchout is not configured (supplier, setup URL, identities, shared secret required)";
          console.error(`[Connector cxml-supplier DEGRADED] ${message}`);
          return { ok: false, degraded: false, message };
        }
        try {
          const result = await postSetup(cfg, params);
          if (!result.ok) return { ok: false, degraded: true, message: degrade(result.error) };
          return { ok: true, degraded: false, startPageUrl: result.startPageUrl };
        } catch (err) {
          return { ok: false, degraded: true, message: degrade(err) };
        }
      },
    };
  },
};
