"use server";

/* M5 inventory management actions — stock rows (start tracking, min/max/bin),
 * location CRUD + truck assignment, warehouse⇄truck transfers, the full PO
 * lifecycle (manual create, line editing, cancel, PER-LINE partial receive,
 * billed), and part-request editing. Guards are loud; every mutation audited. */

import { revalidatePath } from "next/cache";
import { and, asc, eq } from "drizzle-orm";
import { t, withTenant, type TenantDb } from "@/db";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { audit, notify } from "@/lib/actions/helpers";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const num = (f: FormData, k: string) => {
  const n = Number(str(f, k));
  return Number.isFinite(n) ? n : null;
};

async function guardManage() {
  const session = await requireSession();
  if (!can(session.role, "inventory.manage")) throw new Error("Not allowed");
  return session;
}

const revalidate = () => revalidatePath("/inventory");

// ── Stock rows ───────────────────────────────────────────────────────────────

/** Start tracking an item at a location (the empty state finally delivers). */
export async function addStockRow(formData: FormData) {
  const session = await guardManage();
  const locationId = str(formData, "locationId");
  const priceBookItemId = str(formData, "priceBookItemId");
  if (!locationId || !priceBookItemId) return;

  await withTenant(session.organizationId, async (tx) => {
    const existing = await tx.query.stockLevels.findFirst({
      where: and(eq(t.stockLevels.locationId, locationId), eq(t.stockLevels.priceBookItemId, priceBookItemId)),
    });
    if (existing) throw new Error("That item is already tracked at this location — edit its row instead.");
    await tx.insert(t.stockLevels).values({
      locationId,
      priceBookItemId,
      qtyOnHand: num(formData, "qtyOnHand") ?? 0,
      minQty: num(formData, "minQty") ?? 0,
      maxQty: num(formData, "maxQty") ?? 0,
      bin: str(formData, "bin") || null,
    });
  });
  await audit(session.userId, "STOCK_ROW_ADDED", "StockLevel", priceBookItemId, { locationId });
  revalidate();
}

/** Edit min/max/bin on a stock row (counts move via adjust/receive/transfer). */
export async function updateStockRow(formData: FormData) {
  const session = await guardManage();
  const stockId = str(formData, "stockId");
  if (!stockId) return;
  await withTenant(session.organizationId, (tx) =>
    tx
      .update(t.stockLevels)
      .set({
        minQty: num(formData, "minQty") ?? 0,
        maxQty: num(formData, "maxQty") ?? 0,
        bin: str(formData, "bin") || null,
      })
      .where(eq(t.stockLevels.id, stockId))
  );
  await audit(session.userId, "UPDATE", "StockLevel", stockId, {});
  revalidate();
}

// ── Locations ────────────────────────────────────────────────────────────────

export async function createLocation(formData: FormData) {
  const session = await guardManage();
  const name = str(formData, "name");
  const kind = str(formData, "kind") === "TRUCK" ? ("TRUCK" as const) : ("WAREHOUSE" as const);
  if (!name) return;
  const userId = kind === "TRUCK" ? str(formData, "userId") || null : null;

  const [loc] = await withTenant(session.organizationId, async (tx) => {
    if (userId) {
      // inventory_locations.user_id is unique — free the previous truck first.
      await tx.update(t.inventoryLocations).set({ userId: null }).where(eq(t.inventoryLocations.userId, userId));
    }
    return tx.insert(t.inventoryLocations).values({ name, kind, userId }).returning();
  });
  await audit(session.userId, "CREATE", "InventoryLocation", loc.id, { name, kind, userId });
  revalidate();
  revalidatePath("/settings");
}

/** Rename and/or reassign the truck's tech. */
export async function updateLocation(formData: FormData) {
  const session = await guardManage();
  const locationId = str(formData, "locationId");
  const name = str(formData, "name");
  if (!locationId || !name) return;
  const userId = str(formData, "userId") || null;

  const loc = await withTenant(session.organizationId, async (tx) => {
    const existing = await tx.query.inventoryLocations.findFirst({ where: eq(t.inventoryLocations.id, locationId) });
    if (!existing) return null;
    if (userId && userId !== existing.userId) {
      await tx.update(t.inventoryLocations).set({ userId: null }).where(eq(t.inventoryLocations.userId, userId));
    }
    await tx
      .update(t.inventoryLocations)
      .set({ name, userId: existing.kind === "TRUCK" ? userId : null })
      .where(eq(t.inventoryLocations.id, locationId));
    return existing;
  });
  if (!loc) return;
  await audit(session.userId, "UPDATE", "InventoryLocation", locationId, { name, userId });
  if (userId && userId !== loc.userId) {
    await notify(userId, `🚚 Truck assigned to you: ${name}`, "Your truck stock now lives under this location.", "/inventory");
  }
  revalidate();
  revalidatePath("/settings");
}

