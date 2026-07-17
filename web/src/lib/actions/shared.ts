"use server";

import { db, t, withTenant } from "@/db";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { audit, logActivity, notify } from "@/lib/actions/helpers";
import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const num = (v: FormDataEntryValue | null) => {
  const n = parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};
const dollarsToCents = (v: FormDataEntryValue | null) => Math.round(num(v) * 100);

// ── Knowledge base ───────────────────────────────────────────────────────────

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

const KB_CATEGORIES = ["SOP", "POLICY", "EQUIPMENT", "SAFETY", "HR", "EMERGENCY"] as const;
type KbCategory = (typeof KB_CATEGORIES)[number];

export async function createKbArticle(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "kb.author")) throw new Error("Not allowed");

  const title = str(formData.get("title"));
  const body = str(formData.get("body"));
  const rawCat = str(formData.get("category"));
  const category: KbCategory = (KB_CATEGORIES as readonly string[]).includes(rawCat)
    ? (rawCat as KbCategory)
    : "SOP";
  const tags = str(formData.get("tags"))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!title || !body) return;

  let slug = slugify(title) || "article";
  // Org-scoped: uniqueness + insert run inside the tenant transaction so RLS
  // filters and the organization_id column default populates from the GUC.
  const article = await withTenant(session.organizationId, async (tx) => {
    const existing = await tx.select({ slug: t.kbArticles.slug }).from(t.kbArticles);
    const taken = new Set(existing.map((r) => r.slug));
    if (taken.has(slug)) {
      let i = 2;
      while (taken.has(`${slug}-${i}`)) i++;
      slug = `${slug}-${i}`;
    }
    const [row] = await tx
      .insert(t.kbArticles)
      .values({ slug, title, category, body, tags, authorId: session.userId })
      .returning();
    return row;
  });
  await audit(session.userId, "CREATE", "KbArticle", article.id, { title, category });

  // Stage into the company knowledge substrate (OrgMemory) when connected.
  // Constraint 6: this is a STAGED CANDIDATE — a human reviewer promotes to canon.
  const { getKnowledgeStore } = await import("@/lib/knowledge/store");
  const store = await getKnowledgeStore(session.organizationId);
  const result = await store.stageDocument({ id: article.id, slug, title, category, body, tags });
  if (result.degraded) {
    // Loud, visible failure — never silently pretend the mirror worked.
    await notify(
      session.userId,
      "⚠️ OrgMemory staging failed",
      `Article saved locally, but staging to OrgMemory failed: ${result.message ?? "gateway unreachable"}. Reconnect in Settings → Integrations.`,
      "/settings?tab=integrations"
    );
  }

  revalidatePath("/kb");
  redirect(`/kb/${slug}`);
}

export async function suggestKbArticle(formData: FormData) {
  const session = await requireSession();
  const title = str(formData.get("title"));
  const body = str(formData.get("body"));
  if (!title) return;

  const admins = await db
    .select()
    .from(t.users)
    .where(and(eq(t.users.role, "ADMIN"), eq(t.users.active, true)));
  for (const admin of admins) {
    await notify(
      admin.id,
      `KB suggestion from ${session.name}: ${title}`,
      body ? body.slice(0, 200) : undefined,
      "/kb"
    );
  }
  redirect("/kb?suggested=1");
}

export async function markKbVerified(formData: FormData) {
  const session = await requireSession();
  if (session.role !== "ADMIN") throw new Error("Not allowed");
  const id = str(formData.get("id"));
  const slug = str(formData.get("slug"));
  await withTenant(session.organizationId, (tx) =>
    tx.update(t.kbArticles).set({ verifiedAt: new Date() }).where(eq(t.kbArticles.id, id))
  );
  await audit(session.userId, "VERIFY", "KbArticle", id);
  revalidatePath(`/kb/${slug}`);
  revalidatePath("/kb");
}

export async function kbFeedback(formData: FormData) {
  const session = await requireSession();
  const title = str(formData.get("title"));
  const slug = str(formData.get("slug"));
  const helpful = str(formData.get("helpful")) === "yes";
  await logActivity({
    kind: "SYSTEM",
    body: `KB feedback: "${title}" marked ${helpful ? "helpful 👍" : "not helpful 👎"} by ${session.name}`,
    userId: session.userId,
  });
  redirect(`/kb/${slug}?fb=1`);
}

// ── Inventory ────────────────────────────────────────────────────────────────

export async function adjustStock(formData: FormData) {
  const session = await requireSession();
  const stockId = str(formData.get("stockId"));
  const amount = Math.abs(num(formData.get("amount"))) || 1;
  const dir = str(formData.get("dir")) === "-" ? -1 : 1;

  const row = await db.query.stockLevels.findFirst({
    where: eq(t.stockLevels.id, stockId),
    with: { location: true, priceBookItem: true },
  });
  if (!row) return;
  const ownTruck = row.location.userId === session.userId;
  if (!can(session.role, "inventory.manage") && !ownTruck) throw new Error("Not allowed");

  const newQty = Math.max(0, row.qtyOnHand + dir * amount);
  await db.update(t.stockLevels).set({ qtyOnHand: newQty }).where(eq(t.stockLevels.id, stockId));
  await audit(session.userId, "STOCK_ADJUST", "StockLevel", stockId, {
    item: row.priceBookItem.code,
    location: row.location.name,
    from: row.qtyOnHand,
    to: newQty,
  });
  revalidatePath("/inventory");
}

