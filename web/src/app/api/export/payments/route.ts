import { NextResponse, type NextRequest } from "next/server";
import { and, asc, gte, lte } from "drizzle-orm";
import { t, withTenant } from "@/db";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";

export const dynamic = "force-dynamic";

const esc = (v: string | null | undefined) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** M6: dashboard CSV export — payments in the selected range with invoice +
 *  customer context, ready for a bookkeeper. */
export async function GET(req: NextRequest) {
  const session = await requireSession();
  if (!can(session.role, "reports.company")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const fromRaw = req.nextUrl.searchParams.get("from");
  const toRaw = req.nextUrl.searchParams.get("to");
  const from = fromRaw && /^\d{4}-\d{2}-\d{2}$/.test(fromRaw) ? new Date(fromRaw) : new Date(Date.now() - 30 * 86_400_000);
  const to = toRaw && /^\d{4}-\d{2}-\d{2}$/.test(toRaw) ? new Date(`${toRaw}T23:59:59`) : new Date();

  const rows = await withTenant(session.organizationId, (tx) =>
    tx.query.payments.findMany({
      where: and(gte(t.payments.receivedAt, from), lte(t.payments.receivedAt, to)),
      with: { invoice: { with: { customer: true } } },
      orderBy: [asc(t.payments.receivedAt)],
    })
  );

  const lines = [
    "receivedAt,invoice,customer,method,reference,amount",
    ...rows.map((p) =>
      [
        p.receivedAt.toISOString(),
        esc(p.invoice.number),
        esc(p.invoice.customer.name),
        p.method,
        esc(p.reference),
        (p.amountCents / 100).toFixed(2),
      ].join(",")
    ),
  ];
  return new NextResponse(lines.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="payments-${from.toISOString().slice(0, 10)}-to-${to.toISOString().slice(0, 10)}.csv"`,
    },
  });
}