/** Retire a location — blocked while stock remains on hand. */
export async function retireLocation(formData: FormData) {
  const session = await guardManage();
  const locationId = str(formData, "locationId");
  if (!locationId) return;
  const loc = await withTenant(session.organizationId, async (tx) => {
    const existing = await tx.query.inventoryLocations.findFirst({ where: eq(t.inventoryLocations.id, locationId) });
    if (!existing) return null;
    const stock = await tx.query.stockLevels.findMany({ where: eq(t.stockLevels.locationId, locationId) });
    const onHand = stock.reduce((s, r) => s + r.qtyOnHand, 0);
    if (onHand > 0) {
      throw new Error(`Can't retire — ${onHand} unit(s) still on hand here. Transfer the stock out first.`);
    }
    await tx.delete(t.inventoryLocations).where(eq(t.inventoryLocations.id, locationId));
    return existing;
  });
  if (!loc) return;
  await audit(session.userId, "LOCATION_RETIRED", "InventoryLocation", locationId, { name: loc.name });
  revalidate();
}

// ── Transfers ────────────────────────────────────────────────────────────────

/** Move stock warehouse⇄truck — the daily flow. Creates the destination row if needed. */
export async function transferStock(formData: FormData) {
  const session = await guardManage();
  const stockId = str(formData, "stockId"); // source row
  const toLocationId = str(formData, "toLocationId");
  const qty = num(formData, "qty");
  if (!stockId || !toLocationId || !qty || qty <= 0) return;

  const detail = await withTenant(session.organizationId, async (tx) => {
    const source = await tx.query.stockLevels.findFirst({
      where: eq(t.stockLevels.id, stockId),
      with: { priceBookItem: true },
    });
    if (!source) throw new Error("Source stock row not found");
    if (source.locationId === toLocationId) throw new Error("Source and destination are the same location");
    if (source.qtyOnHand < qty) throw new Error(`Only ${source.qtyOnHand} on hand — can't transfer ${qty}.`);

    await tx.update(t.stockLevels).set({ qtyOnHand: source.qtyOnHand - qty }).where(eq(t.stockLevels.id, stockId));
    const dest = await tx.query.stockLevels.findFirst({
      where: and(eq(t.stockLevels.locationId, toLocationId), eq(t.stockLevels.priceBookItemId, source.priceBookItemId)),
    });
    if (dest) {
      await tx.update(t.stockLevels).set({ qtyOnHand: dest.qtyOnHand + qty }).where(eq(t.stockLevels.id, dest.id));
    } else {
      await tx.insert(t.stockLevels).values({
        locationId: toLocationId,
        priceBookItemId: source.priceBookItemId,
        qtyOnHand: qty,
      });
    }
    return { item: source.priceBookItem.name, from: source.locationId, to: toLocationId };
  });
  await audit(session.userId, "STOCK_TRANSFER", "StockLevel", stockId, { ...detail, qty });
  revalidate();
}

// ── Purchase orders ──────────────────────────────────────────────────────────

const PO_OPEN = new Set(["DRAFT", "SENT"]);

