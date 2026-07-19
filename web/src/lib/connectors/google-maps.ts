import "server-only";
import type { Connector, ConnectorConfig, ConnectorHealth, GeoOps, GeoPoint } from "./types";
import { missingRequiredFields } from "./types";

/**
 * Google Maps connector — REAL implementation (dispatch D3).
 *
 *   geocode      GET  {baseUrl}/maps/api/geocode/json?address=…&key=…
 *   driveMinutes POST {routesUrl}/directions/v2:computeRoutes
 *                (X-Goog-Api-Key + X-Goog-FieldMask: routes.duration)
 *
 * One API key covers both (enable Geocoding API + Routes API on the key).
 * `baseUrl`/`routesUrl` are overridable so vendor-shaped mocks can drive
 * tests. Failures degrade LOUDLY; when this connector is absent the geo
 * service falls back to labeled haversine ESTIMATES — never fake routing.
 */

const PROVIDER = "GOOGLE_MAPS";
const TIMEOUT_MS = 8000;
const DEFAULT_BASE = "https://maps.googleapis.com";
const DEFAULT_ROUTES = "https://routes.googleapis.com";

type GmapsConfig = { baseUrl: string; routesUrl: string; apiKey: string };

function readConfig(config: ConnectorConfig): GmapsConfig | null {
  const apiKey = (config.apiKey ?? "").trim();
  const baseUrl = ((config.baseUrl ?? "").trim() || DEFAULT_BASE).replace(/\/+$/, "");
  const routesUrl = ((config.routesUrl ?? "").trim() || DEFAULT_ROUTES).replace(/\/+$/, "");
  if (!apiKey) return null;
  return { baseUrl, routesUrl, apiKey };
}

function degrade(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[Connector google-maps DEGRADED] ${msg}`);
  return msg;
}

function makeOps(cfg: GmapsConfig): GeoOps {
  return {
    async geocode(address: string) {
      try {
        const url = `${cfg.baseUrl}/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${encodeURIComponent(cfg.apiKey)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
        const json = (await res.json().catch(() => ({}))) as {
          status?: string;
          error_message?: string;
          results?: Array<{ geometry?: { location?: { lat: number; lng: number } } }>;
        };
        if (!res.ok || json.status !== "OK") {
          throw new Error(`Geocoding → ${json.status ?? `HTTP ${res.status}`}${json.error_message ? `: ${json.error_message}` : ""}`);
        }
        const loc = json.results?.[0]?.geometry?.location;
        if (!loc) throw new Error("Geocoding returned no location");
        return { ok: true, degraded: false, point: { lat: loc.lat, lng: loc.lng } };
      } catch (err) {
        return { ok: false, degraded: true, message: degrade(err) };
      }
    },

    async driveMinutes(from: GeoPoint, to: GeoPoint) {
      try {
        const res = await fetch(`${cfg.routesUrl}/directions/v2:computeRoutes`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": cfg.apiKey,
            "x-goog-fieldmask": "routes.duration",
          },
          body: JSON.stringify({
            origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
            destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
            travelMode: "DRIVE",
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
          cache: "no-store",
        });
        const json = (await res.json().catch(() => ({}))) as {
          routes?: Array<{ duration?: string }>;
          error?: { message?: string };
        };
        if (!res.ok) {
          throw new Error(`Routes → HTTP ${res.status}${json.error?.message ? `: ${json.error.message}` : ""}`);
        }
        const duration = json.routes?.[0]?.duration; // e.g. "1234s"
        const seconds = duration ? Number(duration.replace(/s$/, "")) : NaN;
        if (!Number.isFinite(seconds)) throw new Error("Routes returned no duration");
        return { ok: true, degraded: false, minutes: Math.round(seconds / 60) };
      } catch (err) {
        return { ok: false, degraded: true, message: degrade(err) };
      }
    },
  };
}

export const googleMapsConnector: Connector = {
  descriptor: {
    provider: PROVIDER,
    label: "Google Maps",
    emoji: "🗺️",
    capabilities: ["geo"],
    blurb: "Geocoding + traffic-aware drive times for the dispatch board (Geocoding API + Routes API)",
    configFields: [
      { key: "apiKey", label: "API key", kind: "password", placeholder: "AIza… (Geocoding + Routes enabled)", required: true },
      { key: "baseUrl", label: "Geocoding base URL (optional)", kind: "url", placeholder: DEFAULT_BASE },
      { key: "routesUrl", label: "Routes base URL (optional)", kind: "url", placeholder: DEFAULT_ROUTES },
    ],
  },

  async health(config: ConnectorConfig): Promise<ConnectorHealth> {
    const missing = missingRequiredFields(googleMapsConnector.descriptor, config);
    if (missing.length > 0) {
      return { ok: false, degraded: false, message: `Missing required field(s): ${missing.join(", ")}` };
    }
    const cfg = readConfig(config)!;
    const probe = await makeOps(cfg).geocode("1600 Amphitheatre Parkway, Mountain View, CA");
    if (!probe.ok) return { ok: false, degraded: true, message: probe.message };
    return { ok: true, degraded: false, message: "Geocoding reachable with this key" };
  },

  geo(config: ConnectorConfig): GeoOps {
    const cfg = readConfig(config);
    if (!cfg) {
      const message = "Google Maps is not configured (API key required)";
      return {
        async geocode() {
          console.error(`[Connector google-maps DEGRADED] ${message}`);
          return { ok: false, degraded: false, message };
        },
        async driveMinutes() {
          console.error(`[Connector google-maps DEGRADED] ${message}`);
          return { ok: false, degraded: false, message };
        },
      };
    }
    return makeOps(cfg);
  },
};
