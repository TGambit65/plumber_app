import "server-only";
import type {
  Connector,
  ConnectorConfig,
  ConnectorHealth,
  ExternalJob,
  JobsOps,
  PullResult,
} from "./types";
import { missingRequiredFields } from "./types";

/**
 * ServiceTitan connector — REAL implementation against the ServiceTitan v2
 * REST APIs (dispatch D5 — FSM coexistence).
 *
 *   token      POST {tokenUrl}/connect/token        (OAuth2 client-credentials)
 *   health     GET  /jpm/v2/tenant/{tenant}/jobs?pageSize=1
 *   pullJobs   GET  /jpm/v2/tenant/{tenant}/jobs?pageSize=100[&modifiedOnOrAfter=…]
 *              GET  /crm/v2/tenant/{tenant}/customers?ids=…      (batch resolve)
 *              GET  /crm/v2/tenant/{tenant}/locations?ids=…      (batch resolve)
 *
 * Every request carries BOTH `Authorization: Bearer <token>` and the
 * `ST-App-Key` header (ServiceTitan requires the app key alongside OAuth).
 * Tokens are cached in-process until ~60s before expiry.
 *
 * `baseUrl` / `tokenUrl` are configurable (defaults api/auth.servicetitan.io)
 * so the vendor-shaped mock (scripts/mock-servicetitan.mjs) exercises the
 * SAME code path in e2e tests.
 *
 * Coexistence stance: READ jobs, never write back. Failures degrade LOUDLY.
 */

const PROVIDER = "SERVICETITAN";
const TIMEOUT_MS = 8000;
const DEFAULT_API_BASE = "https://api.servicetitan.io";
const DEFAULT_TOKEN_BASE = "https://auth.servicetitan.io";

type StCfg = {
  baseUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  appKey: string;
  tenantId: string;
};

function readConfig(config: ConnectorConfig): StCfg | null {
  const clientId = (config.clientId ?? "").trim();
  const clientSecret = (config.clientSecret ?? "").trim();
  const appKey = (config.appKey ?? "").trim();
  const tenantId = (config.tenantId ?? "").trim();
  if (!clientId || !clientSecret || !appKey || !tenantId) return null;
  return {
    baseUrl: ((config.baseUrl ?? "").trim() || DEFAULT_API_BASE).replace(/\/+$/, ""),
    tokenUrl: ((config.tokenUrl ?? "").trim() || DEFAULT_TOKEN_BASE).replace(/\/+$/, ""),
    clientId,
    clientSecret,
    appKey,
    tenantId,
  };
}