export async function createPoFromReplenishment() {
  const session = await requireSession();
  if (!can(session.role, "inventory.manage")) throw new Error("Not allowed");

  const stock = await db.query.stockLevels.findMany({ with: { priceBookItem: true } });
  const low = stock.filter((s) => s.qtyOnHand <= s.minQty && s.maxQty > s.qtyOnHand);
  if (low.length === 0) return;

  // Aggregate needed qty per item (top each low row up to max)
  const needed = new Map<string, { qty: number; unitCostCents: number }>();
  for (const s of low) {
    const add = s.maxQty - s.qtyOnHand;
    const cur = needed.get(s.priceBookItemId);
    if (cur) cur.qty += add;
    else needed.set(s.priceBookItemId, { qty: add, unitCostCents: s.priceBookItem.unitCostCents });
  }

  // Next PO number
  const pos = await db.select({ number: t.purchaseOrders.number }).from(t.purchaseOrders);
  const max = pos.reduce((m, p) => {
    const n = parseInt(p.number.replace(/^PO-/, ""), 10);
    return Number.isFinite(n) && n > m ? n : m;
  }, 3100);
  const number = `PO-${max + 1}`;

  const [po] = await db
    .insert(t.purchaseOrders)
    .values({ number, supplier: "Ferguson", status: "DRAFT" })
    .returning();
  await db.insert(t.purchaseOrderLines).values(
    Array.from(needed.entries()).map(([priceBookItemId, l]) => ({
      purchaseOrderId: po.id,
      priceBookItemId,
      qty: l.qty,
      unitCostCents: l.unitCostCents,
    }))
  );
  await audit(session.userId, "CREATE", "PurchaseOrder", po.id, {
    number,
    supplier: "Ferguson",
    lines: needed.size,
    source: "replenishment",
  });
  revalidatePath("/inventory");
  redirect(`/inventory#po-${po.id}`);
}

export async function advancePartRequest(formData: FormData) {
  const session = await requireSession();
  const id = str(formData.get("id"));
  const action = str(formData.get("action")); // ORDERED | FULFILLED | CANCELLED

  const req = await db.query.partRequests.findFirst({
    where: eq(t.partRequests.id, id),
    with: { requestedBy: true, priceBookItem: true },
  });
  if (!req) return;

  if (action === "CANCELLED") {
    const own = req.requestedById === session.userId;
    if (!own && !can(session.role, "inventory.manage")) throw new Error("Not allowed");
    await db.update(t.partRequests).set({ status: "CANCELLED" }).where(eq(t.partRequests.id, id));
    await audit(session.userId, "CANCEL", "PartRequest", id, { description: req.description });
  } else if (action === "ORDERED" || action === "FULFILLED") {
    if (!can(session.role, "inventory.manage")) throw new Error("Not allowed");
    await db
      .update(t.partRequests)
      .set({ status: action })
      .where(eq(t.partRequests.id, id));

    if (action === "FULFILLED" && req.priceBookItemId) {
      // Add qty into the requester's truck stock, if they have one
      const truck = await db.query.inventoryLocations.findFirst({
        where: eq(t.inventoryLocations.userId, req.requestedById),
      });
      if (truck) {
        await db
          .insert(t.stockLevels)
          .values({ locationId: truck.id, priceBookItemId: req.priceBookItemId, qtyOnHand: req.qty })
          .onConflictDoUpdate({
            target: [t.stockLevels.locationId, t.stockLevels.priceBookItemId],
            set: { qtyOnHand: sql`${t.stockLevels.qtyOnHand} + ${req.qty}` },
          });
      }
    }
    await notify(
      req.requestedById,
      `Part request ${action === "ORDERED" ? "ordered" : "fulfilled"}: ${req.priceBookItem?.name ?? req.description}`,
      action === "FULFILLED" && req.priceBookItemId ? "Quantity added to your truck stock." : undefined,
      "/inventory"
    );
    await audit(session.userId, `PART_REQUEST_${action}`, "PartRequest", id, {
      description: req.description,
      qty: req.qty,
    });
  }
  revalidatePath("/inventory");
}

