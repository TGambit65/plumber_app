import Link from "next/link";
import { t, withTenant } from "@/db";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { desc, eq, inArray } from "drizzle-orm";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageHeader,
  Table,
  TCell,
  THead,
  TRow,
  type BadgeTone,
} from "@/components/ui";
import { money, fmtDate } from "@/lib/format";
import { clsx } from "@/lib/clsx";
import { adjustStock, advancePartRequest, createPoFromReplenishment, receivePurchaseOrder } from "@/lib/actions/shared";
import {
  addPoLine,
  addStockRow,
  cancelPurchaseOrder,
  createLocation,
  createPurchaseOrder,
  markPoBilled,
  receivePoLine,
  removePoLine,
  retireLocation,
  transferStock,
  updateLocation,
  updatePartRequest,
  updatePoLine,
  updatePurchaseOrder,
  updateStockRow,
} from "@/lib/actions/inventory";
import { Field, Input, Select } from "@/components/ui";

export const dynamic = "force-dynamic";

const PO_TONE: Record<string, BadgeTone> = {
  DRAFT: "slate",
  SENT: "blue",
  PARTIAL: "amber",
  RECEIVED: "green",
  BILLED: "violet",
  CANCELLED: "red",
};
const REQ_TONE: Record<string, BadgeTone> = {
  OPEN: "blue",
  ORDERED: "amber",
  FULFILLED: "green",
  CANCELLED: "slate",
};

type StockRow = typeof t.stockLevels.$inferSelect & {
  priceBookItem: typeof t.priceBookItems.$inferSelect;
};

function stockStatus(s: { qtyOnHand: number; minQty: number }) {
  if (s.qtyOnHand === 0) return <Badge tone="red">OUT</Badge>;
  if (s.qtyOnHand <= s.minQty) return <Badge tone="amber">LOW</Badge>;
  return <Badge tone="green">OK</Badge>;
}

function AdjustForm({ stockId, big }: { stockId: string; big?: boolean }) {
  const size = big ? "lg" : "sm";
  return (
    <form action={adjustStock} className="flex items-center gap-1.5">
      <input type="hidden" name="stockId" value={stockId} />
      <Button type="submit" name="dir" value="-" variant="secondary" size={size} aria-label="Decrease">
        −
      </Button>
      <input
        type="number"
        name="amount"
        defaultValue={1}
        min={1}
        step="any"
        className={clsx(
          "rounded-lg border border-slate-300 text-center text-sm tabular-nums focus:border-blue-500 focus:outline-none",
          big ? "h-12 w-16" : "h-8 w-14"
        )}
      />
      <Button type="submit" name="dir" value="+" variant="secondary" size={size} aria-label="Increase">
        +
      </Button>
    </form>
  );
}

