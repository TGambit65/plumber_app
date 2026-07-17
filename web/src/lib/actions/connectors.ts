"use server";

import { t, withTenant } from "@/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { audit, logActivity, notify } from "./helpers";
import { getConnector } from "@/lib/connectors/providers";
import type { Connector, ConnectorConfig, ExternalLead } from "@/lib/connectors/types";
import { decryptConfig, encryptConfig } from "@/lib/connectors/secret-config";
import { getKnowledgeStore } from "@/lib/knowledge/store";

/**
 * Server actions for the typed connector interface (constraint 9).
 *
 * All DB access goes through withTenant (FORCE RLS on integration_connections,
 * per-org unique (organization_id, provider)). Failures are LOUD (constraint
 * 2): health/pull errors land in config.lastError, flip status to ERROR, and
 * notify the caller with the message — never a silent no-op.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

async function ensureIntegrationsAdmin() {
  const session = await requireSession();
  if (!can(session.role, "integrations.manage")) throw new Error("Not allowed");
  return session;
}

type ConnectionRow = typeof t.integrationConnections.$inferSelect;

/**
 * Read a stored config with its SECRET fields DECRYPTED for in-app use.
 * Legacy plaintext rows pass through unchanged (lazy migration).
 */
function rowConfig(row: ConnectionRow | null | undefined): ConnectorConfig {
  const raw = ((row?.config ?? {}) as ConnectorConfig) || {};
  const connector = row?.provider ? getConnector(row.provider) : undefined;
  return connector ? decryptConfig(connector.descriptor, raw) : raw;
}

/** Encrypt a config's secret fields for storage (provider descriptor drives which). */
function encryptForStore(provider: string, config: Record<string, unknown>): Record<string, unknown> {
  const connector = getConnector(provider);
  return connector ? (encryptConfig(connector.descriptor, config as ConnectorConfig) as Record<string, unknown>) : config;
}

/** Upsert the per-org connection row for a provider (unique org+provider). */
async function upsertConnection(
  organizationId: string,
  provider: string,
  values: { status: "CONNECTED" | "DISCONNECTED" | "ERROR"; config: Record<string, unknown>; lastSyncAt?: Date | null }
) {
  // Encrypt secrets at the storage boundary — callers pass plaintext config.
  values = { ...values, config: encryptForStore(provider, values.config) };
  await withTenant(organizationId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(t.integrationConnections)
      .where(eq(t.integrationConnections.provider, provider));
    if (existing) {
      await tx.update(t.integrationConnections).set(values).where(eq(t.integrationConnections.id, existing.id));
    } else {
      await tx.insert(t.integrationConnections).values({ provider, ...values });
    }
  });
}

async function loadConnection(organizationId: string, provider: string): Promise<ConnectionRow | undefined> {
  const [row] = await withTenant(organizationId, (tx) =>
    tx.select().from(t.integrationConnections).where(eq(t.integrationConnections.provider, provider))
  );
  return row;
}

// ── Configure / connect ──────────────────────────────────────────────────────

/**
 * Save a connector's config (dynamic fields from its descriptor) and run
 * health(). CONNECTED when healthy; ERROR with the loud message stored in
 * config.lastError otherwise.
 */
export async function configureConnector(formData: FormData) {
  const session = await ensureIntegrationsAdmin();
  const provider = str(formData, "provider");
  const connector = getConnector(provider);
  if (!connector) return;

  // Secret fields are masked in the UI (never pre-filled with ciphertext), so a
  // BLANK secret on re-save means "keep the existing one" — load + decrypt it.
  const existing = await loadConnection(session.organizationId, provider);
  const existingConfig = rowConfig(existing);
  const secretFieldKeys = new Set(
    connector.descriptor.configFields.filter((f) => f.kind === "password").map((f) => f.key)
  );

  const config: Record<string, string> = {};
  for (const field of connector.descriptor.configFields) {
    const submitted = str(formData, field.key);
    if (!submitted && secretFieldKeys.has(field.key) && typeof existingConfig[field.key] === "string") {
      config[field.key] = existingConfig[field.key] as string; // keep existing secret
    } else {
      config[field.key] = submitted;
    }
  }

  const health = await connector.health(config);
  const status = health.ok ? ("CONNECTED" as const) : ("ERROR" as const);
  const storedConfig: Record<string, unknown> = { ...config };
  if (health.ok) {
    delete storedConfig.lastError;
  } else {
    storedConfig.lastError = health.message ?? "Connection check failed";
  }

  await upsertConnection(session.organizationId, provider, {
    status,
    config: storedConfig,
    lastSyncAt: health.ok ? new Date() : null,
  });

  await audit(session.userId, health.ok ? "CONNECT" : "CONNECT_FAILED", "Integration", provider, {
    ok: health.ok,
    degraded: health.degraded,
    message: health.message,
  });
  if (!health.ok) {
    await notify(
      session.userId,
      `⚠️ ${connector.descriptor.label} connection failed`,
      health.message ?? "Health check failed — see connector card for details.",
      "/settings?tab=integrations"
    );
  }
  revalidatePath("/settings");
}

