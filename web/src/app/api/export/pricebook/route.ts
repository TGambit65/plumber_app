import { NextResponse } from "next/server";
import { asc } from "drizzle-orm";
import { t, withTenant } from "@/db";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";

export const dynamic = "force-dynamic";

const esc = (v: string | null | undefined) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** M6: price book CSV export — same columns the import accepts (round-trips). */
export async function GET() {
  const session = await requireSession();
  if (!can(session.role, "pricebook.edit")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const rows = await withTenant(session.organizationId, (tx) =>
    tx.query.priceBookItems.findMany({ orderBy: [asc(t.priceBookItems.category), asc(t.priceBookItems.code)] })
  );
  const lines = [
    "code,name,category,cost,price,laborHours,active",
    ...rows.map((r) =>
      [
        esc(r.code),
        esc(r.name),
        esc(r.category),
        (r.unitCostCents / 100).toFixed(2),
        (r.unitPriceCents / 100).toFixed(2),
        r.laborHours ?? "",
        r.active ? "yes" : "no",
      ].join(",")
    ),
  ];
  return new NextResponse(lines.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="pricebook.csv"',
    },
  });
}