export async function receivePurchaseOrder(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "inventory.manage")) throw new Error("Not allowed");
  const poId = str(formData.get("poId"));

  const po = await db.query.purchaseOrders.findFirst({
    where: eq(t.purchaseOrders.id, poId),
    with: { lines: true },
  });
  if (!po || po.status === "RECEIVED" || po.status === "BILLED") return;

  const warehouse = await db.query.inventoryLocations.findFirst({
    where: eq(t.inventoryLocations.kind, "WAREHOUSE"),
  });

  for (const line of po.lines) {
    const remaining = line.qty - line.receivedQty;
    await db
      .update(t.purchaseOrderLines)
      .set({ receivedQty: line.qty })
      .where(eq(t.purchaseOrderLines.id, line.id));
    if (warehouse && remaining > 0) {
      await db
        .insert(t.stockLevels)
        .values({ locationId: warehouse.id, priceBookItemId: line.priceBookItemId, qtyOnHand: remaining })
        .onConflictDoUpdate({
          target: [t.stockLevels.locationId, t.stockLevels.priceBookItemId],
          set: { qtyOnHand: sql`${t.stockLevels.qtyOnHand} + ${remaining}` },
        });
    }
  }
  await db.update(t.purchaseOrders).set({ status: "RECEIVED" }).where(eq(t.purchaseOrders.id, poId));
  await audit(session.userId, "RECEIVE", "PurchaseOrder", poId, {
    number: po.number,
    lines: po.lines.length,
  });
  revalidatePath("/inventory");
}

// ── Price book ───────────────────────────────────────────────────────────────

export async function updatePriceBookItem(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "pricebook.edit")) throw new Error("Not allowed");
  const id = str(formData.get("id"));
  const unitPriceCents = dollarsToCents(formData.get("price"));
  const unitCostCents = dollarsToCents(formData.get("cost"));

  const [before] = await db.select().from(t.priceBookItems).where(eq(t.priceBookItems.id, id));
  if (!before) return;
  await db
    .update(t.priceBookItems)
    .set({ unitPriceCents, unitCostCents })
    .where(eq(t.priceBookItems.id, id));
  await audit(session.userId, "UPDATE", "PriceBookItem", id, {
    code: before.code,
    priceFrom: before.unitPriceCents,
    priceTo: unitPriceCents,
    costFrom: before.unitCostCents,
    costTo: unitCostCents,
  });
  revalidatePath("/pricebook");
}

export async function togglePriceBookItemActive(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "pricebook.edit")) throw new Error("Not allowed");
  const id = str(formData.get("id"));
  const [item] = await db.select().from(t.priceBookItems).where(eq(t.priceBookItems.id, id));
  if (!item) return;
  await db.update(t.priceBookItems).set({ active: !item.active }).where(eq(t.priceBookItems.id, id));
  await audit(session.userId, item.active ? "DEACTIVATE" : "ACTIVATE", "PriceBookItem", id, {
    code: item.code,
  });
  revalidatePath("/pricebook");
}

export async function addPriceBookItem(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "pricebook.edit")) throw new Error("Not allowed");
  const code = str(formData.get("code")).toUpperCase();
  const name = str(formData.get("name"));
  const category = str(formData.get("category")) || "Uncategorized";
  const unitCostCents = dollarsToCents(formData.get("cost"));
  const unitPriceCents = dollarsToCents(formData.get("price"));
  const laborRaw = str(formData.get("laborHours"));
  const laborHours = laborRaw ? num(laborRaw) : null;
  const description = str(formData.get("description")) || null;
  if (!code || !name || !unitPriceCents) return;

  const [item] = await db
    .insert(t.priceBookItems)
    .values({ code, name, category, unitCostCents, unitPriceCents, laborHours, description })
    .returning();
  await audit(session.userId, "CREATE", "PriceBookItem", item.id, { code, name, unitPriceCents });
  revalidatePath("/pricebook");
}

// ── Commissions ──────────────────────────────────────────────────────────────

export async function setCommissionStatus(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "commissions.view.all")) throw new Error("Not allowed");
  const id = str(formData.get("id"));
  const status = str(formData.get("status"));
  if (status !== "APPROVED" && status !== "PAID") return;

  const entry = await db.query.commissionEntries.findFirst({
    where: eq(t.commissionEntries.id, id),
    with: { user: true },
  });
  if (!entry) return;
  await db.update(t.commissionEntries).set({ status }).where(eq(t.commissionEntries.id, id));
  await audit(session.userId, status === "APPROVED" ? "APPROVE" : "MARK_PAID", "CommissionEntry", id, {
    user: entry.user.name,
    amountCents: entry.amountCents,
  });
  await notify(
    entry.userId,
    status === "APPROVED"
      ? `Commission approved: ${entry.description}`
      : `Commission paid: ${entry.description}`,
    undefined,
    "/earnings"
  );
  revalidatePath("/commissions");
}

export async function rejectCommission(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "commissions.view.all")) throw new Error("Not allowed");
  const id = str(formData.get("id"));
  const entry = await db.query.commissionEntries.findFirst({
    where: eq(t.commissionEntries.id, id),
    with: { user: true },
  });
  if (!entry) return;
  await db.delete(t.commissionEntries).where(eq(t.commissionEntries.id, id));
  await audit(session.userId, "REJECT", "CommissionEntry", id, {
    user: entry.user.name,
    description: entry.description,
    amountCents: entry.amountCents,
  });
  revalidatePath("/commissions");
}
