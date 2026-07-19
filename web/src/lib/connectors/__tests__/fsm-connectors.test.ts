import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { jobberConnector, fetchJobberJob } from "../jobber";
import { serviceTitanConnector } from "../servicetitan";

/**
 * Integration tests for the LIVE Jobber (GraphQL) + ServiceTitan (v2 REST)
 * connector clients (dispatch D5), exercised against in-process mock servers
 * that implement the vendors' ACTUAL API shapes — auth headers, GraphQL
 * envelope, OAuth2 client-credentials handshake, ids batch filters. Auth
 * failure paths included.
 */

const JOBBER_TOKEN = "jobber-good-token";
const ST_APP_KEY = "ak1.test-app-key";
const ST_CLIENT_ID = "cid.test";
const ST_CLIENT_SECRET = "cs1.test-secret";
const ST_TENANT = "123456789";

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });
}

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

// ── Mock Jobber (GraphQL envelope, version header enforced) ──────────────────

const jbCaptured: Record<string, unknown> = {};
const jobberNode = {
  id: "Z2lkOi8vSm9iYmVyL0pvYi81NTAx",
  jobNumber: 5501,
  title: "Annual boiler service — Hartley residence",
  jobStatus: "upcoming",
  instructions: "Gate code 4411. Dog in yard.",
  startAt: "2026-07-21T13:00:00Z",
  endAt: "2026-07-21T15:00:00Z",
  client: {
    name: "J. Hartley",
    emails: [{ address: "j.hartley@example.com" }],
    phones: [{ number: "509-555-0142" }],
  },
  property: {
    address: { street: "18 Birchwood Ln", city: "Spokane", province: "WA", postalCode: "99203" },
  },
};

