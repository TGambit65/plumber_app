import "server-only";
import { t, withTenant } from "@/db";
import { eq } from "drizzle-orm";

/**
 * Trade-pack composition (constraints 1 & 12).
 *
 * A tenant's capability surface is the UNION of the trade packs it has enabled —
 * one shared core, many composable packs. Job types are pack-provided content
 * (tradePacks.config.jobTypes), never hardcoded plumbing. This is what proves an
 * American Automators org sees ONLY its aa_field_ops job types (Site Survey,
 * Acorn installs, …) and never any plumbing leakage.
 *
 * These read the org↔pack mapping (organizationTradePacks) joined to the global
 * pack catalog (tradePacks). We run inside `withTenant` so the org scoping is
 * enforced on the same connection, and additionally filter by organizationId
 * explicitly for defense-in-depth.
 */

export type PackConfig = { jobTypes?: string[] };

export type EnabledPack = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  jobTypes: string[];
};

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
    .map((p) => {
      const cfg = (p.config ?? {}) as PackConfig;
      return {
        id: p.id,
        key: p.key,
        name: p.name,
        description: p.description,
        jobTypes: Array.isArray(cfg.jobTypes) ? cfg.jobTypes : [],
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The union of jobTypes from the org's ENABLED trade packs only, de-duped and
 * sorted. Empty array if the org has no packs (or no pack ships job types).
 */
export async function enabledJobTypes(organizationId: string): Promise<string[]> {
  const packs = await enabledPacks(organizationId);
  const seen = new Set<string>();
  for (const p of packs) for (const jt of p.jobTypes) seen.add(jt);
  return Array.from(seen).sort((a, b) => a.localeCompare(b));
}
