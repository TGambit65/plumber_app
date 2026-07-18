import "server-only";
import type { Connector, ConnectorConfig, ConnectorHealth, MessagingOps, PushResult } from "./types";
import { missingRequiredFields } from "./types";

/**
 * Twilio SMS connector — REAL implementation against the Twilio Messages API
 * (2010-04-01, HTTP basic auth AccountSid:AuthToken, form-encoded).
 *
 *   health   GET  /2010-04-01/Accounts/{sid}.json
 *   sendSms  POST /2010-04-01/Accounts/{sid}/Messages.json  (To, From, Body)
 *
 * SMS-only: sendEmail fails LOUDLY rather than pretending (use the EMAIL/SMTP
 * connector for email). `baseUrl` is configurable (default
 * https://api.twilio.com) so API-compatible mocks/regional edges work.
 * Failures degrade LOUDLY with the Twilio error message (constraint 2).
 */

const PROVIDER = "TWILIO";
const TIMEOUT_MS = 8000;
const DEFAULT_BASE = "https://api.twilio.com";

type TwilioConfig = { baseUrl: string; accountSid: string; authToken: string; fromNumber: string };

function readConfig(config: ConnectorConfig): TwilioConfig | null {
  const accountSid = (config.accountSid ?? "").trim();
  const authToken = (config.apiKey ?? "").trim(); // descriptor's password field
  const fromNumber = (config.fromNumber ?? "").trim();
  const baseUrl = ((config.baseUrl ?? "").trim() || DEFAULT_BASE).replace(/\/+$/, "");
  if (!accountSid || !authToken || !fromNumber) return null;
  return { baseUrl, accountSid, authToken, fromNumber };
}

function degrade(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[Connector twilio DEGRADED] ${msg}`);
  return msg;
}

async function twilioRequest(
  cfg: TwilioConfig,
  method: "GET" | "POST",
  path: string,
  form?: Record<string, string>
): Promise<Record<string, unknown>> {
  const res = await fetch(`${cfg.baseUrl}/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}${path}`, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64")}`,
      accept: "application/json",
      ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const detail = typeof json.message === "string" ? `: ${json.message}` : "";
    if (res.status === 401) throw new Error(`Twilio ${path} → 401 unauthorized (check SID/auth token)${detail}`);
    throw new Error(`Twilio ${method} ${path} → HTTP ${res.status}${detail}`);
  }
  return json;
}

export const twilioConnector: Connector = {
  descriptor: {
    provider: PROVIDER,
    label: "Twilio",
    emoji: "💬",
    capabilities: ["messaging"],
    blurb: "SMS — real on-my-way texts, booking confirmations & reminders (Twilio Messages API)",
    configFields: [
      { key: "accountSid", label: "Account SID", kind: "text", placeholder: "ACxxxxxxxx", required: true },
      { key: "fromNumber", label: "From number", kind: "text", placeholder: "+15550199", required: true },
      { key: "apiKey", label: "Auth token", kind: "password", placeholder: "Twilio auth token", required: true },
      { key: "baseUrl", label: "API base URL (optional)", kind: "url", placeholder: DEFAULT_BASE },
    ],
  },

  async health(config: ConnectorConfig): Promise<ConnectorHealth> {
    const missing = missingRequiredFields(twilioConnector.descriptor, config);
    if (missing.length > 0) {
      return { ok: false, degraded: false, message: `Missing required field(s): ${missing.join(", ")}` };
    }
    const cfg = readConfig(config)!;
    try {
      const acct = await twilioRequest(cfg, "GET", ".json");
      const name = typeof acct.friendly_name === "string" ? acct.friendly_name : cfg.accountSid;
      return { ok: true, degraded: false, message: `Authenticated as ${name}` };
    } catch (err) {
      return { ok: false, degraded: true, message: degrade(err) };
    }
  },

  messaging(config: ConnectorConfig): MessagingOps {
    const cfg = readConfig(config);
    const notConfigured: PushResult = {
      ok: false,
      degraded: false,
      message: "Twilio connector is not configured (Account SID, from number, auth token required)",
    };
    return {
      async sendSms(to: string, body: string): Promise<PushResult> {
        if (!cfg) {
          console.error(`[Connector twilio DEGRADED] ${notConfigured.message}`);
          return notConfigured;
        }
        try {
          const msg = await twilioRequest(cfg, "POST", "/Messages.json", {
            To: to,
            From: cfg.fromNumber,
            Body: body,
          });
          const sid = typeof msg.sid === "string" ? msg.sid : undefined;
          return { ok: true, degraded: false, externalId: sid };
        } catch (err) {
          return { ok: false, degraded: true, message: degrade(err) };
        }
      },
      async sendEmail(): Promise<PushResult> {
        // SMS-only — fail loudly instead of pretending (constraint 2).
        const message = "Twilio connector is SMS-only; connect the Email (SMTP) connector for email";
        console.error(`[Connector twilio DEGRADED] ${message}`);
        return { ok: false, degraded: false, message };
      },
    };
  },
};
