import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { analyzeChain, estimateDriveMinutes, haversineKm, projectPoints } from "../geo/distance";
import { googleMapsConnector } from "../connectors/google-maps";

// ── Pure math ────────────────────────────────────────────────────────────────

describe("geo math", () => {
  const spokane = { lat: 47.6588, lng: -117.426 };
  const valley = { lat: 47.6733, lng: -117.2394 }; // ~14 km east

  it("haversineKm is sane for known city pairs", () => {
    const km = haversineKm(spokane, valley);
    expect(km).toBeGreaterThan(12);
    expect(km).toBeLessThan(17);
    expect(haversineKm(spokane, spokane)).toBe(0);
  });

  it("estimateDriveMinutes scales with distance and includes stop overhead", () => {
    const near = estimateDriveMinutes(spokane, { lat: 47.66, lng: -117.42 }); // <1 km
    const far = estimateDriveMinutes(spokane, valley);
    expect(near).toBeGreaterThanOrEqual(5); // overhead floor
    expect(near).toBeLessThan(10);
    expect(far).toBeGreaterThan(near);
    expect(far).toBeGreaterThan(15);
  });

  it("analyzeChain classifies ok / tight / impossible / unknown hops", () => {
    const at = (h: number, m = 0) => new Date(Date.UTC(2026, 6, 20, h, m));
    const a = { id: "A", scheduledAt: at(9), scheduledEnd: at(10), point: spokane };
    const b = { id: "B", scheduledAt: at(11), scheduledEnd: at(12), point: valley }; // 60 min gap
    const c = { id: "C", scheduledAt: at(12, 10), scheduledEnd: null, point: spokane }; // 10 min gap after B
    const d = { id: "D", scheduledAt: at(15), scheduledEnd: null, point: null }; // no coords

    const drives = new Map([
      [`${spokane.lat},${spokane.lng}|${valley.lat},${valley.lng}`, 25],
      [`${valley.lat},${valley.lng}|${spokane.lat},${spokane.lng}`, 25],
    ]);
    const hops = analyzeChain([d, c, a, b], (f, t) => drives.get(`${f.lat},${f.lng}|${t.lat},${t.lng}`) ?? null);

    expect(hops).toHaveLength(3); // sorted A→B→C→D
    expect(hops[0]).toMatchObject({ fromJobId: "A", toJobId: "B", driveMinutes: 25, gapMinutes: 60, status: "ok" });
    expect(hops[1]).toMatchObject({ fromJobId: "B", toJobId: "C", driveMinutes: 25, gapMinutes: 10, status: "impossible" });
    expect(hops[2]).toMatchObject({ fromJobId: "C", toJobId: "D", status: "unknown" });

    // Tight: gap barely beats drive (slack < 10)
    const tight = analyzeChain(
      [a, { ...b, scheduledAt: at(10, 30) }], // 30 min gap, 25 min drive → 5 min slack
      () => 25
    );
    expect(tight[0].status).toBe("tight");
  });

  it("projectPoints maps into the viewBox with north up", () => {
    const pts = [
      { key: "sw", lat: 47.6, lng: -117.5 },
      { key: "ne", lat: 47.7, lng: -117.3 },
    ];
    const pos = projectPoints(pts, 400, 200);
    const sw = pos.get("sw")!;
    const ne = pos.get("ne")!;
    expect(sw.x).toBeLessThan(ne.x); // west left of east
    expect(sw.y).toBeGreaterThan(ne.y); // south below north
    for (const p of [sw, ne]) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(400);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(200);
    }
  });
});

// ── Google Maps connector vs vendor-shaped mock ──────────────────────────────

const KEY = "AIza-good-key";
const server = http.createServer(async (req, res) => {
  const send = (s: number, b: unknown) => {
    res.writeHead(s, { "content-type": "application/json" });
    res.end(JSON.stringify(b));
  };
  const url = new URL(req.url ?? "/", "http://x");
  let body = "";
  for await (const c of req) body += c;

  if (req.method === "GET" && url.pathname === "/maps/api/geocode/json") {
    if (url.searchParams.get("key") !== KEY) return send(200, { status: "REQUEST_DENIED", error_message: "The provided API key is invalid." });
    return send(200, { status: "OK", results: [{ geometry: { location: { lat: 47.6588, lng: -117.426 } } }] });
  }
  if (req.method === "POST" && url.pathname === "/directions/v2:computeRoutes") {
    if (req.headers["x-goog-api-key"] !== KEY) return send(403, { error: { message: "API key not valid" } });
    if (!String(req.headers["x-goog-fieldmask"] ?? "").includes("routes.duration")) {
      return send(400, { error: { message: "FieldMask required" } });
    }
    const j = JSON.parse(body);
    const dLat = Math.abs(j.origin.location.latLng.latitude - j.destination.location.latLng.latitude);
    return send(200, { routes: [{ duration: `${Math.round(600 + dLat * 20000)}s` }] });
  }
  send(404, { error: { message: "no route" } });
});

let base = "";
beforeAll(
  () =>
    new Promise<void>((r) =>
      server.listen(0, "127.0.0.1", () => {
        const a = server.address();
        if (a && typeof a === "object") base = `http://127.0.0.1:${a.port}`;
        r();
      })
    )
);
afterAll(() => server.close());

describe("Google Maps live connector", () => {
  const cfg = () => ({ apiKey: KEY, baseUrl: base, routesUrl: base });

  it("health probes geocoding with the key", async () => {
    const h = await googleMapsConnector.health(cfg());
    expect(h.ok).toBe(true);
  });

  it("geocode returns coordinates; bad key degrades LOUDLY with Google's message", async () => {
    const ops = googleMapsConnector.geo!(cfg());
    const good = await ops.geocode("412 Sycamore Ln, Riverton, OH 45201");
    expect(good.ok).toBe(true);
    expect(good.point).toEqual({ lat: 47.6588, lng: -117.426 });

    const bad = await googleMapsConnector.geo!({ ...cfg(), apiKey: "wrong" }).geocode("x");
    expect(bad.ok).toBe(false);
    expect(bad.degraded).toBe(true);
    expect(bad.message).toContain("REQUEST_DENIED");
  });

  it("driveMinutes posts computeRoutes with FieldMask and parses '1234s' durations", async () => {
    const ops = googleMapsConnector.geo!(cfg());
    const r = await ops.driveMinutes({ lat: 47.65, lng: -117.42 }, { lat: 47.7, lng: -117.3 });
    expect(r.ok).toBe(true);
    expect(r.minutes).toBeGreaterThan(5);
  });

  it("unconfigured ops fail loudly without throwing", async () => {
    const r = await googleMapsConnector.geo!({}).geocode("anywhere");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("not configured");
  });
});
