import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { buildCalendar, escapeText, foldLine, icsDate } from "../calendar/ics";
import { overlapsBusy } from "../calendar/push";
import { googleCalendarConnector } from "../connectors/google-calendar";
import { outlookCalendarConnector } from "../connectors/outlook-calendar";

// ── ICS generator (pure) ─────────────────────────────────────────────────────

describe("ICS generator", () => {
  it("formats UTC dates and escapes text per RFC 5545", () => {
    expect(icsDate(new Date("2026-07-19T14:30:00Z"))).toBe("20260719T143000Z");
    expect(escapeText("a;b,c\nd\\e")).toBe("a\\;b\\,c\\nd\\\\e");
  });

  it("folds long lines at 75 octets with space continuations", () => {
    const folded = foldLine("X".repeat(200));
    const lines = folded.split("\r\n");
    expect(lines[0].length).toBe(75);
    expect(lines.slice(1).every((l) => l.startsWith(" ") && l.length <= 75)).toBe(true);
    expect(folded.replace(/\r\n /g, "").length).toBe(200);
  });

  it("builds a valid VCALENDAR with confirmed + cancelled VEVENTs and default duration", () => {
    const ics = buildCalendar({
      name: "Plumb Zebra — Jake",
      events: [
        {
          uid: "job-1@trade-ops",
          title: "J-1041 · Water Heater — Boyd",
          start: new Date("2026-07-19T16:00:00Z"),
          end: null,
          location: "88 Cliffside Dr, Riverton",
          description: "Status: SCHEDULED",
        },
        { uid: "job-2@trade-ops", title: "Cancelled job", start: new Date("2026-07-20T15:00:00Z"), cancelled: true },
      ],
    });
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics.match(/BEGIN:VEVENT/g)?.length).toBe(2);
    expect(ics).toContain("UID:job-1@trade-ops");
    expect(ics).toContain("DTSTART:20260719T160000Z");
    expect(ics).toContain("DTEND:20260719T180000Z"); // +120 min default
    expect(ics).toContain("STATUS:CONFIRMED");
    expect(ics).toContain("STATUS:CANCELLED");
    expect(ics).toContain("X-WR-CALNAME:Plumb Zebra — Jake");
    // CRLF line endings throughout
    expect(ics.includes("\r\n")).toBe(true);
  });
});

describe("overlapsBusy", () => {
  const win = [{ start: new Date("2026-07-19T14:00:00Z"), end: new Date("2026-07-19T15:00:00Z") }];
  it("detects overlap, containment, and clear misses (default 2h duration)", () => {
    expect(overlapsBusy(new Date("2026-07-19T14:30:00Z"), null, win)).toBe(true); // starts inside
    expect(overlapsBusy(new Date("2026-07-19T13:00:00Z"), null, win)).toBe(true); // 13:00–15:00 spans
    expect(overlapsBusy(new Date("2026-07-19T15:00:00Z"), null, win)).toBe(false); // touches, no overlap
    expect(overlapsBusy(new Date("2026-07-19T10:00:00Z"), new Date("2026-07-19T11:00:00Z"), win)).toBe(false);
    expect(overlapsBusy(null, null, win)).toBe(false);
  });
});

// ── Vendor-shaped mocks ──────────────────────────────────────────────────────

const GOOD_REFRESH = "refresh-good";
let tokenRequests = 0;
const gcalEvents: Array<Record<string, unknown>> = [];

