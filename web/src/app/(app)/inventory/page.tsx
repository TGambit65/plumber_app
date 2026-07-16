import Link from "next/link";
import { db, t } from "@/db";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { desc, inArray } from "drizzle-orm";
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

export const dynamic = "force-dynamic";

const PO_TONE: Record<string, BadgeTone> = {
  DRAFT: "slate",
  SENT: "blue",
  PARTIAL: "amber",
  RECEIVED: "green",
  BILLED: "violet",
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

  const allLocations = await db.query.inventoryLocations.findMany({ with: { user: true } });
  const visible = (isTech ? allLocations.filter((l) => l.userId === session.userId) : allLocations).sort(
    (a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "WAREHOUSE" ? -1 : 1)
  );

  if (visible.length === 0) {
    return (
      <div>
        <PageHeader title="🧰 Truck Stock" />
        <EmptyState title="No truck assigned to you yet" hint="Ask the office to set up a stock location for your truck." />
      </div>
    );
  }

  const selected = isTech ? visible[0] : visible.find((l) => l.id === searchParams.loc) ?? visible[0];

  const visibleIds = visible.map((l) => l.id);
  const allStock = (await db.query.stockLevels.findMany({
    where: inArray(t.stockLevels.locationId, visibleIds),
    with: { priceBookItem: true },
  })) as (StockRow & { locationId: string })[];

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

  const requestsRaw = await db.query.partRequests.findMany({
    with: { requestedBy: true, job: true, priceBookItem: true },
    orderBy: [desc(t.partRequests.createdAt)],
  });
  const requests = requestsRaw.filter(
    (r) => (r.status === "OPEN" || r.status === "ORDERED") && (!isTech || r.requestedById === session.userId)
  );

  const pos = isTech
    ? []
    : await db.query.purchaseOrders.findMany({
        with: { lines: { with: { priceBookItem: true } } },
        orderBy: [desc(t.purchaseOrders.createdAt)],
      });

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
                      <AdjustForm stockId={s.id} />
                    </TCell>
                  </TRow>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>

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
                        {r.requestedById === session.userId && r.status === "OPEN" ? (
                          <form action={advancePartRequest}>
                            <input type="hidden" name="id" value={r.id} />
                            <input type="hidden" name="action" value="CANCELLED" />
                            <Button type="submit" size="sm" variant="ghost">
                              Cancel
                            </Button>
                          </form>
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
                      manage && receivable ? (
                        <form action={receivePurchaseOrder}>
                          <input type="hidden" name="poId" value={po.id} />
                          <Button type="submit" size="sm" variant="success">
                            Receive all
                          </Button>
                        </form>
                      ) : undefined
                    }
                  />
                  <CardBody className="p-0">
                    <Table>
                      <THead cols={["Item", "Qty", "Received", "Unit cost", "Line total"]} />
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
                          </TRow>
                        ))}
                      </tbody>
                    </Table>
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
