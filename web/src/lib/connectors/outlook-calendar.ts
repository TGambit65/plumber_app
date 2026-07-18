import "server-only";
import type {
  BusyWindow,
  CalendarOps,
  Connector,
  ConnectorConfig,
  ConnectorHealth,
  ExternalCalendarEvent,
  PullResult,
  PushResult,
} from "./types";
import { missingRequiredFields } from "./types";

/**
 * Outlook / Microsoft 365 calendar connector — REAL implementation against
 * Microsoft Graph (dispatch D2). Same adapter shape as Google Calendar.
 *
 *   token     POST {tokenUrl}                        refresh_token grant
 *   health    GET  /v1.0/me/calendar
 *   upsert    POST /v1.0/me/calendar/events · PATCH /v1.0/me/events/{id}
 *   delete    DELETE /v1.0/me/events/{id}
 *   busy      GET  /v1.0/me/calendarView?startDateTime=…&endDateTime=…
 *
 * `baseUrl`/`tokenUrl` overridable for vendor-shaped mocks; failures LOUD.
 */

const PROVIDER = "OUTLOOK_CALENDAR";
const TIMEOUT_MS = 8000;
const DEFAULT_BASE = "https://graph.microsoft.com";
const DEFAULT_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

type GraphConfig = {
  baseUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

function readConfig(config: ConnectorConfig): GraphConfig | null {
  const clientId = (config.clientId ?? "").trim();
  const clientSecret = (config.clientSecret ?? "").trim();
  const refreshToken = (config.refreshToken ?? "").trim();
  const baseUrl = ((config.baseUrl ?? "").trim() || DEFAULT_BASE).replace(/\/+$/, "");
  const tokenUrl = ((config.tokenUrl ?? "").trim() || DEFAULT_TOKEN_URL).replace(/\/+$/, "");
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { baseUrl, tokenUrl, clientId, clientSecret, refreshToken };
}

function degrade(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[Connector outlook-calendar DEGRADED] ${msg}`);
  return msg;
}

class GraphClient implements CalendarOps {
  private token?: { value: string; expires: number };

  constructor(private cfg: GraphConfig) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 30_000) return this.token.value;
    const res = await fetch(this.cfg.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.cfg.refreshToken,
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        scope: "https://graph.microsoft.com/Calendars.ReadWrite offline_access",
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !json.access_token) {
      throw new Error(`Microsoft token refresh → HTTP ${res.status}${json.error ? `: ${json.error}` : ""}`);
    }
    this.token = { value: json.access_token, expires: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  async api(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const token = await this.accessToken();
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (res.status === 204) return {};
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
      error?: { message?: string };
    };
    if (!res.ok) {
      const detail = json.error?.message ? `: ${json.error.message}` : "";
      throw new Error(`Graph ${method} ${path} → HTTP ${res.status}${detail}`);
    }
    return json;
  }

  private eventBody(e: ExternalCalendarEvent) {
    return {
      subject: e.title,
      location: e.location ? { displayName: e.location } : undefined,
      body: e.description ? { contentType: "text", content: e.description } : undefined,
      start: { dateTime: e.start.toISOString(), timeZone: "UTC" },
      end: { dateTime: e.end.toISOString(), timeZone: "UTC" },
    };
  }

  async upsertEvent(e: ExternalCalendarEvent): Promise<PushResult> {
    try {
      if (e.externalId) {
        const updated = await this.api("PATCH", `/v1.0/me/events/${encodeURIComponent(e.externalId)}`, this.eventBody(e));
        return { ok: true, degraded: false, externalId: (updated.id as string) ?? e.externalId };
      }
      const created = await this.api("POST", `/v1.0/me/calendar/events`, this.eventBody(e));
      return { ok: true, degraded: false, externalId: created.id as string };
    } catch (err) {
      return { ok: false, degraded: true, message: degrade(err) };
    }
  }

  async deleteEvent(externalId: string): Promise<PushResult> {
    try {
      await this.api("DELETE", `/v1.0/me/events/${encodeURIComponent(externalId)}`);
      return { ok: true, degraded: false, externalId };
    } catch (err) {
      return { ok: false, degraded: true, message: degrade(err) };
    }
  }

  async listBusy(timeMin: Date, timeMax: Date): Promise<PullResult<BusyWindow>> {
    try {
      const qs = new URLSearchParams({
        startDateTime: timeMin.toISOString(),
        endDateTime: timeMax.toISOString(),
        $select: "subject,start,end,showAs",
        $top: "100",
      });
      const json = await this.api("GET", `/v1.0/me/calendarView?${qs}`);
      const value = (json.value ?? []) as Array<{
        subject?: string;
        showAs?: string;
        start?: { dateTime: string };
        end?: { dateTime: string };
      }>;
      const records: BusyWindow[] = value
        .filter((v) => v.showAs !== "free" && v.start?.dateTime && v.end?.dateTime)
        .map((v) => ({
          start: new Date(v.start!.dateTime.endsWith("Z") ? v.start!.dateTime : v.start!.dateTime + "Z"),
          end: new Date(v.end!.dateTime.endsWith("Z") ? v.end!.dateTime : v.end!.dateTime + "Z"),
          title: v.subject,
        }));
      return { ok: true, degraded: false, records };
    } catch (err) {
      return { ok: false, degraded: true, records: [], message: degrade(err) };
    }
  }
}

export const outlookCalendarConnector: Connector = {
  descriptor: {
    provider: PROVIDER,
    label: "Outlook / Microsoft 365",
    emoji: "📅",
    capabilities: ["calendar"],
    blurb: "Push the dispatch schedule into Outlook and read busy windows back (Microsoft Graph, OAuth refresh token)",
    configFields: [
      { key: "clientId", label: "App (client) ID", kind: "text", placeholder: "Azure app registration ID", required: true },
      { key: "clientSecret", label: "Client secret", kind: "password", placeholder: "Azure client secret", required: true },
      { key: "refreshToken", label: "Refresh token", kind: "password", placeholder: "OAuth refresh token (offline_access)", required: true },
      { key: "baseUrl", label: "API base URL (optional)", kind: "url", placeholder: DEFAULT_BASE },
      { key: "tokenUrl", label: "Token URL (optional)", kind: "url", placeholder: DEFAULT_TOKEN_URL },
    ],
  },

  async health(config: ConnectorConfig): Promise<ConnectorHealth> {
    const missing = missingRequiredFields(outlookCalendarConnector.descriptor, config);
    if (missing.length > 0) {
      return { ok: false, degraded: false, message: `Missing required field(s): ${missing.join(", ")}` };
    }
    const cfg = readConfig(config)!;
    try {
      const client = new GraphClient(cfg);
      const cal = await client.api("GET", `/v1.0/me/calendar`);
      return { ok: true, degraded: false, message: `Connected to "${(cal.name as string) ?? "calendar"}"` };
    } catch (err) {
      return { ok: false, degraded: true, message: degrade(err) };
    }
  },

  calendar(config: ConnectorConfig): CalendarOps {
    const cfg = readConfig(config);
    if (!cfg) {
      const message = "Outlook calendar is not configured (client ID/secret + refresh token required)";
      const fail: PushResult = { ok: false, degraded: false, message };
      return {
        async upsertEvent() {
          console.error(`[Connector outlook-calendar DEGRADED] ${message}`);
          return fail;
        },
        async deleteEvent() {
          console.error(`[Connector outlook-calendar DEGRADED] ${message}`);
          return fail;
        },
        async listBusy(): Promise<PullResult<BusyWindow>> {
          console.error(`[Connector outlook-calendar DEGRADED] ${message}`);
          return { ok: false, degraded: false, records: [], message };
        },
      };
    }
    return new GraphClient(cfg);
  },
};