// ── Disconnect ───────────────────────────────────────────────────────────────

export async function disconnectConnector(formData: FormData) {
  const session = await ensureIntegrationsAdmin();
  const provider = str(formData, "provider");
  if (!provider) return;
  const row = await loadConnection(session.organizationId, provider);
  if (!row) return;
  await withTenant(session.organizationId, (tx) =>
    tx.update(t.integrationConnections).set({ status: "DISCONNECTED" }).where(eq(t.integrationConnections.id, row.id))
  );
  await audit(session.userId, "DISCONNECT", "Integration", provider);
  revalidatePath("/settings");
}

// ── Test ─────────────────────────────────────────────────────────────────────

/** Re-run health() against the stored config; update status + lastSyncAt. */
export async function testConnector(formData: FormData) {
  const session = await ensureIntegrationsAdmin();
  const provider = str(formData, "provider");
  const connector = getConnector(provider);
  if (!connector) return;
  const row = await loadConnection(session.organizationId, provider);
  if (!row) return;

  const config = rowConfig(row);
  const health = await connector.health(config);
  const storedConfig: Record<string, unknown> = { ...config };
  if (health.ok) delete storedConfig.lastError;
  else storedConfig.lastError = health.message ?? "Health check failed";

  await withTenant(session.organizationId, (tx) =>
    tx
      .update(t.integrationConnections)
      .set({
        status: health.ok ? "CONNECTED" : "ERROR",
        config: encryptForStore(provider, storedConfig),
        lastSyncAt: health.ok ? new Date() : row.lastSyncAt,
      })
      .where(eq(t.integrationConnections.id, row.id))
  );

  await audit(session.userId, "TEST", "Integration", provider, {
    ok: health.ok,
    degraded: health.degraded,
    message: health.message,
  });
  await notify(
    session.userId,
    health.ok ? `✅ ${connector.descriptor.label} test passed` : `⚠️ ${connector.descriptor.label} test FAILED`,
    health.message ?? (health.ok ? "Connector is healthy." : "Health check failed."),
    "/settings?tab=integrations"
  );
  revalidatePath("/settings");
}

// ── CRM sync ─────────────────────────────────────────────────────────────────

/** JSON summary of an external lead for the OrgMemory staged candidate. */
function leadSummary(lead: ExternalLead, syncedAt: string) {
  return {
    provenance: { provider: lead.provider, externalId: lead.externalId, syncedAt },
    lead: {
      title: lead.title,
      contactName: lead.contactName,
      phone: lead.phone ?? null,
      email: lead.email ?? null,
      expectedRevenueCents: lead.expectedRevenueCents ?? null,
      stage: lead.stage ?? null,
      demo: lead.demo ?? false,
    },
  };
}

/**
 * Pull leads from the provider's CRM ops, insert NEW ones into the local
 * leads table (augment, don't replace — constraint 9), and stage each new
 * record into OrgMemory as a provenance-tagged candidate (constraint 6 —
 * never auto-canon; staging is a no-op on the local store).
 */