async function nextPoNumber(tx: TenantDb): Promise<string> {
  const rows = await tx.select({ n: t.purchaseOrders.number }).from(t.purchaseOrders);
  let max = 5000;
  for (const r of rows) {
    const m = /(\d+)$/.exec(r.n);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `PO-${max + 1}`;
}

/** Manual PO — not only via the replenishment button. */
export async function createPurchaseOrder(formData: FormData) {
  const session = await guardManage();
  const supplier = str(formData, "supplier");
  if (!supplier) return;
  const expected = str(formData, "expectedAt");
  const [po] = await withTenant(session.organizationId, async (tx) => {
    const number = await nextPoNumber(tx);
    return tx
      .insert(t.purchaseOrders)
      .values({ number, supplier, status: "DRAFT", expectedAt: expected ? new Date(expected) : null })
      .returning();
  });
  await audit(session.userId, "CREATE", "PurchaseOrder", po.id, { number: po.number, supplier });
  revalidate();
}

export async function updatePurchaseOrder(formData: FormData) {
  const session = await guardManage();
  const poId = str(formData, "poId");
  const supplier = str(formData, "supplier");
  if (!poId || !supplier) return;
  const expected = str(formData, "expectedAt");
  await withTenant(session.organizationId, async (tx) => {
    const po = await tx.query.purchaseOrders.findFirst({ where: eq(t.purchaseOrders.id, poId) });
    if (!po) throw new Error("PO not found");
    if (!PO_OPEN.has(po.status)) throw new Error(`A ${po.status} PO can't be edited`);
    await tx
      .update(t.purchaseOrders)
      .set({ supplier, expectedAt: expected ? new Date(expected) : null })
      .where(eq(t.purchaseOrders.id, poId));
  });
  await audit(session.userId, "UPDATE", "PurchaseOrder", poId, { supplier });
  revalidate();
}

export async function cancelPurchaseOrder(formData: FormData) {
  const session = await guardManage();
  const poId = str(formData, "poId");
  if (!poId) return;
  const po = await withTenant(session.organizationId, async (tx) => {
    const po = await tx.query.purchaseOrders.findFirst({ where: eq(t.purchaseOrders.id, poId), with: { lines: true } });
    if (!po) throw new Error("PO not found");
    if (!PO_OPEN.has(po.status)) throw new Error(`A ${po.status} PO can't be cancelled — stock already moved`);
    if (po.lines.some((l) => l.receivedQty > 0)) throw new Error("Lines have been received — the PO can't be cancelled");
    await tx.update(t.purchaseOrders).set({ status: "CANCELLED" }).where(eq(t.purchaseOrders.id, poId));
    return po;
  });
  await audit(session.userId, "PO_CANCELLED", "PurchaseOrder", poId, { number: po.number });
  revalidate();
}

export async function addPoLine(formData: FormData) {
  const session = await guardManage();
  const poId = str(formData, "poId");
  const priceBookItemId = str(formData, "priceBookItemId");
  const qty = num(formData, "qty");
  if (!poId || !priceBookItemId || !qty || qty <= 0) return;
  await withTenant(session.organizationId, async (tx) => {
    const po = await tx.query.purchaseOrders.findFirst({ where: eq(t.purchaseOrders.id, poId) });
    if (!po || !PO_OPEN.has(po.status)) throw new Error("Lines can only be added while the PO is open");
    const item = await tx.query.priceBookItems.findFirst({ where: eq(t.priceBookItems.id, priceBookItemId) });
    if (!item) throw new Error("Price book item not found");
    await tx.insert(t.purchaseOrderLines).values({
      purchaseOrderId: poId,
      priceBookItemId,
      qty,
      unitCostCents: num(formData, "unitCost") != null ? Math.round(num(formData, "unitCost")! * 100) : item.unitCostCents,
    });
  });
  revalidate();
}

export async function updatePoLine(formData: FormData) {
  const session = await guardManage();
  const lineId = str(formData, "lineId");
  const qty = num(formData, "qty");
  if (!lineId || !qty || qty <= 0) return;
  await withTenant(session.organizationId, async (tx) => {
    const line = await tx.query.purchaseOrderLines.findFirst({
      where: eq(t.purchaseOrderLines.id, lineId),
      with: { purchaseOrder: true },
    });
    if (!line || !PO_OPEN.has(line.purchaseOrder.status)) throw new Error("Lines can only be edited while the PO is open");
    if (qty < line.receivedQty) throw new Error("Qty can't drop below what's already been received");
    const cost = num(formData, "unitCost");
    await tx
      .update(t.purchaseOrderLines)
      .set({ qty, unitCostCents: cost != null ? Math.round(cost * 100) : line.unitCostCents })
      .where(eq(t.purchaseOrderLines.id, lineId));
  });
  revalidate();
}

export async function removePoLine(formData: FormData) {
  const session = await guardManage();
  const lineId = str(formData, "lineId");
  if (!lineId) return;
  await withTenant(session.organizationId, async (tx) => {
    const line = await tx.query.purchaseOrderLines.findFirst({
      where: eq(t.purchaseOrderLines.id, lineId),
      with: { purchaseOrder: true },
    });
    if (!line || !PO_OPEN.has(line.purchaseOrder.status)) throw new Error("Lines can only be removed while the PO is open");
    if (line.receivedQty > 0) throw new Error("This line has received stock — it can't be removed");
    await tx.delete(t.purchaseOrderLines).where(eq(t.purchaseOrderLines.id, lineId));
  });
  revalidate();
}

/** PER-LINE partial receive — the schema's PARTIAL status finally works.
 *  Received units land in the first warehouse's stock. */
export async function receivePoLine(formData: FormData) {
  const session = await guardManage();
  const lineId = str(formData, "lineId");
  const qty = num(formData, "qty");
  if (!lineId || !qty || qty <= 0) return;

  const result = await withTenant(session.organizationId, async (tx) => {
    const line = await tx.query.purchaseOrderLines.findFirst({
      where: eq(t.purchaseOrderLines.id, lineId),
      with: { purchaseOrder: { with: { lines: true } }, priceBookItem: true },
    });
    if (!line) throw new Error("PO line not found");
    const po = line.purchaseOrder;
    if (po.status === "RECEIVED" || po.status === "BILLED" || po.status === "CANCELLED") {
      throw new Error(`A ${po.status} PO can't receive stock`);
    }
    const remaining = line.qty - line.receivedQty;
    if (qty > remaining) throw new Error(`Only ${remaining} still outstanding on this line`);

    await tx
      .update(t.purchaseOrderLines)
      .set({ receivedQty: line.receivedQty + qty })
      .where(eq(t.purchaseOrderLines.id, lineId));

    // Land the units in the first warehouse.
    const warehouse = await tx.query.inventoryLocations.findFirst({
      where: eq(t.inventoryLocations.kind, "WAREHOUSE"),
      orderBy: asc(t.inventoryLocations.name),
    });
    if (warehouse) {
      const stock = await tx.query.stockLevels.findFirst({
        where: and(eq(t.stockLevels.locationId, warehouse.id), eq(t.stockLevels.priceBookItemId, line.priceBookItemId)),
      });
      if (stock) {
        await tx.update(t.stockLevels).set({ qtyOnHand: stock.qtyOnHand + qty }).where(eq(t.stockLevels.id, stock.id));
      } else {
        await tx.insert(t.stockLevels).values({
          locationId: warehouse.id,
          priceBookItemId: line.priceBookItemId,
          qtyOnHand: qty,
        });
      }
    }

    // Recompute PO status from ALL lines (this one just changed).
    const fresh = po.lines.map((l) => (l.id === lineId ? { ...l, receivedQty: l.receivedQty + qty } : l));
    const allDone = fresh.every((l) => l.receivedQty >= l.qty);
    await tx
      .update(t.purchaseOrders)
      .set({ status: allDone ? "RECEIVED" : "PARTIAL" })
      .where(eq(t.purchaseOrders.id, po.id));
    return { number: po.number, item: line.priceBookItem.name, allDone };
  });

  await audit(session.userId, "PO_LINE_RECEIVED", "PurchaseOrder", lineId, { ...result, qty });
  revalidate();
}

/** RECEIVED → BILLED once the supplier invoice lands. */
export async function markPoBilled(formData: FormData) {
  const session = await guardManage();
  const poId = str(formData, "poId");
  if (!poId) return;
  const po = await withTenant(session.organizationId, async (tx) => {
    const po = await tx.query.purchaseOrders.findFirst({ where: eq(t.purchaseOrders.id, poId) });
    if (!po) throw new Error("PO not found");
    if (po.status !== "RECEIVED") throw new Error("Only fully received POs can be marked billed");
    await tx.update(t.purchaseOrders).set({ status: "BILLED" }).where(eq(t.purchaseOrders.id, poId));
    return po;
  });
  await audit(session.userId, "PO_BILLED", "PurchaseOrder", poId, { number: po.number });
  revalidate();
}

// ── Part requests ────────────────────────────────────────────────────────────

/** Edit qty/description while OPEN (requester or office). */
export async function updatePartRequest(formData: FormData) {
  const session = await requireSession();
  const requestId = str(formData, "requestId");
  const description = str(formData, "description");
  const qty = num(formData, "qty");
  if (!requestId || !description || !qty || qty <= 0) return;
  await withTenant(session.organizationId, async (tx) => {
    const req = await tx.query.partRequests.findFirst({ where: eq(t.partRequests.id, requestId) });
    if (!req) throw new Error("Part request not found");
    if (req.status !== "OPEN") throw new Error("Only OPEN requests can be edited");
    if (req.requestedById !== session.userId && !can(session.role, "inventory.manage")) {
      throw new Error("You can only edit your own requests");
    }
    await tx.update(t.partRequests).set({ description, qty }).where(eq(t.partRequests.id, requestId));
  });
  await audit(session.userId, "UPDATE", "PartRequest", requestId, { qty });
  revalidate();
}
