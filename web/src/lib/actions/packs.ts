"use server";

import { db, t, withTenant } from "@/db";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { audit } from "./helpers";
import { packTemplates } from "@/lib/trade-packs";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

async function ensurePackAdmin() {
  const session = await requireSession();
  // Enabling packs reshapes the org's whole capability surface → admin-only.
  if (!can(session.role, "users.manage")) throw new Error("Not allowed");
  return session;
}

/** Enable a trade pack for the caller's org (idempotent). */
export async function enablePack(formData: FormData) {
  const session = await ensurePackAdmin();
  const packId = str(formData, "packId");
  if (!packId) return;
  const [pack] = await db.select().from(t.tradePacks).where(eq(t.tradePacks.id, packId));
  if (!pack) return;

  await withTenant(session.organizationId, async (tx) => {
    const [existing] = await tx
      .select({ id: t.organizationTradePacks.id })
      .from(t.organizationTradePacks)
      .where(
        and(
          eq(t.organizationTradePacks.organizationId, session.organizationId),
          eq(t.organizationTradePacks.tradePackId, packId)
        )
      );
    if (!existing) {
      await tx.insert(t.organizationTradePacks).values({ organizationId: session.organizationId, tradePackId: packId });
    }
  });
  await audit(session.userId, "ENABLE_PACK", "TradePack", packId, { key: pack.key });
  revalidatePath("/settings");
  revalidatePath("/dispatch");
}

/** Disable a trade pack for the caller's org. Existing data is untouched. */
export async function disablePack(formData: FormData) {
  const session = await ensurePackAdmin();
  const packId = str(formData, "packId");
  if (!packId) return;
  await withTenant(session.organizationId, (tx) =>
    tx
      .delete(t.organizationTradePacks)
      .where(
        and(
          eq(t.organizationTradePacks.organizationId, session.organizationId),
          eq(t.organizationTradePacks.tradePackId, packId)
        )
      )
  );
  await audit(session.userId, "DISABLE_PACK", "TradePack", packId);
  revalidatePath("/settings");
  revalidatePath("/dispatch");
}

/**
 * Provision a pack's inspection templates into the org. Idempotent: skips
 * templates that already exist by name for the org. Returns how many were
 * created via a redirect banner. The pack must be enabled.
 */
export async function provisionPackTemplates(formData: FormData) {
  const session = await ensurePackAdmin();
  const packId = str(formData, "packId");
  if (!packId) return;
  const [pack] = await db.select().from(t.tradePacks).where(eq(t.tradePacks.id, packId));
  if (!pack) return;

  const templates = await packTemplates(packId);
  if (templates.length === 0) {
    revalidatePath("/settings");
    return;
  }

  const created = await withTenant(session.organizationId, async (tx) => {
    // Which of this pack's template names already exist for the org?
    const names = templates.map((tpl) => tpl.name);
    const existing = await tx
      .select({ name: t.inspectionTemplates.name })
      .from(t.inspectionTemplates)
      .where(
        and(
          eq(t.inspectionTemplates.organizationId, session.organizationId),
          inArray(t.inspectionTemplates.name, names)
        )
      );
    const have = new Set(existing.map((e) => e.name));
    const toCreate = templates.filter((tpl) => !have.has(tpl.name));
    if (toCreate.length === 0) return 0;
    await tx.insert(t.inspectionTemplates).values(
      toCreate.map((tpl) => ({
        name: tpl.name,
        tradePackKey: pack.key,
        description: tpl.description ?? null,
        steps: tpl.steps,
        issuesCertification: tpl.issuesCertification ?? null,
        certValidityDays: tpl.certValidityDays ?? null,
      }))
    );
    return toCreate.length;
  });

  await audit(session.userId, "PROVISION_PACK", "TradePack", packId, { key: pack.key, templatesCreated: created });
  revalidatePath("/settings");
  revalidatePath("/compliance");
}