const gcalServer = http.createServer(async (req, res) => {
  const send = (s: number, b: unknown) => {
    res.writeHead(s, { "content-type": "application/json" });
    res.end(JSON.stringify(b));
  };
  const url = new URL(req.url ?? "/", "http://x");
  let body = "";
  for await (const c of req) body += c;

  if (req.method === "POST" && url.pathname === "/token") {
    tokenRequests++;
    const p = new URLSearchParams(body);
    if (p.get("grant_type") !== "refresh_token" || p.get("refresh_token") !== GOOD_REFRESH) {
      return send(400, { error: "invalid_grant" });
    }
    return send(200, { access_token: "gcal-access-1", expires_in: 3600 });
  }

  if ((req.headers.authorization ?? "") !== "Bearer gcal-access-1") return send(401, { error: { message: "Invalid Credentials" } });

  if (req.method === "GET" && url.pathname === "/calendar/v3/calendars/dispatch%40plumbzebra.demo") {
    return send(200, { id: "dispatch@plumbzebra.demo", summary: "PZ Dispatch" });
  }
  if (req.method === "POST" && url.pathname === "/calendar/v3/calendars/dispatch%40plumbzebra.demo/events") {
    const e = JSON.parse(body);
    gcalEvents.push(e);
    return send(200, { id: `gev-${gcalEvents.length}`, ...e });
  }
  if (req.method === "PATCH" && url.pathname.startsWith("/calendar/v3/calendars/dispatch%40plumbzebra.demo/events/")) {
    const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    gcalEvents.push({ patched: id, ...JSON.parse(body) });
    return send(200, { id });
  }
  if (req.method === "POST" && url.pathname === "/calendar/v3/freeBusy") {
    return send(200, {
      calendars: {
        "dispatch@plumbzebra.demo": {
          busy: [{ start: "2026-07-19T14:00:00Z", end: "2026-07-19T15:30:00Z" }],
        },
      },
    });
  }
  send(404, { error: { message: `no route ${req.method} ${url.pathname}` } });
});

const graphEvents: Array<Record<string, unknown>> = [];
const graphServer = http.createServer(async (req, res) => {
  const send = (s: number, b: unknown) => {
    res.writeHead(s, { "content-type": "application/json" });
    res.end(JSON.stringify(b));
  };
  const url = new URL(req.url ?? "/", "http://x");
  let body = "";
  for await (const c of req) body += c;

  if (req.method === "POST" && url.pathname === "/token") {
    const p = new URLSearchParams(body);
    if (p.get("refresh_token") !== GOOD_REFRESH) return send(400, { error: "invalid_grant" });
    return send(200, { access_token: "graph-access-1", expires_in: 3600 });
  }
  if ((req.headers.authorization ?? "") !== "Bearer graph-access-1") return send(401, { error: { message: "InvalidAuthenticationToken" } });

  if (req.method === "GET" && url.pathname === "/v1.0/me/calendar") return send(200, { name: "Calendar" });
  if (req.method === "POST" && url.pathname === "/v1.0/me/calendar/events") {
    const e = JSON.parse(body);
    graphEvents.push(e);
    return send(201, { id: `oev-${graphEvents.length}`, ...e });
  }
  if (req.method === "PATCH" && url.pathname.startsWith("/v1.0/me/events/")) {
    const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    graphEvents.push({ patched: id, ...JSON.parse(body) });
    return send(200, { id });
  }
  if (req.method === "GET" && url.pathname === "/v1.0/me/calendarView") {
    return send(200, {
      value: [
        { subject: "Supplier meeting", showAs: "busy", start: { dateTime: "2026-07-19T09:00:00.0000000" }, end: { dateTime: "2026-07-19T10:00:00.0000000" } },
        { subject: "Lunch hold", showAs: "free", start: { dateTime: "2026-07-19T12:00:00.0000000" }, end: { dateTime: "2026-07-19T13:00:00.0000000" } },
      ],
    });
  }
  send(404, { error: { message: `no route ${req.method} ${url.pathname}` } });
});

let gcalBase = "";
let graphBase = "";
beforeAll(async () => {
  await new Promise<void>((r) => gcalServer.listen(0, "127.0.0.1", () => { const a = gcalServer.address(); if (a && typeof a === "object") gcalBase = `http://127.0.0.1:${a.port}`; r(); }));
  await new Promise<void>((r) => graphServer.listen(0, "127.0.0.1", () => { const a = graphServer.address(); if (a && typeof a === "object") graphBase = `http://127.0.0.1:${a.port}`; r(); }));
});
afterAll(() => { gcalServer.close(); graphServer.close(); });