export default async function InventoryPage({ searchParams }: { searchParams: { loc?: string } }) {
  const session = await requireSession();
  const manage = can(session.role, "inventory.manage");
  const isTech = session.role === "TECH";

  // All page queries run in ONE tenant-scoped transaction.
  const { visible, allStock, requestsRaw, pos, techUsers, priceBook } = await withTenant(session.organizationId, async (tx) => {
    const allLocations = await tx.query.inventoryLocations.findMany({ with: { user: true } });
    const visibleLocs = (isTech ? allLocations.filter((l) => l.userId === session.userId) : allLocations).sort(
      (a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "WAREHOUSE" ? -1 : 1)
    );

    const visibleIds = visibleLocs.map((l) => l.id);
    const stock =
      visibleIds.length === 0
        ? []
        : ((await tx.query.stockLevels.findMany({
            where: inArray(t.stockLevels.locationId, visibleIds),
            with: { priceBookItem: true },
          })) as (StockRow & { locationId: string })[]);

    const reqs = await tx.query.partRequests.findMany({
      with: { requestedBy: true, job: true, priceBookItem: true },
      orderBy: [desc(t.partRequests.createdAt)],
    });

    const purchaseOrders = isTech
      ? []
      : await tx.query.purchaseOrders.findMany({
          with: { lines: { with: { priceBookItem: true } } },
          orderBy: [desc(t.purchaseOrders.createdAt)],
        });

    // M5: managers get techs (truck assignment) + the price book (stock rows / PO lines).
    const techUsers = isTech
      ? []
      : await tx.query.users.findMany({ where: eq(t.users.active, true), orderBy: [t.users.name] });
    const priceBook = isTech
      ? []
      : await tx.query.priceBookItems.findMany({
          where: eq(t.priceBookItems.active, true),
          orderBy: [t.priceBookItems.category, t.priceBookItems.name],
        });

    return { visible: visibleLocs, allStock: stock, requestsRaw: reqs, pos: purchaseOrders, techUsers, priceBook };
  });

  if (visible.length === 0) {
    return (
      <div>
        <PageHeader title="🧰 Truck Stock" />
        <EmptyState title="No truck assigned to you yet" hint="Ask the office to set up a stock location for your truck." />
      </div>
    );
  }

  const selected = isTech ? visible[0] : visible.find((l) => l.id === searchParams.loc) ?? visible[0];

  const selectedStock = allStock
    .filter((s) => s.locationId === selected.id)
    .sort((a, b) => a.priceBookItem.name.localeCompare(b.priceBookItem.name));

  const lowByLocation = visible
    .map((loc) => ({
      loc,
      rows: allStock
        .filter((s) => s.locationId === loc.id && s.qtyOnHand <= s.minQty && s.maxQty > s.qtyOnHand)
        .sort((a, b) => a.priceBookItem.name.localeCompare(b.priceBookItem.name)),
    }))
    .filter((g) => g.rows.length > 0);
  const lowCount = lowByLocation.reduce((n, g) => n + g.rows.length, 0);

  const requests = requestsRaw.filter(
    (r) => (r.status === "OPEN" || r.status === "ORDERED") && (!isTech || r.requestedById === session.userId)
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={isTech ? "🧰 Truck Stock" : "🧰 Inventory"}
        subtitle={
          isTech
            ? `${selected.name} — adjust counts as you use parts`
            : "Warehouse & truck stock, replenishment, part requests and purchase orders"
        }
      />

      {/* Location filter (office/admin) */}
      {!isTech && visible.length > 1 ? (
        <div className="flex flex-wrap gap-2">
          {visible.map((loc) => (
            <Link
              key={loc.id}
              href={`/inventory?loc=${loc.id}`}
              className={clsx(
                "rounded-full border px-3 py-1 text-xs font-medium",
                selected.id === loc.id
                  ? "border-blue-600 bg-blue-600 text-white"
                  : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
              )}
            >
              {loc.kind === "WAREHOUSE" ? "🏭" : "🚚"} {loc.name}
            </Link>
          ))}
        </div>
      ) : null}

      {/* Stock at selected location */}
      <Card>
        <CardHeader
          title={`Stock — ${selected.name}`}
          subtitle={`${selectedStock.length} item${selectedStock.length === 1 ? "" : "s"} tracked`}
        />
        <CardBody className={isTech ? "p-0" : undefined}>
          {selectedStock.length === 0 ? (
            <div className={isTech ? "p-4" : undefined}>
              <EmptyState title="No stock tracked at this location" hint="Receive a purchase order or add stock rows." />
            </div>
          ) : isTech ? (
            /* Mobile-first big rows for techs */
            <ul className="divide-y divide-slate-100">
              {selectedStock.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-base font-medium text-slate-900">{s.priceBookItem.name}</span>
                      {stockStatus(s)}
                    </div>
                    <div className="mt-0.5 text-sm text-slate-500">
                      {s.priceBookItem.code}
                      {s.bin ? ` · ${s.bin}` : ""} · min {s.minQty} / max {s.maxQty}
                    </div>
                  </div>
                  <div className="text-2xl font-semibold tabular-nums text-slate-900">{s.qtyOnHand}</div>
                  <AdjustForm stockId={s.id} big />
                </li>
              ))}
            </ul>
          ) : (
            <Table>
              <THead cols={["Code", "Item", "Category", "Bin", "On hand", "Min / Max", "Status", "Adjust"]} />
              <tbody>
                {selectedStock.map((s) => (
                  <TRow key={s.id}>
                    <TCell className="font-mono text-xs">{s.priceBookItem.code}</TCell>
                    <TCell className="font-medium text-slate-900">{s.priceBookItem.name}</TCell>
                    <TCell>{s.priceBookItem.category}</TCell>
                    <TCell>{s.bin ?? "—"}</TCell>
                    <TCell className="tabular-nums font-semibold">{s.qtyOnHand}</TCell>
                    <TCell className="tabular-nums text-slate-500">
                      {s.minQty} / {s.maxQty}
                    </TCell>
                    <TCell>{stockStatus(s)}</TCell>
                    <TCell>
                      <div className="space-y-1">
                        <AdjustForm stockId={s.id} />
                        {manage ? (
                          <div className="flex flex-wrap gap-1.5">
                            <details>
                              <summary className="cursor-pointer rounded px-1 py-0.5 text-[11px] font-medium text-blue-600 hover:bg-blue-50">✏️ min/max/bin</summary>
                              <form action={updateStockRow} className="mt-1.5 flex items-end gap-1.5">
                                <input type="hidden" name="stockId" value={s.id} />
                                <Input name="minQty" type="number" step="any" defaultValue={s.minQty} aria-label="Min qty" className="h-8 w-16 text-xs" />
                                <Input name="maxQty" type="number" step="any" defaultValue={s.maxQty} aria-label="Max qty" className="h-8 w-16 text-xs" />
                                <Input name="bin" defaultValue={s.bin ?? ""} placeholder="bin" aria-label="Bin" className="h-8 w-16 text-xs" />
                                <Button type="submit" size="sm" variant="secondary">Save</Button>
                              </form>
                            </details>
                            {visible.length > 1 ? (
                              <details>
                                <summary className="cursor-pointer rounded px-1 py-0.5 text-[11px] font-medium text-violet-600 hover:bg-violet-50">↔ Transfer</summary>
                                <form action={transferStock} className="mt-1.5 flex items-end gap-1.5">
                                  <input type="hidden" name="stockId" value={s.id} />
                                  <Input name="qty" type="number" step="any" min="0.5" defaultValue="1" aria-label="Qty" className="h-8 w-14 text-xs" />
                                  <Select name="toLocationId" required defaultValue="" aria-label="Destination" className="h-8 w-32 text-xs">
                                    <option value="" disabled>to…</option>
                                    {visible.filter((l) => l.id !== selected.id).map((l) => (
                                      <option key={l.id} value={l.id}>{l.kind === "WAREHOUSE" ? "🏭" : "🚚"} {l.name}</option>
                                    ))}
                                  </Select>
                                  <Button type="submit" size="sm" variant="secondary">Go</Button>
                                </form>
                              </details>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </TCell>
                  </TRow>
                ))}
              </tbody>
            </Table>
          )}
          {/* M5: start tracking an item here */}
          {manage && !isTech ? (
            <form action={addStockRow} className="mt-3 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3">
              <input type="hidden" name="locationId" value={selected.id} />
              <div className="min-w-[220px] flex-1">
                <Field label="Track a new item here">
                  <Select name="priceBookItemId" required defaultValue="">
                    <option value="" disabled>Choose price book item…</option>
                    {priceBook.map((i) => (
                      <option key={i.id} value={i.id}>{i.category} · {i.name} ({i.code})</option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div className="w-20"><Field label="On hand"><Input name="qtyOnHand" type="number" step="any" defaultValue="0" /></Field></div>
              <div className="w-20"><Field label="Min"><Input name="minQty" type="number" step="any" defaultValue="0" /></Field></div>
              <div className="w-20"><Field label="Max"><Input name="maxQty" type="number" step="any" defaultValue="0" /></Field></div>
              <div className="w-24"><Field label="Bin"><Input name="bin" placeholder="A-3" /></Field></div>
              <Button type="submit" size="sm">＋ Track item</Button>
            </form>
          ) : null}
        </CardBody>
      </Card>

      {/* M5: locations manager */}
      {manage && !isTech ? (
        <Card>
          <CardHeader title="📍 Locations" subtitle="Warehouses & trucks — assign trucks to techs, retire empty locations" />
          <CardBody className="space-y-3">
            <ul className="divide-y divide-slate-100">
              {visible.map((loc) => (
                <li key={loc.id} className="flex flex-wrap items-center gap-2 py-2">
                  <span className="text-sm font-medium text-slate-800">{loc.kind === "WAREHOUSE" ? "🏭" : "🚚"} {loc.name}</span>
                  {loc.kind === "TRUCK" ? (
                    <Badge tone={loc.user ? "blue" : "amber"}>{loc.user ? loc.user.name : "unassigned"}</Badge>
                  ) : null}
                  <details className="ml-auto">
                    <summary className="cursor-pointer rounded px-1.5 py-0.5 text-xs font-medium text-blue-600 hover:bg-blue-50">✏️ Edit</summary>
                    <form action={updateLocation} className="mt-1.5 flex flex-wrap items-end gap-1.5">
                      <input type="hidden" name="locationId" value={loc.id} />
                      <Input name="name" required defaultValue={loc.name} aria-label="Name" className="h-8 w-40 text-xs" />
                      {loc.kind === "TRUCK" ? (
                        <Select name="userId" defaultValue={loc.userId ?? ""} aria-label="Assigned tech" className="h-8 w-36 text-xs">
                          <option value="">Unassigned</option>
                          {techUsers.filter((u) => u.role === "TECH").map((u) => (
                            <option key={u.id} value={u.id}>{u.name}</option>
                          ))}
                        </Select>
                      ) : null}
                      <Button type="submit" size="sm" variant="secondary">Save</Button>
                    </form>
                  </details>
                  <form action={retireLocation}>
                    <input type="hidden" name="locationId" value={loc.id} />
                    <button type="submit" title="Retire — blocked while stock remains on hand" className="rounded px-1.5 py-0.5 text-xs font-medium text-red-600 hover:bg-red-50">🗑 Retire</button>
                  </form>
                </li>
              ))}
            </ul>
            <form action={createLocation} className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3">
              <div className="w-44"><Field label="New location — name"><Input name="name" required placeholder="Truck 3 / East warehouse" /></Field></div>
              <div className="w-32">
                <Field label="Kind">
                  <Select name="kind" defaultValue="TRUCK">
                    <option value="TRUCK">🚚 Truck</option>
                    <option value="WAREHOUSE">🏭 Warehouse</option>
                  </Select>
                </Field>
              </div>
              <div className="w-36">
                <Field label="Assign tech (trucks)">
                  <Select name="userId" defaultValue="">
                    <option value="">—</option>
                    {techUsers.filter((u) => u.role === "TECH").map((u) => (
                      <option key={u.id} value={u.id}>{u.name}</option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Button type="submit" size="sm">＋ Add location</Button>
            </form>
          </CardBody>
        </Card>
      ) : null}

      {/* Replenishment */}
      <Card>
        <CardHeader
          title={`⚠️ Replenishment ${lowCount ? `(${lowCount} low)` : ""}`}
          subtitle="Items at or below minimum across visible locations — suggested order tops up to max"
          action={
            manage && lowCount > 0 ? (
              <form action={createPoFromReplenishment}>
                <Button type="submit" size="sm">
                  Create PO from replenishment
                </Button>
              </form>
            ) : undefined
          }
        />
        <CardBody>
          {lowCount === 0 ? (
            <EmptyState title="Everything is stocked above minimums" hint="Nice — nothing to reorder." />
          ) : (
            <div className="space-y-4">
              {lowByLocation.map(({ loc, rows }) => (
                <div key={loc.id}>
                  <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {loc.kind === "WAREHOUSE" ? "🏭" : "🚚"} {loc.name}
                  </h4>
                  <Table>
                    <THead cols={["Item", "On hand", "Min", "Max", "Suggested order"]} />
                    <tbody>
                      {rows.map((s) => (
                        <TRow key={s.id}>
                          <TCell className="font-medium text-slate-900">
                            {s.priceBookItem.name}{" "}
                            <span className="font-mono text-xs text-slate-400">{s.priceBookItem.code}</span>
                          </TCell>
                          <TCell className={clsx("tabular-nums", s.qtyOnHand === 0 ? "font-semibold text-red-600" : "text-amber-600")}>
                            {s.qtyOnHand}
                          </TCell>
                          <TCell className="tabular-nums">{s.minQty}</TCell>
                          <TCell className="tabular-nums">{s.maxQty}</TCell>
                          <TCell className="tabular-nums font-semibold text-slate-900">+{s.maxQty - s.qtyOnHand}</TCell>
                        </TRow>
                      ))}
                    </tbody>
                  </Table>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Part requests */}
      <Card>
        <CardHeader
          title="🙋 Part requests"
          subtitle={isTech ? "Your open requests" : "Open requests from the field"}
        />
        <CardBody>
          {requests.length === 0 ? (
            <EmptyState title="No open part requests" />
          ) : (
            <Table>
              <THead cols={["Requested by", "Item / description", "Qty", "Job", "Status", "Actions"]} />
              <tbody>
                {requests.map((r) => (
                  <TRow key={r.id}>
                    <TCell>{r.requestedBy.name}</TCell>
                    <TCell className="max-w-xs">
                      <span className="font-medium text-slate-900">{r.priceBookItem?.name ?? r.description}</span>
                      {r.priceBookItem ? <div className="text-xs text-slate-500">{r.description}</div> : null}
                    </TCell>
                    <TCell className="tabular-nums">{r.qty}</TCell>
                    <TCell>
                      {r.job ? (
                        <Link href={`/jobs/${r.job.id}`} className="text-blue-600 hover:underline">
                          {r.job.number}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </TCell>
                    <TCell>
                      <Badge tone={REQ_TONE[r.status]}>{r.status}</Badge>
                    </TCell>
                    <TCell>
                      <div className="flex flex-wrap gap-1.5">
                        {manage && r.status === "OPEN" ? (
                          <form action={advancePartRequest}>
                            <input type="hidden" name="id" value={r.id} />
                            <input type="hidden" name="action" value="ORDERED" />
                            <Button type="submit" size="sm" variant="secondary">
                              Mark ordered
                            </Button>
                          </form>
                        ) : null}
                        {manage && r.status === "ORDERED" ? (
                          <form action={advancePartRequest}>
                            <input type="hidden" name="id" value={r.id} />
                            <input type="hidden" name="action" value="FULFILLED" />
                            <Button type="submit" size="sm" variant="success">
                              Mark fulfilled
                            </Button>
                          </form>
                        ) : null}
                        {(r.requestedById === session.userId || manage) && (r.status === "OPEN" || r.status === "ORDERED") ? (
                          <form action={advancePartRequest}>
                            <input type="hidden" name="id" value={r.id} />
                            <input type="hidden" name="action" value="CANCELLED" />
                            <Button type="submit" size="sm" variant="ghost">
                              Cancel
                            </Button>
                          </form>
                        ) : null}
                        {(r.requestedById === session.userId || manage) && r.status === "OPEN" ? (
                          <details>
                            <summary className="cursor-pointer rounded px-1.5 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50">✏️ Edit</summary>
                            <form action={updatePartRequest} className="mt-1.5 flex items-end gap-1.5">
                              <input type="hidden" name="requestId" value={r.id} />
                              <Input name="description" required defaultValue={r.description} aria-label="Description" className="h-8 w-44 text-xs" />
                              <Input name="qty" type="number" step="any" min="0.5" defaultValue={r.qty} aria-label="Qty" className="h-8 w-14 text-xs" />
                              <Button type="submit" size="sm" variant="secondary">Save</Button>
                            </form>
                          </details>
                        ) : null}
                      </div>
                    </TCell>
                  </TRow>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>

      {/* Purchase orders (office/admin/sales) */}
      {!isTech ? (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">📦 Purchase orders</h2>
          {/* M5: manual PO creation */}
          {manage ? (
            <form action={createPurchaseOrder} className="flex flex-wrap items-end gap-2 rounded-xl border border-dashed border-slate-300 bg-white p-3">
              <div className="w-56"><Field label="New PO — supplier"><Input name="supplier" required placeholder="Ferguson / Winsupply…" /></Field></div>
              <div className="w-40"><Field label="Expected"><Input name="expectedAt" type="date" /></Field></div>
              <Button type="submit" size="sm">＋ Create PO</Button>
            </form>
          ) : null}
          {pos.length === 0 ? (
            <EmptyState title="No purchase orders yet" hint="Create one from the replenishment list above." />
          ) : (
            pos.map((po) => {
              const receivable = po.status !== "RECEIVED" && po.status !== "BILLED";
              const total = po.lines.reduce((sum, l) => sum + Math.round(l.qty * l.unitCostCents), 0);
              return (
                <div key={po.id} id={`po-${po.id}`}>
                <Card>
                  <CardHeader
                    title={
                      <span className="flex items-center gap-2">
                        {po.number} <Badge tone={PO_TONE[po.status] ?? "slate"}>{po.status}</Badge>
                      </span>
                    }
                    subtitle={`${po.supplier} · ${po.lines.length} line${po.lines.length === 1 ? "" : "s"} · ${money(total)}${
                      po.expectedAt ? ` · expected ${fmtDate(po.expectedAt)}` : ""
                    }`}
                    action={
                      manage ? (
                        <div className="flex flex-wrap items-center gap-1.5">
                          {receivable && po.status !== "CANCELLED" ? (
                            <form action={receivePurchaseOrder}>
                              <input type="hidden" name="poId" value={po.id} />
                              <Button type="submit" size="sm" variant="success">
                                Receive all
                              </Button>
                            </form>
                          ) : null}
                          {po.status === "RECEIVED" ? (
                            <form action={markPoBilled}>
                              <input type="hidden" name="poId" value={po.id} />
                              <Button type="submit" size="sm" variant="secondary" title="Supplier invoice received — closes the loop">
                                💳 Mark billed
                              </Button>
                            </form>
                          ) : null}
                          {(po.status === "DRAFT" || po.status === "SENT") && po.lines.every((l) => l.receivedQty === 0) ? (
                            <form action={cancelPurchaseOrder}>
                              <input type="hidden" name="poId" value={po.id} />
                              <Button type="submit" size="sm" variant="ghost">
                                Cancel PO
                              </Button>
                            </form>
                          ) : null}
                        </div>
                      ) : undefined
                    }
                  />
                  <CardBody className="p-0">
                    <Table>
                      <THead cols={["Item", "Qty", "Received", "Unit cost", "Line total", ""]} />
                      <tbody>
                        {po.lines.map((l) => (
                          <TRow key={l.id}>
                            <TCell className="font-medium text-slate-900">
                              {l.priceBookItem.name}{" "}
                              <span className="font-mono text-xs text-slate-400">{l.priceBookItem.code}</span>
                            </TCell>
                            <TCell className="tabular-nums">{l.qty}</TCell>
                            <TCell className={clsx("tabular-nums", l.receivedQty >= l.qty ? "text-emerald-600" : "text-slate-500")}>
                              {l.receivedQty}
                            </TCell>
                            <TCell className="tabular-nums">{money(l.unitCostCents)}</TCell>
                            <TCell className="tabular-nums">{money(Math.round(l.qty * l.unitCostCents))}</TCell>
                            <TCell>
                              <div className="flex flex-wrap items-start gap-1.5">
                                {/* M5: partial receive — per line, per delivery */}
                                {manage && po.status !== "CANCELLED" && po.status !== "BILLED" && l.receivedQty < l.qty ? (
                                  <form action={receivePoLine} className="flex items-center gap-1">
                                    <input type="hidden" name="lineId" value={l.id} />
                                    <Input name="qty" type="number" step="any" min="0.5" max={l.qty - l.receivedQty} defaultValue={l.qty - l.receivedQty} aria-label="Receive qty" className="h-8 w-16 text-xs" />
                                    <Button type="submit" size="sm" variant="secondary">Receive</Button>
                                  </form>
                                ) : null}
                                {manage && (po.status === "DRAFT" || po.status === "SENT") ? (
                                  <>
                                    <details>
                                      <summary className="cursor-pointer rounded px-1 py-0.5 text-[11px] font-medium text-blue-600 hover:bg-blue-50">✏️</summary>
                                      <form action={updatePoLine} className="mt-1 flex items-end gap-1">
                                        <input type="hidden" name="lineId" value={l.id} />
                                        <Input name="qty" type="number" step="any" defaultValue={l.qty} aria-label="Qty" className="h-8 w-14 text-xs" />
                                        <Input name="unitCost" inputMode="decimal" defaultValue={(l.unitCostCents / 100).toFixed(2)} aria-label="Unit cost" className="h-8 w-16 text-xs" />
                                        <Button type="submit" size="sm" variant="secondary">Save</Button>
                                      </form>
                                    </details>
                                    {l.receivedQty === 0 ? (
                                      <form action={removePoLine}>
                                        <input type="hidden" name="lineId" value={l.id} />
                                        <button type="submit" className="rounded px-1 py-0.5 text-[11px] font-medium text-red-600 hover:bg-red-50">✕</button>
                                      </form>
                                    ) : null}
                                  </>
                                ) : null}
                              </div>
                            </TCell>
                          </TRow>
                        ))}
                      </tbody>
                    </Table>
                    {/* M5: header edit + add line while the PO is open */}
                    {manage && (po.status === "DRAFT" || po.status === "SENT") ? (
                      <div className="space-y-2 border-t border-slate-100 p-3">
                        <form action={updatePurchaseOrder} className="flex flex-wrap items-end gap-2">
                          <input type="hidden" name="poId" value={po.id} />
                          <div className="w-48"><Field label="Supplier"><Input name="supplier" required defaultValue={po.supplier} /></Field></div>
                          <div className="w-36"><Field label="Expected"><Input name="expectedAt" type="date" defaultValue={po.expectedAt ? po.expectedAt.toISOString().slice(0, 10) : ""} /></Field></div>
                          <Button type="submit" size="sm" variant="secondary">Save header</Button>
                        </form>
                        <form action={addPoLine} className="flex flex-wrap items-end gap-2">
                          <input type="hidden" name="poId" value={po.id} />
                          <div className="min-w-[200px] flex-1">
                            <Field label="Add line">
                              <Select name="priceBookItemId" required defaultValue="">
                                <option value="" disabled>Choose item…</option>
                                {priceBook.map((i) => (
                                  <option key={i.id} value={i.id}>{i.category} · {i.name}</option>
                                ))}
                              </Select>
                            </Field>
                          </div>
                          <div className="w-16"><Field label="Qty"><Input name="qty" type="number" step="any" min="0.5" defaultValue="1" /></Field></div>
                          <div className="w-24"><Field label="$/unit (opt)"><Input name="unitCost" inputMode="decimal" placeholder="book cost" /></Field></div>
                          <Button type="submit" size="sm" variant="secondary">＋ Add</Button>
                        </form>
                      </div>
                    ) : null}
                  </CardBody>
                </Card>
                </div>
              );
            })
          )}
        </section>
      ) : null}
    </div>
  );
}
