import "server-only";
import { eq } from "drizzle-orm";
import { t, withTenant } from "@/db";
import { getConnector } from "@/lib/connectors/providers";
import { decryptConfig } from "@/lib/connectors/secret-config";
import type { ConnectorConfig, GeoOps } from "@/lib/connectors/types";
import { estimateDriveMinutes, type LatLng } from "./distance";

/**
 * Geo service (dispatch D3).
 *
 * Drive times come from the org's connected geo connector (routed,
 * traffic-aware) when available, else from the haversine ESTIMATE — and the
 * result always says which it was (`source`), so the UI can label estimates
 * honestly. Geocoding runs on property create when a connector is connected;
 * missing coordinates simply mean "unknown" hops (never fabricated).
 */

export type DriveSource = "routed" | "estimate";

async function connectedGeo(organizationId: string): Promise<GeoOps | null> {
  const [row] = await withTenant(organizationId, (tx) =>
    tx.select().from(t.integrationConnections).where(eq(t.integrationConnections.provider, "GOOGLE_MAPS"))
  );
  if (!row || row.status !== "CONNECTED") return null;
  const connector = getConnector("GOOGLE_MAPS");
  if (!connector?.geo) return null;
  return connector.geo(decryptConfig(connector.descriptor, (row.config ?? {}) as ConnectorConfig));
}

/**
 * Build a drive-time resolver for a batch of board hops. Routed times are
 * fetched per unique pair (memoized); any routing failure falls back to the
 * labeled estimate for that hop.
 */
export async function driveTimeResolver(
  organizationId: string
): Promise<{ source: DriveSource; resolve: (from: LatLng, to: LatLng) => Promise<number> }> {
  const geo = await connectedGeo(organizationId);
  if (!geo) {
    return { source: "estimate", resolve: async (a, b) => estimateDriveMinutes(a, b) };
  }
  const memo = new Map<string, number>();
  return {
    source: "routed",
    resolve: async (a, b) => {
      const key = `${a.lat},${a.lng}|${b.lat},${b.lng}`;
      const hit = memo.get(key);
      if (hit !== undefined) return hit;
      const r = await geo.driveMinutes(a, b);
      const minutes = r.ok && r.minutes !== undefined ? r.minutes : estimateDriveMinutes(a, b);
      memo.set(key, minutes);
      return minutes;
    },
  };
}

/** Geocode + cache a property's coordinates (no-op without a geo connector). */
export async function geocodeProperty(organizationId: string, propertyId: string): Promise<void> {
  try {
    const geo = await connectedGeo(organizationId);
    if (!geo) return;
    const prop = await withTenant(organizationId, (tx) =>
      tx.query.properties.findFirst({ where: eq(t.properties.id, propertyId) })
    );
    if (!prop || (prop.lat !== null && prop.lng !== null)) return;
    const r = await geo.geocode(`${prop.address}, ${prop.city}, ${prop.state} ${prop.zip}`);
    if (!r.ok || !r.point) {
      console.error(`[geocode] property ${propertyId}: ${r.message ?? "no result"}`);
      return;
    }
    await withTenant(organizationId, (tx) =>
      tx
        .update(t.properties)
        .set({ lat: r.point!.lat, lng: r.point!.lng, geocodedAt: new Date() })
        .where(eq(t.properties.id, propertyId))
    );
  } catch (e) {
    console.error(`[geocode] ${e instanceof Error ? e.message : String(e)}`);
  }
}