const jobberServer = http.createServer(async (req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "POST" || req.url !== "/api/graphql") return send(404, { message: "not found" });
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${JOBBER_TOKEN}`) return send(401, { message: "bad token" });
  if (!req.headers["x-jobber-graphql-version"]) {
    return send(200, { errors: [{ message: "X-JOBBER-GRAPHQL-VERSION header is required" }] });
  }

  const { query, variables } = JSON.parse(await readBody(req)) as { query: string; variables?: Record<string, unknown> };
  jbCaptured.lastQuery = query;
  if (query.includes("account")) return send(200, { data: { account: { name: "Plumb Zebra (Jobber)" } } });
  if (query.includes("job(id:") || query.includes("job(id ")) {
    // fetch-by-id used by the webhook
    jbCaptured.fetchedId = variables?.id;
    return send(200, { data: { job: { ...jobberNode, jobStatus: "in_progress" } } });
  }
  if (query.includes("jobs")) {
    return send(200, { data: { jobs: { nodes: [jobberNode, { id: "raw-2", title: "", jobStatus: "archived" }] } } });
  }
  return send(200, { errors: [{ message: `unhandled query: ${query.slice(0, 60)}` }] });
});

// ── Mock ServiceTitan (OAuth2 token + jpm/crm v2 REST) ───────────────────────

const stCaptured: Record<string, unknown> = {};
const stAuthServer = http.createServer(async (req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "POST" || req.url !== "/connect/token") return send(404, {});
  const params = new URLSearchParams(await readBody(req));
  stCaptured.grant = params.get("grant_type");
  if (params.get("client_id") !== ST_CLIENT_ID || params.get("client_secret") !== ST_CLIENT_SECRET) {
    return send(400, { error: "invalid_client" });
  }
  return send(200, { access_token: "st-access-token", expires_in: 900, token_type: "Bearer" });
});

const stApiServer = http.createServer((req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if ((req.headers.authorization ?? "") !== "Bearer st-access-token") return send(401, {});
  if ((req.headers["st-app-key"] ?? "") !== ST_APP_KEY) return send(401, { message: "missing ST-App-Key" });

  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === `/jpm/v2/tenant/${ST_TENANT}/jobs`) {
    stCaptured.modifiedOnOrAfter = url.searchParams.get("modifiedOnOrAfter");
    return send(200, {
      data: [
        { id: 88213, jobNumber: "88213", summary: "No-heat call — rooftop unit 4", jobStatus: "Dispatched", customerId: 301, locationId: 401, start: "2026-07-18T15:30:00Z", end: "2026-07-18T17:30:00Z" },
        { id: 88214, jobNumber: "88214", summary: "Water softener install", jobStatus: "Scheduled", customerId: 302, locationId: 402, start: "2026-07-22T16:00:00Z", end: null },
      ],
    });
  }
  if (url.pathname === `/crm/v2/tenant/${ST_TENANT}/customers`) {
    stCaptured.customerIds = url.searchParams.get("ids");
    return send(200, {
      data: [
        { id: 301, name: "Grandview Plaza", email: "facilities@grandview.example.com", phoneNumber: "509-555-0107" },
        { id: 302, name: "T. Alvarez", email: null, phoneNumber: "509-555-0188" },
      ],
    });
  }
  if (url.pathname === `/crm/v2/tenant/${ST_TENANT}/locations`) {
    stCaptured.locationIds = url.searchParams.get("ids");
    return send(200, {
      data: [
        { id: 401, address: { street: "400 Grandview Ave", city: "Spokane", state: "WA", zip: "99201" } },
        { id: 402, address: { street: "9 Larchwood Dr", city: "Spokane Valley", state: "WA", zip: "99206" } },
      ],
    });
  }
  return send(404, { message: `unhandled ${url.pathname}` });
});

let jobberBase = "";
let stAuthBase = "";
let stApiBase = "";

beforeAll(async () => {
  [jobberBase, stAuthBase, stApiBase] = await Promise.all([listen(jobberServer), listen(stAuthServer), listen(stApiServer)]);
});

afterAll(() => {
  jobberServer.close();
  stAuthServer.close();
  stApiServer.close();
});

// ── Jobber ───────────────────────────────────────────────────────────────────

describe("Jobber connector (live GraphQL client)", () => {
  const config = () => ({ apiKey: JOBBER_TOKEN, baseUrl: jobberBase });

  it("health() reports the connected account name", async () => {
    const h = await jobberConnector.health(config());
    expect(h.ok).toBe(true);
    expect(h.message).toContain("Plumb Zebra (Jobber)");
  });

  it("health() fails loudly on a bad token", async () => {
    const h = await jobberConnector.health({ apiKey: "wrong", baseUrl: jobberBase });
    expect(h.ok).toBe(false);
    expect(h.degraded).toBe(true);
    expect(h.message).toContain("401");
  });

  it("health() fails fast when unconfigured (no network call)", async () => {
    const h = await jobberConnector.health({});
    expect(h.ok).toBe(false);
    expect(h.degraded).toBe(false);
    expect(h.message).toContain("Missing required field");
  });

  it("pullJobs() maps nodes → ExternalJob with structured address + contact", async () => {
    const pull = await jobberConnector.jobs!(config()).pullJobs();
    expect(pull.ok).toBe(true);
    expect(pull.records).toHaveLength(2);
    const [job, bare] = pull.records;
    expect(job).toMatchObject({
      provider: "JOBBER",
      externalId: "5501", // human jobNumber preferred over opaque gid
      title: "Annual boiler service — Hartley residence",
      status: "upcoming",
      customerName: "J. Hartley",
      customerEmail: "j.hartley@example.com",
      customerPhone: "509-555-0142",
      scheduledAt: "2026-07-21T13:00:00Z",
      scheduledEnd: "2026-07-21T15:00:00Z",
      address: "18 Birchwood Ln",
      city: "Spokane",
      state: "WA",
      zip: "99203",
      description: "Gate code 4411. Dog in yard.",
    });
    // Node without jobNumber/title falls back to the raw id + placeholder title.
    expect(bare.externalId).toBe("raw-2");
    expect(bare.title).toContain("Jobber job");
  });

  it("pullJobs() degrades loudly on auth failure", async () => {
    const pull = await jobberConnector.jobs!({ apiKey: "wrong", baseUrl: jobberBase }).pullJobs();
    expect(pull.ok).toBe(false);
    expect(pull.degraded).toBe(true);
    expect(pull.records).toHaveLength(0);
    expect(pull.message).toContain("401");
  });

  it("fetchJobberJob() (webhook path) fetches one job by id", async () => {
    const job = await fetchJobberJob(config(), "Z2lkOi8vSm9iYmVyL0pvYi81NTAx");
    expect(job).not.toBeNull();
    expect(job!.externalId).toBe("5501");
    expect(job!.status).toBe("in_progress");
    expect(jbCaptured.fetchedId).toBe("Z2lkOi8vSm9iYmVyL0pvYi81NTAx");
  });
});

// ── ServiceTitan ─────────────────────────────────────────────────────────────

describe("ServiceTitan connector (live v2 REST client)", () => {
  const config = () => ({
    clientId: ST_CLIENT_ID,
    clientSecret: ST_CLIENT_SECRET,
    appKey: ST_APP_KEY,
    tenantId: ST_TENANT,
    baseUrl: stApiBase,
    tokenUrl: stAuthBase,
  });

  it("health() runs the client-credentials handshake and hits the jobs endpoint", async () => {
    const h = await serviceTitanConnector.health(config());
    expect(h.ok).toBe(true);
    expect(stCaptured.grant).toBe("client_credentials");
  });

  it("health() fails loudly on a bad client secret", async () => {
    const h = await serviceTitanConnector.health({ ...config(), clientId: "cid.other", clientSecret: "nope" });
    expect(h.ok).toBe(false);
    expect(h.degraded).toBe(true);
    expect(h.message).toContain("token");
  });

  it("pullJobs() joins jobs + batch customers + batch locations into ExternalJob", async () => {
    const pull = await serviceTitanConnector.jobs!(config()).pullJobs(new Date("2026-07-01T00:00:00Z"));
    expect(pull.ok).toBe(true);
    expect(pull.records).toHaveLength(2);
    expect(stCaptured.modifiedOnOrAfter).toBe("2026-07-01T00:00:00.000Z");
    expect(String(stCaptured.customerIds)).toContain("301");
    expect(String(stCaptured.locationIds)).toContain("402");
    expect(pull.records[0]).toMatchObject({
      provider: "SERVICETITAN",
      externalId: "88213",
      title: "No-heat call — rooftop unit 4",
      status: "Dispatched",
      customerName: "Grandview Plaza",
      customerPhone: "509-555-0107",
      scheduledAt: "2026-07-18T15:30:00Z",
      address: "400 Grandview Ave",
      city: "Spokane",
      state: "WA",
      zip: "99201",
    });
    expect(pull.records[1].customerName).toBe("T. Alvarez");
    expect(pull.records[1].scheduledEnd).toBeUndefined();
  });

  it("fails fast when unconfigured (no network call)", async () => {
    const h = await serviceTitanConnector.health({});
    expect(h.ok).toBe(false);
    expect(h.message).toContain("Missing required field");
    const pull = await serviceTitanConnector.jobs!({}).pullJobs();
    expect(pull.ok).toBe(false);
    expect(pull.degraded).toBe(false);
  });
});
