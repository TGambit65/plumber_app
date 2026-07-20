import "server-only";
import type { Connector, ConnectorConfig, ConnectorHealth, PaymentsOps } from "./types";
import { missingRequiredFields } from "./types";

/**
 * Stripe payments connector — REAL implementation against the Stripe API
 * (Bearer secret key, form-encoded).
 *
 *   health           GET  /v1/balance
 *   createCheckout   POST /v1/checkout/sessions  (mode=payment, line_items,
 *                        success_url, cancel_url, client_reference_id)
 *
 * The customer pays on Stripe's hosted page; the signed webhook
 * (/api/webhooks/stripe/[org], Stripe-Signature HMAC-SHA256) records the
 * payment. `baseUrl` is configurable (default https://api.stripe.com) so
 * API-compatible mocks work. Failures degrade LOUDLY (constraint 2).
 */

const PROVIDER = "STRIPE";
const TIMEOUT_MS = 8000;
const DEFAULT_BASE = "https://api.stripe.com";

type StripeConfig = { baseUrl: string; apiKey: string; webhookSecret: string };

function readConfig(config: ConnectorConfig): StripeConfig | null {
  const apiKey = (config.apiKey ?? "").trim();
  const webhookSecret = (config.webhookSecret ?? "").trim();
  const baseUrl = ((config.baseUrl ?? "").trim() || DEFAULT_BASE).replace(/\/+$/, "");
  if (!apiKey) return null;
  return { baseUrl, apiKey, webhookSecret };
}

function degrade(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[Connector stripe DEGRADED] ${msg}`);
  return msg;
}

async function stripeRequest(
  cfg: StripeConfig,
  method: "GET" | "POST",
  path: string,
  form?: Record<string, string>
): Promise<Record<string, unknown>> {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${cfg.apiKey}`,
      accept: "application/json",
      ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = (json.error ?? {}) as Record<string, unknown>;
    const detail = typeof err.message === "string" ? `: ${err.message}` : "";
    if (res.status === 401) throw new Error(`Stripe ${path} → 401 unauthorized (check secret key)${detail}`);
    throw new Error(`Stripe ${method} ${path} → HTTP ${res.status}${detail}`);
  }
  return json;
}

export const stripeConnector: Connector = {
  descriptor: {
    provider: PROVIDER,
    label: "Stripe",
    emoji: "💳",
    capabilities: ["payments"],
    blurb: "Online payments — customers pay invoices from their phone (Stripe Checkout)",
    configFields: [
      { key: "apiKey", label: "Secret key", kind: "password", placeholder: "sk_live_…", required: true },
      { key: "webhookSecret", label: "Webhook signing secret", kind: "password", placeholder: "whsec_…", required: true },
      { key: "baseUrl", label: "API base URL (optional)", kind: "url", placeholder: DEFAULT_BASE },
    ],
  },

  async health(config: ConnectorConfig): Promise<ConnectorHealth> {
    const missing = missingRequiredFields(stripeConnector.descriptor, config);
    if (missing.length > 0) {
      return { ok: false, degraded: false, message: `Missing required field(s): ${missing.join(", ")}` };
    }
    const cfg = readConfig(config)!;
    try {
      const bal = await stripeRequest(cfg, "GET", "/v1/balance");
      const live = bal.livemode === true;
      return { ok: true, degraded: false, message: `Authenticated (${live ? "live" : "test"} mode)` };
    } catch (err) {
      return { ok: false, degraded: true, message: degrade(err) };
    }
  },

  payments(config: ConnectorConfig): PaymentsOps {
    const cfg = readConfig(config);
    return {
      async createCheckoutSession(params) {
        if (!cfg) {
          const message = "Stripe connector is not configured (secret key required)";
          console.error(`[Connector stripe DEGRADED] ${message}`);
          return { ok: false, degraded: false, message };
        }
        try {
          const form: Record<string, string> = {
            mode: "payment",
            "line_items[0][quantity]": "1",
            "line_items[0][price_data][currency]": params.currency ?? "usd",
            "line_items[0][price_data][unit_amount]": String(params.amountCents),
            "line_items[0][price_data][product_data][name]": params.description,
            success_url: params.successUrl,
            cancel_url: params.cancelUrl,
            client_reference_id: params.reference,
          };
          if (params.customerEmail) form.customer_email = params.customerEmail;
          const session = await stripeRequest(cfg, "POST", "/v1/checkout/sessions", form);
          const url = typeof session.url === "string" ? session.url : undefined;
          const sessionId = typeof session.id === "string" ? session.id : undefined;
          if (!url) throw new Error("Stripe checkout session came back without a URL");
          return { ok: true, degraded: false, url, sessionId };
        } catch (err) {
          return { ok: false, degraded: true, message: degrade(err) };
        }
      },
    };
  },
};
