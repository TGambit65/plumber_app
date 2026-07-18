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
 * Google Calendar connector — REAL implementation against Calendar API v3
 * (dispatch D2).
 *
 *   token     POST {tokenUrl}                 refresh_token grant → access_token
 *   health    GET  /calendar/v3/calendars/{id}
 *   upsert    POST /calendar/v3/calendars/{id}/events
 *             PATCH /calendar/v3/calendars/{id}/events/{eventId}
 *   delete    DELETE /calendar/v3/calendars/{id}/events/{eventId}
 *   busy      POST /calendar/v3/freeBusy      (items: [{id: calendarId}])
 *
 * Auth: OAuth 2.0 offline refresh token (obtainable from any OAuth consent
 * flow or the OAuth playground). The client exchanges it per-instance and
 * caches the access token until expiry. `baseUrl`/`tokenUrl` are overridable
 * so vendor-shaped mocks can drive tests. Failures degrade LOUDLY.
 */

const PROVIDER = "GOOGLE_CALENDAR";
const TIMEOUT_MS = 8000;
const DEFAULT_BASE = "https://www.googleapis.com";
const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";

type GcalConfig = {
  baseUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  calendarId: string;
};

function readConfig(config: ConnectorConfig): GcalConfig | null {
  const clientId = (config.clientId ?? "").trim();
  const clientSecret = (config.clientSecret ?? "").trim();
  const refreshToken = (config.refreshToken ?? "").trim();
  const calendarId = (config.calendarId ?? "").trim() || "primary";
  const baseUrl = ((config.baseUrl ?? "").trim() || DEFAULT_BASE).replace(/\/+$/, "");
  const tokenUrl = ((config.tokenUrl ?? "").trim() || DEFAULT_TOKEN_URL).replace(/\/+$/, "");
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { baseUrl, tokenUrl, clientId, clientSecret, refreshToken, calendarId };
}

function degrade(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[Connector google-calendar DEGRADED] ${msg}`);
  return msg;
}

class GcalClient implements CalendarOps {
  private token?: { value: string; expires: number };

  constructor(private cfg: GcalConfig) {}

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
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !json.access_token) {
      throw new Error(`Google token refresh → HTTP ${res.status}${json.error ? `: ${json.error}` : ""}`);
    }
    this.token = { value: json.access_token, expires: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async api(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
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
      throw new Error(`Google Calendar ${method} ${path} → HTTP ${res.status}${detail}`);
    }
    return json;
  }

  private eventBody(e: ExternalCalendarEvent) {
    return {
      summary: e.title,
      location: e.location,
      description: e.description,
      start: { dateTime: e.start.toISOString() },
      end: { dateTime: e.end.toISOString() },
    };
  }

  async upsertEvent(e: ExternalCalendarEvent): Promise<PushResult> {
    const cal = encodeURIComponent(this.cfg.calendarId);
    try {
      if (e.externalId) {
        const updated = await this.api(
          "PATCH",
          `/calendar/v3/calendars/${cal}/events/${encodeURIComponent(e.externalId)}`,
          this.eventBody(e)
        );
        return { ok: true, degraded: false, externalId: (updated.id as string) ?? e.externalId };
      }
      const created = await this.api("POST", `/calendar/v3/calendars/${cal}/events`, this.eventBody(e));
      return { ok: true, degraded: false, externalId: created.id as string };
    } catch (err) {
      return { ok: false, degraded: true, message: degrade(err) };
    }
  }

  async deleteEvent(externalId: string): Promise<PushResult> {
    const cal = encodeURIComponent(this.cfg.calendarId);
    try {
      await this.api("DELETE", `/calendar/v3/calendars/${cal}/events/${encodeURIComponent(externalId)}`);
      return { ok: true, degraded: false, externalId };
    } catch (err) {
      return { ok: false, degraded: true, message: degrade(err) };
    }
  }

  async listBusy(timeMin: Date, timeMax: Date): Promise<PullResult<BusyWindow>> {
    try {
      const json = await this.api("POST", `/calendar/v3/freeBusy`, {
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        items: [{ id: this.cfg.calendarId }],
      });
      const calendars = (json.calendars ?? {}) as Record<string, { busy?: Array<{ start: string; end: string }> }>;
      const busy = calendars[this.cfg.calendarId]?.busy ?? [];
      return {
        ok: true,
        degraded: false,
        records: busy.map((b) => ({ start: new Date(b.start), end: new Date(b.end) })),
      };
    } catch (err) {
      return { ok: false, degraded: true, records: [], message: degrade(err) };
    }
  }
}

export const googleCalendarConnector: Connector = {
  descriptor: {
    provider: PROVIDER,
    label: "Google Calendar",
    emoji: "📆",
    capabilities: ["calendar"],
    blurb: "Push the dispatch schedule into Google Calendar and read busy windows back (Calendar API v3, OAuth refresh token)",
    configFields: [
      { key: "clientId", label: "OAuth client ID", kind: "text", placeholder: "…apps.googleusercontent.com", required: true },
      { key: "clientSecret", label: "OAuth client secret", kind: "password", placeholder: "GOCSPX-…", required: true },
      { key: "refreshToken", label: "Refresh token", kind: "password", placeholder: "1//…(offline consent)", required: true },
      { key: "calendarId", label: "Calendar ID", kind: "text", placeholder: "primary or team@company.com" },
      { key: "baseUrl", label: "API base URL (optional)", kind: "url", placeholder: DEFAULT_BASE },
      { key: "tokenUrl", label: "Token URL (optional)", kind: "url", placeholder: DEFAULT_TOKEN_URL },
    ],
  },

  async health(config: ConnectorConfig): Promise<ConnectorHealth> {
    const missing = missingRequiredFields(googleCalendarConnector.descriptor, config);
    if (missing.length > 0) {
      return { ok: false, degraded: false, message: `Missing required field(s): ${missing.join(", ")}` };
    }
    const cfg = readConfig(config)!;
    try {
      const client = new GcalClient(cfg);
      const cal = await client["api"]("GET", `/calendar/v3/calendars/${encodeURIComponent(cfg.calendarId)}`);
      return { ok: true, degraded: false, message: `Connected to "${(cal.summary as string) ?? cfg.calendarId}"` };
    } catch (err) {
      return { ok: false, degraded: true, message: degrade(err) };
    }
  },

  calendar(config: ConnectorConfig): CalendarOps {
    const cfg = readConfig(config);
    if (!cfg) {
      const message = "Google Calendar is not configured (client ID/secret + refresh token required)";
      const fail: PushResult = { ok: false, degraded: false, message };
      return {
        async upsertEvent() {
          console.error(`[Connector google-calendar DEGRADED] ${message}`);
          return fail;
        },
        async deleteEvent() {
          console.error(`[Connector google-calendar DEGRADED] ${message}`);
          return fail;
        },
        async listBusy(): Promise<PullResult<BusyWindow>> {
          console.error(`[Connector google-calendar DEGRADED] ${message}`);
          return { ok: false, degraded: false, records: [], message };
        },
      };
    }
    return new GcalClient(cfg);
  },
};
