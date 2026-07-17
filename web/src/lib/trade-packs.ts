import "server-only";
import { db, t, withTenant } from "@/db";
import { eq } from "drizzle-orm";

/**
 * Trade-pack composition (constraints 1 & 12).
 *
 * A tenant's capability surface is the UNION of the trade packs it has enabled —
 * one shared core, many composable packs. All trade-specific content is
 * data/config-driven (tradePacks.config), never hardcoded and never a per-trade
 * fork. A pack ships: job types, equipment kinds, inspection templates, cert
 * types, and safety docs — the core schema stays trade-neutral (no fuel enums,
 * no plumbing assumptions).
 */

// A single inspection template a pack provides (mirrors inspectionTemplates rows).
export type PackInspectionTemplate = {
  name: string;
  description?: string;
  issuesCertification?: string;
  certValidityDays?: number;
  steps: Array<{ key: string; label: string; kind: "check" | "measurement" | "photo" | "note"; required: boolean; unit?: string }>;
};

export type PackConfig = {
  jobTypes?: string[];
  equipmentKinds?: string[];
  certTypes?: string[];
  safetyDocs?: string[];
  inspectionTemplates?: PackInspectionTemplate[];
};

export type PackSummary = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  enabled: boolean;
  jobTypes: string[];
  equipmentKinds: string[];
  certTypes: string[];
  safetyDocs: string[];
  inspectionTemplates: PackInspectionTemplate[];
};

function parse(config: unknown) {
  const c = (config ?? {}) as PackConfig;
  return {
    jobTypes: Array.isArray(c.jobTypes) ? c.jobTypes : [],
    equipmentKinds: Array.isArray(c.equipmentKinds) ? c.equipmentKinds : [],
    certTypes: Array.isArray(c.certTypes) ? c.certTypes : [],
    safetyDocs: Array.isArray(c.safetyDocs) ? c.safetyDocs : [],
    inspectionTemplates: Array.isArray(c.inspectionTemplates) ? c.inspectionTemplates : [],
  };
}

export type EnabledPack = { id: string; key: string; name: string; description: string | null; jobTypes: string[] };

/** The org's ENABLED trade packs (catalog rows), with parsed job types. */
export async function enabledPacks(organizationId: string): Promise<EnabledPack[]> {
  const rows = await withTenant(organizationId, (tx) =>
    tx.query.organizationTradePacks.findMany({
      where: eq(t.organizationTradePacks.organizationId, organizationId),
      with: { tradePack: true },
    })
  );
  return rows
    .map((r) => r.tradePack)
    .filter((p): p is NonNullable<typeof p> => Boolean(p && p.active))
    .map((p) => ({ id: p.id, key: p.key, name: p.name, description: p.description, jobTypes: parse(p.config).jobTypes }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Union of jobTypes from the org's ENABLED packs only, de-duped and sorted. */
export async function enabledJobTypes(organizationId: string): Promise<string[]> {
  const packs = await enabledPacks(organizationId);
  const seen = new Set<string>();
  for (const p of packs) for (const jt of p.jobTypes) seen.add(jt);
  return Array.from(seen).sort((a, b) => a.localeCompare(b));
}

/** Union of equipment kinds from the org's ENABLED packs (for equipment forms). */
export async function enabledEquipmentKinds(organizationId: string): Promise<string[]> {
  const rows = await withTenant(organizationId, (tx) =>
    tx.query.organizationTradePacks.findMany({
      where: eq(t.organizationTradePacks.organizationId, organizationId),
      with: { tradePack: true },
    })
  );
  const seen = new Set<string>();
  for (const r of rows) if (r.tradePack?.active) for (const k of parse(r.tradePack.config).equipmentKinds) seen.add(k);
  return Array.from(seen).sort((a, b) => a.localeCompare(b));
}

/**
 * Full catalog of packs with an `enabled` flag for the org and everything each
 * pack provides — powers the Trade Packs admin surface. Reads the global
 * catalog (tradePacks, not RLS'd) + the org mapping (via withTenant).
 */
export async function packCatalog(organizationId: string): Promise<PackSummary[]> {
  const [all, enabledIds] = await Promise.all([
    db.select().from(t.tradePacks).orderBy(t.tradePacks.name),
    withTenant(organizationId, (tx) =>
      tx
        .select({ tradePackId: t.organizationTradePacks.tradePackId })
        .from(t.organizationTradePacks)
        .where(eq(t.organizationTradePacks.organizationId, organizationId))
    ),
  ]);
  const enabled = new Set(enabledIds.map((e) => e.tradePackId));
  return all
    .filter((p) => p.active)
    .map((p) => ({ id: p.id, key: p.key, name: p.name, description: p.description, enabled: enabled.has(p.id), ...parse(p.config) }));
}

/** The inspection templates a pack ships (for provisioning). */
export async function packTemplates(packId: string): Promise<PackInspectionTemplate[]> {
  const [pack] = await db.select().from(t.tradePacks).where(eq(t.tradePacks.id, packId));
  return pack ? parse(pack.config).inspectionTemplates : [];
}
