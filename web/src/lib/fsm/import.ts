import "server-only";
import { and, eq } from "drizzle-orm";
import { t, withTenant, type TenantDb } from "@/db";
import type { ExternalJob } from "@/lib/connectors/types";
import { externalJobNumber, externalRef, mapExternalStatus, splitAddress } from "./map";

/**
 * FSM import pipeline (D5) — shared by the manual "Import jobs" action and
 * the Jobber webhook. Coexistence semantics:
 *
 *   - AUGMENT, never clobber: records land with full provenance
 *     (external_ref = "PROVIDER:id") and provider-prefixed numbers (JB-5501),
 *     so they sit next to local jobs without colliding.
 *   - Dedupe by external_ref: re-importing updates schedule/status/title of
 *     the SAME local job instead of duplicating it.
 *   - Customers/properties dedupe by external_ref too when the provider gives
 *     ids, else by exact name/address within the org.
 *   - Imported jobs arrive UNASSIGNED locally — assigning crew stays a local
 *     dispatcher decision (the suggestion engine happily helps).
 */

export interface ImportSummary {
  created: number;
  updated: number;
  customersCreated: number;
}

async function findOrCreateCustomer(
  tx: TenantDb,
  job: ExternalJob,
  provider: string
): Promise<{ id: string; created: boolean }> {
  const name = job.customerName?.trim() || `${provider} customer`;
  const byName = await tx.query.customers.findFirst({ where: eq(t.customers.name, name) });
  if (byName) return { id: byName.id, created: false };
  const [created] = await tx
    .insert(t.customers)
    .values({
      name,
      type: "RESIDENTIAL",
      phone: job.customerPhone ?? null,
      email: job.customerEmail ?? null,
      notes: `Imported from ${provider}`,
      externalRef: null, // ExternalJob carries no separate customer id today
    })
    .returning({ id: t.customers.id });
  return { id: created.id, created: true };
}

async function findOrCreateProperty(tx: TenantDb, customerId: string, job: ExternalJob): Promise<string> {
  const parts = splitAddress(job);
  const existing = await tx.query.properties.findFirst({
    where: and(eq(t.properties.customerId, customerId), eq(t.properties.address, parts.address)),
  });
  if (existing) return existing.id;
  const [created] = await tx
    .insert(t.properties)
    .values({ customerId, address: parts.address, city: parts.city, state: parts.state, zip: parts.zip })
    .returning({ id: t.properties.id });
  return created.id;
}

/** Upsert a batch of external jobs into the tenant. Never throws per-row noise upward. */
export async function upsertExternalJobs(
  organizationId: string,
  provider: string,
  jobs: ExternalJob[]
): Promise<ImportSummary> {
  const summary: ImportSummary = { created: 0, updated: 0, customersCreated: 0 };

  await withTenant(organizationId, async (tx) => {
    for (const ext of jobs) {
      const ref = externalRef(provider, ext.externalId);
      const scheduledAt = ext.scheduledAt ? new Date(ext.scheduledAt) : null;
      const scheduledEnd = ext.scheduledEnd ? new Date(ext.scheduledEnd) : null;
      const status = mapExternalStatus(ext.status, Boolean(scheduledAt));

      const existing = await tx.query.jobs.findFirst({ where: eq(t.jobs.externalRef, ref) });
      if (existing) {
        await tx
          .update(t.jobs)
          .set({
            jobType: ext.title || existing.jobType,
            status,
            scheduledAt: scheduledAt ?? existing.scheduledAt,
            scheduledEnd: scheduledEnd ?? existing.scheduledEnd,
            description: ext.description ?? existing.description,
          })
          .where(eq(t.jobs.id, existing.id));
        summary.updated += 1;
        continue;
      }

      const customer = await findOrCreateCustomer(tx, ext, provider);
      if (customer.created) summary.customersCreated += 1;
      const propertyId = await findOrCreateProperty(tx, customer.id, ext);

      await tx.insert(t.jobs).values({
        number: externalJobNumber(provider, ext.externalId),
        jobType: ext.title || `${provider} job`,
        status,
        priority: "NORMAL",
        description: ext.description ?? null,
        customerId: customer.id,
        propertyId,
        assignedToId: null, // crew assignment stays a LOCAL decision
        scheduledAt,
        scheduledEnd,
        externalRef: ref,
      });
      summary.created += 1;
    }
  });

  return summary;
}
