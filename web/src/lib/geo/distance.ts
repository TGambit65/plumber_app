/**
 * Geography math (dispatch D3) — PURE module, unit-testable.
 *
 * When no geo connector is connected, drive times are ESTIMATED from
 * straight-line (haversine) distance with a winding factor and an average
 * urban field-service speed. Estimates are always labeled as such in the UI —
 * we never present a guess as a routed time (loud-honesty rule).
 */

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_KM = 6371;
/** Roads wind: straight-line → road distance multiplier. */
const WINDING_FACTOR = 1.3;
/** Average door-to-door speed for a service truck in town (km/h). */
const AVG_SPEED_KMH = 45;
/** Parking, walk-up, load-out — fixed per-hop overhead (minutes). */
const STOP_OVERHEAD_MIN = 5;

export function haversineKm(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(s));
}

/** Estimated drive minutes between two points (haversine fallback). */
export function estimateDriveMinutes(a: LatLng, b: LatLng): number {
  const roadKm = haversineKm(a, b) * WINDING_FACTOR;
  return Math.round((roadKm / AVG_SPEED_KMH) * 60 + STOP_OVERHEAD_MIN);
}

// ── Chain analysis: consecutive jobs in one tech's day ───────────────────────

export interface ChainJob {
  id: string;
  scheduledAt: Date;
  scheduledEnd: Date | null;
  point: LatLng | null;
}

export type HopStatus = "ok" | "tight" | "impossible" | "unknown";

export interface Hop {
  fromJobId: string;
  toJobId: string;
  /** Minutes of drive between the two properties (null when either lacks coords). */
  driveMinutes: number | null;
  /** Minutes between job A's end and job B's start. */
  gapMinutes: number;
  status: HopStatus;
}

const DEFAULT_JOB_MIN = 120;
/** "Tight" = arriving with less than this many spare minutes. */
const TIGHT_SLACK_MIN = 10;

/**
 * Analyze a tech's day: for each consecutive pair (sorted by start), compare
 * the schedule gap to the drive time.
 *   impossible — gap < drive (they cannot make it)
 *   tight      — makes it with < 10 min slack
 *   ok         — comfortable
 *   unknown    — a property lacks coordinates
 * `driveFor` lets the caller supply routed times; absent → haversine estimate.
 */
export function analyzeChain(
  jobs: ChainJob[],
  driveFor?: (from: LatLng, to: LatLng) => number | null
): Hop[] {
  const sorted = [...jobs].sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
  const hops: Hop[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const aEnd = a.scheduledEnd ?? new Date(a.scheduledAt.getTime() + DEFAULT_JOB_MIN * 60_000);
    const gapMinutes = Math.round((b.scheduledAt.getTime() - aEnd.getTime()) / 60_000);

    let driveMinutes: number | null = null;
    if (a.point && b.point) {
      driveMinutes = driveFor ? driveFor(a.point, b.point) : estimateDriveMinutes(a.point, b.point);
      if (driveMinutes === null) driveMinutes = estimateDriveMinutes(a.point, b.point);
    }

    let status: HopStatus;
    if (driveMinutes === null) status = "unknown";
    else if (gapMinutes < driveMinutes) status = "impossible";
    else if (gapMinutes - driveMinutes < TIGHT_SLACK_MIN) status = "tight";
    else status = "ok";

    hops.push({ fromJobId: a.id, toJobId: b.id, driveMinutes, gapMinutes, status });
  }
  return hops;
}

// ── Day-map projection (self-contained SVG, no external tiles) ───────────────

/** Project points into an SVG viewBox, preserving aspect via equirectangular scale. */
export function projectPoints(
  points: Array<LatLng & { key: string }>,
  width: number,
  height: number,
  pad = 18
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  if (points.length === 0) return out;
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const latSpan = Math.max(maxLat - minLat, 1e-6);
  const lngSpan = Math.max(maxLng - minLng, 1e-6) * Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180));
  const scale = Math.min((width - 2 * pad) / lngSpan, (height - 2 * pad) / latSpan);
  for (const p of points) {
    const x = pad + (p.lng - minLng) * Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180)) * scale;
    const y = height - pad - (p.lat - minLat) * scale; // north = up
    out.set(p.key, { x, y });
  }
  return out;
}