function degrade(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[Connector servicetitan DEGRADED] ${msg}`);
  return msg;
}

// ── OAuth2 client-credentials with in-process cache ──────────────────────────

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getAccessToken(cfg: StCfg): Promise<string> {
  const key = `${cfg.tokenUrl}|${cfg.clientId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const res = await fetch(`${cfg.tokenUrl}/connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`ServiceTitan token endpoint → HTTP ${res.status} (check client id/secret)`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("ServiceTitan token endpoint returned no access_token");
  tokenCache.set(key, {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 900) * 1000,
  });
  return json.access_token;
}

/** Authenticated GET; throws with a descriptive message on any non-2xx. */
async function st<T>(cfg: StCfg, path: string): Promise<T> {
  const token = await getAccessToken(cfg);
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "st-app-key": cfg.appKey,
      accept: "application/json",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) {
    if (res.status === 401) throw new Error(`ServiceTitan ${path} → 401 unauthorized (token/app key rejected)`);
    if (res.status === 404) throw new Error(`ServiceTitan ${path} → 404 (check tenant id)`);
    if (res.status === 429) throw new Error(`ServiceTitan ${path} → 429 rate-limited`);
    throw new Error(`ServiceTitan GET ${path} → HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ── Wire shapes (subset we read) ─────────────────────────────────────────────

type StJob = {
  id: number;
  jobNumber?: string | null;
  summary?: string | null;
  jobStatus?: string | null;
  customerId?: number | null;
  locationId?: number | null;
  start?: string | null;
  end?: string | null;
};

type StCustomer = {
  id: number;
  name?: string | null;
  email?: string | null;
  phoneNumber?: string | null;
};

type StLocation = {
  id: number;
  address?: { street?: string | null; city?: string | null; state?: string | null; zip?: string | null } | null;
};

type StPage<T> = { data?: T[] };

async function batchByIds<T extends { id: number }>(cfg: StCfg, pathBase: string, ids: number[]): Promise<Map<number, T>> {
  const map = new Map<number, T>();
  if (ids.length === 0) return map;
  // ServiceTitan list endpoints accept a comma-separated ids filter; 50 per call.
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const page = await st<StPage<T>>(cfg, `${pathBase}?ids=${chunk.join(",")}&pageSize=${chunk.length}`);
    for (const row of page.data ?? []) map.set(row.id, row);
  }
  return map;
}

class ServiceTitanJobsOps implements JobsOps {
  constructor(private cfg: StCfg) {}

  async pullJobs(since?: Date): Promise<PullResult<ExternalJob>> {
    try {
      const tenant = this.cfg.tenantId;
      const sinceArg = since ? `&modifiedOnOrAfter=${encodeURIComponent(since.toISOString())}` : "";
      const jobsPage = await st<StPage<StJob>>(this.cfg, `/jpm/v2/tenant/${tenant}/jobs?pageSize=100${sinceArg}`);
      const jobs = jobsPage.data ?? [];
      if (jobs.length === 0) return { ok: true, degraded: false, records: [] };

      const customerIds = Array.from(new Set(jobs.map((j) => j.customerId).filter((x): x is number => x != null)));
      const locationIds = Array.from(new Set(jobs.map((j) => j.locationId).filter((x): x is number => x != null)));
      const [customers, locations] = await Promise.all([
        batchByIds<StCustomer>(this.cfg, `/crm/v2/tenant/${tenant}/customers`, customerIds),
        batchByIds<StLocation>(this.cfg, `/crm/v2/tenant/${tenant}/locations`, locationIds),
      ]);

      const records: ExternalJob[] = jobs.map((j) => {
        const customer = j.customerId != null ? customers.get(j.customerId) : undefined;
        const addr = (j.locationId != null ? locations.get(j.locationId) : undefined)?.address;
        return {
          provider: PROVIDER,
          externalId: String(j.jobNumber?.trim() || j.id),
          title: j.summary?.trim() || `ServiceTitan job #${j.jobNumber ?? j.id}`,
          status: j.jobStatus ?? undefined,
          customerName: customer?.name ?? undefined,
          customerEmail: customer?.email ?? undefined,
          customerPhone: customer?.phoneNumber ?? undefined,
          scheduledAt: j.start ?? undefined,
          scheduledEnd: j.end ?? undefined,
          address: addr?.street ?? undefined,
          city: addr?.city ?? undefined,
          state: addr?.state ?? undefined,
          zip: addr?.zip ?? undefined,
        };
      });
      return { ok: true, degraded: false, records };
    } catch (err) {
      return { ok: false, degraded: true, records: [], message: degrade(err) };
    }
  }
}

export const serviceTitanConnector: Connector = {
  descriptor: {
    provider: PROVIDER,
    label: "ServiceTitan",
    emoji: "🛠️",
    capabilities: ["jobs"],
    blurb: "ServiceTitan — live v2 API import of jobs + customers + locations (read-only, ServiceTitan stays the system of record)",
    configFields: [
      { key: "clientId", label: "Client ID", kind: "text", placeholder: "cid.abc123…", required: true },
      { key: "clientSecret", label: "Client secret", kind: "password", placeholder: "cs1.xyz…", required: true },
      { key: "appKey", label: "App key", kind: "password", placeholder: "ak1.def456…", required: true },
      { key: "tenantId", label: "Tenant ID", kind: "text", placeholder: "123456789", required: true },
      { key: "baseUrl", label: "API base URL (optional)", kind: "url", placeholder: DEFAULT_API_BASE },
      { key: "tokenUrl", label: "Auth base URL (optional)", kind: "url", placeholder: DEFAULT_TOKEN_BASE },
    ],
  },

  async health(config: ConnectorConfig): Promise<ConnectorHealth> {
    const missing = missingRequiredFields(serviceTitanConnector.descriptor, config);
    if (missing.length > 0) {
      return { ok: false, degraded: false, message: `Missing required field(s): ${missing.join(", ")}` };
    }
    const cfg = readConfig(config)!;
    try {
      await st(cfg, `/jpm/v2/tenant/${cfg.tenantId}/jobs?pageSize=1`);
      return { ok: true, degraded: false, message: `Authenticated for tenant ${cfg.tenantId}` };
    } catch (err) {
      return { ok: false, degraded: true, message: degrade(err) };
    }
  },

  jobs(config: ConnectorConfig): JobsOps {
    const cfg = readConfig(config);
    if (!cfg) {
      const message = "ServiceTitan connector is not configured (client id/secret, app key & tenant id required)";
      return {
        async pullJobs(): Promise<PullResult<ExternalJob>> {
          console.error(`[Connector servicetitan DEGRADED] ${message}`);
          return { ok: false, degraded: false, records: [], message };
        },
      };
    }
    return new ServiceTitanJobsOps(cfg);
  },
};
