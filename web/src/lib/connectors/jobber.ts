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
 * Jobber connector — REAL implementation against the Jobber GraphQL API
 * (dispatch D5 — FSM coexistence).
 *
 *   health     query { account { name } }
 *   pullJobs   query { jobs(...) { nodes { ... client / property ... } } }
 *   fetchJob   query { job(id: $id) { ... } }   (used by the webhook route)
 *
 * All calls are a single POST to /api/graphql with:
 *   Authorization: Bearer <access token>
 *   X-JOBBER-GRAPHQL-VERSION: 2025-01-20
 *
 * `baseUrl` is configurable (default https://api.getjobber.com) so the
 * vendor-shaped mock server (scripts/mock-jobber.mjs) exercises the SAME
 * code path in e2e tests. `clientSecret` is stored (encrypted) purely to
 * verify X-Jobber-Hmac-SHA256 on inbound webhooks — it is never sent out.
 *
 * Coexistence stance: READ jobs from Jobber, never write back. Imported
 * records land with provenance (external_ref) via src/lib/fsm/import.ts.
 * Failures degrade LOUDLY (message + console.error), mirroring HubSpot.
 */

const PROVIDER = "JOBBER";
const TIMEOUT_MS = 8000;
const DEFAULT_BASE = "https://api.getjobber.com";
const GRAPHQL_VERSION = "2025-01-20";

type JobberCfg = { baseUrl: string; apiKey: string };

function readConfig(config: ConnectorConfig): JobberCfg | null {
  const apiKey = (config.apiKey ?? "").trim();
  const baseUrl = ((config.baseUrl ?? "").trim() || DEFAULT_BASE).replace(/\/+$/, "");
  if (!apiKey) return null;
  return { baseUrl, apiKey };
}

function degrade(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[Connector jobber DEGRADED] ${msg}`);
  return msg;
}

/** Single GraphQL POST; throws with a descriptive message on transport or GraphQL errors. */
async function gql<T>(cfg: JobberCfg, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${cfg.baseUrl}/api/graphql`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
      "x-jobber-graphql-version": GRAPHQL_VERSION,
    },
    body: JSON.stringify({ query, variables: variables ?? {} }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) {
    if (res.status === 401) throw new Error("Jobber GraphQL → 401 unauthorized (check access token)");
    if (res.status === 429) throw new Error("Jobber GraphQL → 429 rate-limited (throttled by DVCS cost)");
    throw new Error(`Jobber GraphQL → HTTP ${res.status}`);
  }
  const json = (await res.json()) as { data?: T; errors?: Array<{ message?: string }> };
  if (json.errors?.length) {
    throw new Error(`Jobber GraphQL error: ${json.errors.map((e) => e.message ?? "unknown").join("; ")}`);
  }
  if (!json.data) throw new Error("Jobber GraphQL returned no data");
  return json.data;
}

// ── Wire shapes (subset of Jobber's schema that we read) ─────────────────────

type JobberJobNode = {
  id: string;
  jobNumber?: number | string;
  title?: string | null;
  jobStatus?: string | null;
  instructions?: string | null;
  startAt?: string | null;
  endAt?: string | null;
  client?: {
    name?: string | null;
    emails?: Array<{ address?: string | null }>;
    phones?: Array<{ number?: string | null }>;
  } | null;
  property?: {
    address?: {
      street?: string | null;
      city?: string | null;
      province?: string | null;
      postalCode?: string | null;
    } | null;
  } | null;
};

const JOB_FIELDS = `
  id
  jobNumber
  title
  jobStatus
  instructions
  startAt
  endAt
  client { name emails { address } phones { number } }
  property { address { street city province postalCode } }
`;

