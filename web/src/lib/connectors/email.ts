import "server-only";
import type { Connector, ConnectorConfig, ConnectorHealth, MessagingOps, PushResult } from "./types";
import { missingRequiredFields } from "./types";

/**
 * Email connector — REAL implementation against the Mailgun Messages API
 * (HTTP basic auth `api:{key}`, form-encoded).
 *
 *   health     GET  /v3/domains/{domain}
 *   sendEmail  POST /v3/{domain}/messages   (from, to, subject, text, html)
 *
 * Email-only: sendSms fails LOUDLY (use the Twilio connector for SMS).
 * `baseUrl` is configurable (default https://api.mailgun.net) so
 * API-compatible mocks and the EU region (https://api.eu.mailgun.net) work.
 * Failures degrade LOUDLY with the provider's error message (constraint 2).
 */

const PROVIDER = "EMAIL";
const TIMEOUT_MS = 8000;
const DEFAULT_BASE = "https://api.mailgun.net";

type EmailConfig = { baseUrl: string; domain: string; apiKey: string; fromAddress: string };

function readConfig(config: ConnectorConfig): EmailConfig | null {
  const domain = (config.domain ?? "").trim();
  const apiKey = (config.apiKey ?? "").trim();
  const fromAddress = (config.fromAddress ?? "").trim();
  const baseUrl = ((config.baseUrl ?? "").trim() || DEFAULT_BASE).replace(/\/+$/, "");
  if (!domain || !apiKey || !fromAddress) return null;
  return { baseUrl, domain, apiKey, fromAddress };
}

function degrade(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[Connector email DEGRADED] ${msg}`);
  return msg;
}

async function mailgunRequest(
  cfg: EmailConfig,
  method: "GET" | "POST",
  path: string,
  form?: Record<string, string>
): Promise<Record<string, unknown>> {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`api:${cfg.apiKey}`).toString("base64")}`,
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
    if (res.status === 401) throw new Error(`Mailgun ${path} → 401 unauthorized (check API key)${detail}`);
    throw new Error(`Mailgun ${method} ${path} → HTTP ${res.status}${detail}`);
  }
  return json;
}

export const emailConnector: Connector = {
  descriptor: {
    provider: PROVIDER,
    label: "Email (Mailgun)",
    emoji: "✉️",
    capabilities: ["messaging"],
    blurb: "Outbound email — proposals, invoices & follow-ups (Mailgun Messages API)",
    configFields: [
      { key: "domain", label: "Sending domain", kind: "text", placeholder: "mg.yourcompany.com", required: true },
      { key: "fromAddress", label: "From address", kind: "text", placeholder: "Plumb Zebra <office@yourcompany.com>", required: true },
      { key: "apiKey", label: "API key", kind: "password", placeholder: "Mailgun private API key", required: true },
      { key: "baseUrl", label: "API base URL (optional)", kind: "url", placeholder: DEFAULT_BASE },
    ],
  },

  async health(config: ConnectorConfig): Promise<ConnectorHealth> {
    const missing = missingRequiredFields(emailConnector.descriptor, config);
    if (missing.length > 0) {
      return { ok: false, degraded: false, message: `Missing required field(s): ${missing.join(", ")}` };
    }
    const cfg = readConfig(config)!;
    try {
      const res = await mailgunRequest(cfg, "GET", `/v3/domains/${encodeURIComponent(cfg.domain)}`);
      const dom = (res.domain ?? {}) as Record<string, unknown>;
      const state = typeof dom.state === "string" ? dom.state : "active";
      return { ok: true, degraded: false, message: `Domain ${cfg.domain} verified (${state})` };
    } catch (err) {
      return { ok: false, degraded: true, message: degrade(err) };
    }
  },

  messaging(config: ConnectorConfig): MessagingOps {
    const cfg = readConfig(config);
    const notConfigured: PushResult = {
      ok: false,
      degraded: false,
      message: "Email connector is not configured (sending domain, from address, API key required)",
    };
    return {
      async sendSms(): Promise<PushResult> {
        // Email-only — fail loudly instead of pretending (constraint 2).
        const message = "Email connector is email-only; connect Twilio for SMS";
        console.error(`[Connector email DEGRADED] ${message}`);
        return { ok: false, degraded: false, message };
      },
      async sendEmail(to: string, subject: string, body: string): Promise<PushResult> {
        if (!cfg) {
          console.error(`[Connector email DEGRADED] ${notConfigured.message}`);
          return notConfigured;
        }
        try {
          const msg = await mailgunRequest(cfg, "POST", `/v3/${encodeURIComponent(cfg.domain)}/messages`, {
            from: cfg.fromAddress,
            to,
            subject,
            text: body,
          });
          const id = typeof msg.id === "string" ? msg.id : undefined;
          return { ok: true, degraded: false, externalId: id };
        } catch (err) {
          return { ok: false, degraded: true, message: degrade(err) };
        }
      },
    };
  },
};