const gcalConfig = () => ({
  clientId: "cid", clientSecret: "sec", refreshToken: GOOD_REFRESH,
  calendarId: "dispatch@plumbzebra.demo", baseUrl: gcalBase, tokenUrl: `${gcalBase}/token`,
});

describe("Google Calendar live connector", () => {
  it("health refreshes the token and reads the calendar", async () => {
    const h = await googleCalendarConnector.health(gcalConfig());
    expect(h.ok).toBe(true);
    expect(h.message).toContain("PZ Dispatch");
  });

  it("degrades LOUDLY on an invalid refresh token", async () => {
    const h = await googleCalendarConnector.health({ ...gcalConfig(), refreshToken: "bad" });
    expect(h.ok).toBe(false);
    expect(h.degraded).toBe(true);
    expect(h.message).toContain("token refresh");
  });

  it("upsertEvent POSTs new events and PATCHes known ones; caches the access token", async () => {
    const ops = googleCalendarConnector.calendar!(gcalConfig());
    const tokensBefore = tokenRequests;
    const created = await ops.upsertEvent({
      title: "J-1041 · Water Heater — Boyd (Jake)",
      start: new Date("2026-07-19T16:00:00Z"),
      end: new Date("2026-07-19T18:00:00Z"),
      location: "88 Cliffside Dr",
    });
    expect(created.ok).toBe(true);
    expect(created.externalId).toMatch(/^gev-/);

    const patched = await ops.upsertEvent({
      externalId: created.externalId,
      title: "J-1041 · rescheduled",
      start: new Date("2026-07-19T17:00:00Z"),
      end: new Date("2026-07-19T19:00:00Z"),
    });
    expect(patched.ok).toBe(true);
    expect(patched.externalId).toBe(created.externalId);
    expect(gcalEvents.some((e) => e.patched === created.externalId)).toBe(true);
    // One ops instance = one token refresh for both calls.
    expect(tokenRequests - tokensBefore).toBe(1);
  });

  it("listBusy maps freeBusy windows to Dates", async () => {
    const pull = await googleCalendarConnector.calendar!(gcalConfig()).listBusy(
      new Date("2026-07-19T00:00:00Z"), new Date("2026-07-20T00:00:00Z")
    );
    expect(pull.ok).toBe(true);
    expect(pull.records).toHaveLength(1);
    expect(pull.records[0].start.toISOString()).toBe("2026-07-19T14:00:00.000Z");
  });
});

describe("Outlook / Graph live connector", () => {
  const cfg = () => ({ clientId: "cid", clientSecret: "sec", refreshToken: GOOD_REFRESH, baseUrl: graphBase, tokenUrl: `${graphBase}/token` });

  it("health connects via Graph", async () => {
    const h = await outlookCalendarConnector.health(cfg());
    expect(h.ok).toBe(true);
  });

  it("upsertEvent creates then PATCHes; listBusy filters showAs=free", async () => {
    const ops = outlookCalendarConnector.calendar!(cfg());
    const created = await ops.upsertEvent({
      title: "J-1042 · Drain Clearing", start: new Date("2026-07-19T18:00:00Z"), end: new Date("2026-07-19T20:00:00Z"),
    });
    expect(created.ok).toBe(true);
    expect(created.externalId).toMatch(/^oev-/);
    const patched = await ops.upsertEvent({ externalId: created.externalId, title: "moved", start: new Date(), end: new Date(Date.now() + 3600e3) });
    expect(patched.ok).toBe(true);

    const busy = await ops.listBusy(new Date("2026-07-19T00:00:00Z"), new Date("2026-07-20T00:00:00Z"));
    expect(busy.ok).toBe(true);
    expect(busy.records).toHaveLength(1); // "free" hold filtered out
    expect(busy.records[0].title).toBe("Supplier meeting");
  });

  it("unconfigured calendar ops fail loudly without throwing", async () => {
    const r = await outlookCalendarConnector.calendar!({}).upsertEvent({ title: "x", start: new Date(), end: new Date() });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("not configured");
  });
});