function toExternalJob(n: JobberJobNode): ExternalJob {
  const addr = n.property?.address;
  return {
    provider: PROVIDER,
    // Prefer the human job number as the stable external id (webhooks send
    // opaque ids; jobNumber is what office staff recognize) — fall back to id.
    externalId: String(n.jobNumber ?? n.id),
    title: n.title?.trim() || `Jobber job #${n.jobNumber ?? n.id}`,
    status: n.jobStatus ?? undefined,
    customerName: n.client?.name ?? undefined,
    customerEmail: n.client?.emails?.[0]?.address ?? undefined,
    customerPhone: n.client?.phones?.[0]?.number ?? undefined,
    scheduledAt: n.startAt ?? undefined,
    scheduledEnd: n.endAt ?? undefined,
    address: addr?.street ?? undefined,
    city: addr?.city ?? undefined,
    state: addr?.province ?? undefined,
    zip: addr?.postalCode ?? undefined,
    description: n.instructions ?? undefined,
  };
}

class JobberJobsOps implements JobsOps {
  constructor(private cfg: JobberCfg) {}

  async pullJobs(since?: Date): Promise<PullResult<ExternalJob>> {
    try {
      const filterArg = since ? `(filter: { updatedAt: { after: "${since.toISOString()}" } }, first: 100)` : "(first: 100)";
      const data = await gql<{ jobs?: { nodes?: JobberJobNode[] } }>(
        this.cfg,
        `query PullJobs { jobs${filterArg} { nodes { ${JOB_FIELDS} } } }`
      );
      const nodes = data.jobs?.nodes ?? [];
      return { ok: true, degraded: false, records: nodes.map(toExternalJob) };
    } catch (err) {
      return { ok: false, degraded: true, records: [], message: degrade(err) };
    }
  }
}

/** Fetch ONE job by Jobber id — used by the webhook route on JOB_CREATE/JOB_UPDATE. */
export async function fetchJobberJob(config: ConnectorConfig, jobberId: string): Promise<ExternalJob | null> {
  const cfg = readConfig(config);
  if (!cfg) {
    console.error("[Connector jobber DEGRADED] fetchJobberJob called without an access token");
    return null;
  }
  try {
    const data = await gql<{ job?: JobberJobNode | null }>(
      cfg,
      `query FetchJob($id: EncodedId!) { job(id: $id) { ${JOB_FIELDS} } }`,
      { id: jobberId }
    );
    return data.job ? toExternalJob(data.job) : null;
  } catch (err) {
    degrade(err);
    return null;
  }
}

export const jobberConnector: Connector = {
  descriptor: {
    provider: PROVIDER,
    label: "Jobber",
    emoji: "🧰",
    capabilities: ["jobs"],
    blurb: "Jobber — live GraphQL import of jobs, clients & properties; webhook keeps them fresh (read-only, your Jobber stays the system of record)",
    configFields: [
      { key: "apiKey", label: "API access token", kind: "password", placeholder: "OAuth access token", required: true },
      { key: "clientSecret", label: "Client secret (webhook verification)", kind: "password", placeholder: "app client secret" },
      { key: "baseUrl", label: "API base URL (optional)", kind: "url", placeholder: DEFAULT_BASE },
    ],
  },

  async health(config: ConnectorConfig): Promise<ConnectorHealth> {
    const missing = missingRequiredFields(jobberConnector.descriptor, config);
    if (missing.length > 0) {
      return { ok: false, degraded: false, message: `Missing required field(s): ${missing.join(", ")}` };
    }
    const cfg = readConfig(config)!;
    try {
      const data = await gql<{ account?: { name?: string | null } }>(cfg, `query Health { account { name } }`);
      const name = data.account?.name?.trim();
      return { ok: true, degraded: false, message: name ? `Connected to Jobber account “${name}”` : `Authenticated against ${cfg.baseUrl}` };
    } catch (err) {
      return { ok: false, degraded: true, message: degrade(err) };
    }
  },

  jobs(config: ConnectorConfig): JobsOps {
    const cfg = readConfig(config);
    if (!cfg) {
      const message = "Jobber connector is not configured (access token required)";
      return {
        async pullJobs(): Promise<PullResult<ExternalJob>> {
          console.error(`[Connector jobber DEGRADED] ${message}`);
          return { ok: false, degraded: false, records: [], message };
        },
      };
    }
    return new JobberJobsOps(cfg);
  },
};
