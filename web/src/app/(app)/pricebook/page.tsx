import Link from "next/link";
import { t, withTenant } from "@/db";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { and, asc, ilike, or, eq, type SQL } from "drizzle-orm";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Table,
  TCell,
  THead,
  TRow,
} from "@/components/ui";
import { money } from "@/lib/format";
import { clsx } from "@/lib/clsx";
import { addPriceBookItem, importPriceBookCsv, togglePriceBookItemActive, updatePriceBookItem } from "@/lib/actions/shared";
import { Textarea } from "@/components/ui";

export const dynamic = "force-dynamic";

function marginPct(priceCents: number, costCents: number): number | null {
  if (priceCents <= 0) return null;
  return ((priceCents - costCents) / priceCents) * 100;
}

function marginClass(pct: number | null): string {
  if (pct == null) return "text-slate-400";
  if (pct < 15) return "font-semibold text-red-600";
  if (pct < 30) return "font-semibold text-amber-600";
  return "text-emerald-600";
}

export default async function PriceBookPage({
  searchParams,
}: {
  searchParams: { q?: string; cat?: string };
}) {
  const session = await requireSession();
  const canEdit = can(session.role, "pricebook.edit");
  const q = (searchParams.q ?? "").trim();
  const cat = (searchParams.cat ?? "").trim();

  const conds: SQL[] = [];
  if (q) {
    const like = `%${q}%`;
    conds.push(or(ilike(t.priceBookItems.code, like), ilike(t.priceBookItems.name, like))!);
  }
  if (cat) conds.push(eq(t.priceBookItems.category, cat));

  // All page queries run in ONE tenant-scoped transaction.
  const [items, allItems] = await withTenant(session.organizationId, async (tx) => {
    const itemRows = await tx
      .select()
      .from(t.priceBookItems)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(t.priceBookItems.category), asc(t.priceBookItems.name));
    const allRows = await tx.select({ category: t.priceBookItems.category }).from(t.priceBookItems);
    return [itemRows, allRows] as const;
  });
  const categories = Array.from(new Set(allItems.map((i) => i.category))).sort();

  return (
    <div className="space-y-5">
      <PageHeader
        title="📗 Price Book"
        subtitle={
          canEdit
            ? "Flat-rate pricing — edits are audited. Margin floor: 30% target, 15% hard floor."
            : "Flat-rate pricing reference (read-only)"
        }
      />

      {!canEdit ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-600">
          You have read-only access. Propose changes to your admin.
        </div>
      ) : null}

      <form method="GET" action="/pricebook" className="flex gap-2">
        {cat ? <input type="hidden" name="cat" value={cat} /> : null}
        <Input name="q" defaultValue={q} placeholder="Search by code or name…" className="max-w-md" />
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>
      <div className="flex flex-wrap gap-2">
        <Link
          href={q ? `/pricebook?q=${encodeURIComponent(q)}` : "/pricebook"}
          className={clsx(
            "rounded-full border px-3 py-1 text-xs font-medium",
            !cat ? "border-blue-600 bg-blue-600 text-white" : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
          )}
        >
          All
        </Link>
        {categories.map((c) => (
          <Link
            key={c}
            href={`/pricebook?cat=${encodeURIComponent(c)}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
            className={clsx(
              "rounded-full border px-3 py-1 text-xs font-medium",
              cat === c ? "border-blue-600 bg-blue-600 text-white" : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
            )}
          >
            {c}
          </Link>
        ))}
      </div>

      <Card>
        <CardHeader
          title={`Items (${items.length})`}
          subtitle="Margin % = (price − cost) ÷ price · amber below 30%, red below 15%"
        />
        <CardBody className="p-0">
          {items.length === 0 ? (
            <div className="p-4">
              <EmptyState title={q || cat ? "No items match your filters" : "Price book is empty"} />
            </div>
          ) : (
            <Table>
              <THead
                cols={
                  canEdit
                    ? ["Code", "Name", "Category", "Cost", "Price", "Margin", "Labor hrs", "Active", "Actions"]
                    : ["Code", "Name", "Category", "Cost", "Price", "Margin", "Labor hrs", "Active"]
                }
              />
              <tbody>
                {items.map((item) => {
                  const pct = marginPct(item.unitPriceCents, item.unitCostCents);
                  const fid = `edit-${item.id}`;
                  return (
                    <TRow key={item.id} className={item.active ? undefined : "opacity-60"}>
                      <TCell className="font-mono text-xs">{item.code}</TCell>
                      <TCell className="max-w-xs">
                        <span className="font-medium text-slate-900">{item.name}</span>
                        {item.description ? (
                          <div className="truncate text-xs text-slate-500">{item.description}</div>
                        ) : null}
                      </TCell>
                      <TCell>{item.category}</TCell>
                      <TCell className="tabular-nums">
                        {canEdit ? (
                          <input
                            type="number"
                            name="cost"
                            form={fid}
                            step="0.01"
                            min={0}
                            defaultValue={(item.unitCostCents / 100).toFixed(2)}
                            className="h-8 w-24 rounded-lg border border-slate-300 px-2 text-right text-sm tabular-nums focus:border-blue-500 focus:outline-none"
                          />
                        ) : (
                          money(item.unitCostCents)
                        )}
                      </TCell>
                      <TCell className="tabular-nums">
                        {canEdit ? (
                          <input
                            type="number"
                            name="price"
                            form={fid}
                            step="0.01"
                            min={0}
                            defaultValue={(item.unitPriceCents / 100).toFixed(2)}
                            className="h-8 w-24 rounded-lg border border-slate-300 px-2 text-right text-sm tabular-nums focus:border-blue-500 focus:outline-none"
                          />
                        ) : (
                          money(item.unitPriceCents)
                        )}
                      </TCell>
                      <TCell className={clsx("tabular-nums", marginClass(pct))}>
                        {pct == null ? "—" : `${pct.toFixed(0)}%`}
                      </TCell>
                      <TCell className="tabular-nums">{item.laborHours ?? "—"}</TCell>
                      <TCell>{item.active ? <Badge tone="green">Active</Badge> : <Badge tone="slate">Inactive</Badge>}</TCell>
                      {canEdit ? (
                        <TCell>
                          <div className="flex items-center gap-1.5">
                            <form id={fid} action={updatePriceBookItem}>
                              <input type="hidden" name="id" value={item.id} />
                              <Button type="submit" size="sm" variant="secondary">
                                Save
                              </Button>
                            </form>
                            <form action={togglePriceBookItemActive}>
                              <input type="hidden" name="id" value={item.id} />
                              <Button type="submit" size="sm" variant="ghost">
                                {item.active ? "Deactivate" : "Activate"}
                              </Button>
                            </form>
                          </div>
                          {/* M6: name/code/category/description/labor finally editable */}
                          <details className="mt-1">
                            <summary className="cursor-pointer rounded px-1 py-0.5 text-[11px] font-medium text-blue-600 hover:bg-blue-50">✏️ Edit details</summary>
                            <form action={updatePriceBookItem} className="mt-1.5 grid w-64 gap-1.5 rounded-lg border border-slate-200 p-2.5">
                              <input type="hidden" name="id" value={item.id} />
                              <input type="hidden" name="cost" value={(item.unitCostCents / 100).toFixed(2)} />
                              <input type="hidden" name="price" value={(item.unitPriceCents / 100).toFixed(2)} />
                              <Input name="code" required defaultValue={item.code} aria-label="Code" className="h-8 text-xs" />
                              <Input name="name" required defaultValue={item.name} aria-label="Name" className="h-8 text-xs" />
                              <Input name="category" required defaultValue={item.category} list="pb-categories" aria-label="Category" className="h-8 text-xs" />
                              <Input name="description" defaultValue={item.description ?? ""} placeholder="Description" aria-label="Description" className="h-8 text-xs" />
                              <Input name="laborHours" type="number" step="0.25" min={0} defaultValue={item.laborHours ?? ""} placeholder="Labor hrs" aria-label="Labor hours" className="h-8 text-xs" />
                              <Button type="submit" size="sm" variant="secondary">Save details</Button>
                            </form>
                          </details>
                        </TCell>
                      ) : null}
                    </TRow>
                  );
                })}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>

      {canEdit ? (
        <Card>
          <CardHeader title="➕ Add item" subtitle="New price book entry — available immediately on estimates & invoices" />
          <CardBody>
            <form action={addPriceBookItem} className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Code">
                  <Input name="code" required placeholder="WH-40G" />
                </Field>
                <Field label="Name">
                  <Input name="name" required placeholder="40-gal Gas Water Heater — Install" />
                </Field>
                <Field label="Category">
                  <Input name="category" required placeholder="Water Heaters" list="pb-categories" />
                </Field>
              </div>
              <datalist id="pb-categories">
                {categories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
              <div className="grid gap-3 sm:grid-cols-4">
                <Field label="Cost ($)">
                  <Input name="cost" type="number" step="0.01" min={0} defaultValue="0" />
                </Field>
                <Field label="Price ($)">
                  <Input name="price" type="number" step="0.01" min={0} required />
                </Field>
                <Field label="Labor hours">
                  <Input name="laborHours" type="number" step="0.25" min={0} placeholder="—" />
                </Field>
                <Field label="Description (optional)">
                  <Input name="description" placeholder="Included materials, haul-away…" />
                </Field>
              </div>
              <Button type="submit">Add to price book</Button>
            </form>
          </CardBody>
        </Card>
      ) : null}

      {/* M6: CSV round-trip — export the book, edit in a spreadsheet, paste back */}
      {canEdit ? (
        <Card>
          <CardHeader
            title="📄 CSV import / export"
            subtitle="Columns: code,name,category,cost,price,laborHours — upserts by code"
            action={
              <a href="/api/export/pricebook" className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
                ⬇ Download CSV
              </a>
            }
          />
          <CardBody>
            <form action={importPriceBookCsv} className="space-y-2">
              <Field label="Paste CSV rows (header + # comment lines are ignored)">
                <Textarea
                  name="csv"
                  rows={5}
                  required
                  placeholder={"code,name,category,cost,price,laborHours\nWH-50G,50-gal Gas Water Heater — Install,Water Heaters,780,2150,4"}
                  className="font-mono text-xs"
                />
              </Field>
              <Button type="submit" size="sm" variant="secondary">
                ⬆ Import rows
              </Button>
            </form>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