export async function syncCrmNow(formData: FormData) {
  const session = await ensureIntegrationsAdmin();
  const provider = str(formData, "provider");
  const connector: Connector | undefined = getConnector(provider);
  if (!connector?.crm) return;
  const label = connector.descriptor.label;

  const row = await loadConnection(session.organizationId, provider);
  if (!row || row.status !== "CONNECTED") {
    await notify(
      session.userId,
      `⚠️ ${label} sync skipped`,
      "Connector is not connected — configure and connect it first.",
      "/settings?tab=integrations"
    );
    return;
  }

  const config = rowConfig(row);
  const ops = connector.crm(config);
  const pull = await ops.pullLeads(row.lastSyncAt ?? undefined);

  if (!pull.ok) {
    // LOUD failure: status → ERROR, message stored + notified.
    const message = pull.message ?? "CRM pull failed";
    await withTenant(session.organizationId, (tx) =>
      tx
        .update(t.integrationConnections)
        .set({ status: "ERROR", config: encryptForStore(provider, { ...config, lastError: message }) })
        .where(eq(t.integrationConnections.id, row.id))
    );
    await audit(session.userId, "SYNC_FAILED", "Integration", provider, { message });
    await notify(session.userId, `⚠️ ${label} CRM sync FAILED`, message, "/settings?tab=integrations");
    revalidatePath("/settings");
    return;
  }

  // Insert new leads, deduped by title within the org.
  const syncedAt = new Date().toISOString();
  const inserted: Array<{ id: string; external: ExternalLead }> = [];
  await withTenant(session.organizationId, async (tx) => {
    const existing = await tx.select({ title: t.leads.title }).from(t.leads);
    const known = new Set(existing.map((l) => l.title.toLowerCase()));

    for (const lead of pull.records) {
      if (known.has(lead.title.toLowerCase())) continue;
      known.add(lead.title.toLowerCase());
      const [created] = await tx
        .insert(t.leads)
        .values({
          source: "OTHER",
          stage: "NEW",
          title: lead.title,
          contactName: lead.contactName,
          phone: lead.phone ?? null,
          email: lead.email ?? null,
          description: `[${provider}] Synced from ${label} · external id ${lead.externalId}${lead.stage ? ` · remote stage: ${lead.stage}` : ""}${lead.demo ? " · demo data" : ""}`,
          estValueCents: lead.expectedRevenueCents ?? null,
          createdById: session.userId,
        })
        .returning({ id: t.leads.id });
      inserted.push({ id: created.id, external: lead });
    }

    const clearedConfig = { ...config };
    delete clearedConfig.lastError;
    await tx
      .update(t.integrationConnections)
      .set({ status: "CONNECTED", lastSyncAt: new Date(), config: encryptForStore(provider, clearedConfig) })
      .where(eq(t.integrationConnections.id, row.id));
  });

  // Stage each newly synced record into OrgMemory as a provenance-tagged
  // candidate. On the local store this is a no-op; on OrgMemory it is a
  // STAGED candidate (never auto-canon). Degradation is surfaced, not hidden.
  const store = await getKnowledgeStore(session.organizationId);
  let staged = 0;
  let stageWarning: string | undefined;
  for (const { external } of inserted) {
    const result = await store.stageDocument({
      id: `crm-${provider.toLowerCase()}-${external.externalId}`,
      slug: `crm-${provider.toLowerCase()}-${external.externalId}`,
      title: `CRM lead: ${external.title}`,
      category: "CRM_SYNC",
      body: JSON.stringify(leadSummary(external, syncedAt), null, 2),
      tags: [provider.toLowerCase(), "crm-sync", `external:${external.externalId}`],
    });
    if (result.staged) staged += 1;
    if (result.degraded) stageWarning = result.message ?? "OrgMemory staging degraded";
  }

  for (const { id, external } of inserted) {
    await logActivity({
      kind: "SYSTEM",
      body: `Lead synced from ${label} (external id ${external.externalId}${external.demo ? ", demo" : ""}).`,
      userId: session.userId,
      leadId: id,
    });
  }

  const skipped = pull.records.length - inserted.length;
  await notify(
    session.userId,
    `✅ ${label} CRM sync complete`,
    `${pull.records.length} lead(s) pulled · ${inserted.length} new imported · ${skipped} already present` +
      (staged > 0 ? ` · ${staged} staged to OrgMemory` : "") +
      (stageWarning ? ` · ⚠️ OrgMemory staging degraded: ${stageWarning}` : "") +
      (pull.demo ? " · demo data" : ""),
    inserted.length > 0 ? "/leads" : "/settings?tab=integrations"
  );
  await audit(session.userId, "SYNC", "Integration", provider, {
    pulled: pull.records.length,
    imported: inserted.length,
    skipped,
    staged,
    stageWarning,
    demo: pull.demo ?? false,
  });

  revalidatePath("/settings");
  revalidatePath("/leads");
}
