import { notFound } from "next/navigation";
import { eq, sql } from "drizzle-orm";
import { db, t, withTenant } from "@/db";
import { publicStartCheckout } from "@/lib/actions/public";
import { fmtDate, lineTotal, money } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * C1 — PUBLIC invoice pay page (/pay/[token]).
 *
 * Sessionless like /proposal/[token]: the unguessable token (minted when the
 * invoice was sent) is the capability, resolved via the SECURITY DEFINER
 * lookup, then reads re-enter withTenant(org). "Pay now" starts a hosted
 * Stripe Checkout; the signed webhook records the payment, so this page only
 * ever READS money state — it never mutates it.
 */

export default async function PublicPayPage({
  params,
  searchParams,
}: {
  params: { token: string };
  searchParams: { paid?: string };
}) {
  const token = params.token.trim();
  if (!token || token.length < 16 || token.length > 128) notFound();

  const res = await db.execute(sql`SELECT id, organization_id FROM invoice_by_public_token(${token})`);
  const hit = (res.rows as Array<{ id: string; organization_id: string }>)[0];
  if (!hit) notFound();

  const org = await db.query.organizations.findFirst({ where: eq(t.organizations.id, hit.organization_id) });
  if (!org || !org.active) notFound();

  const { inv, stripeConnected } = await withTenant(hit.organization_id, async (tx) => {
    const inv = await tx.query.invoices.findFirst({
      where: eq(t.invoices.id, hit.id),
      with: { customer: true, items: true, payments: true, job: true },
    });
    const [connRow] = await tx
      .select()
      .from(t.integrationConnections)
      .where(eq(t.integrationConnections.provider, "STRIPE"));
    return { inv, stripeConnected: connRow?.status === "CONNECTED" };
  });
  if (!inv) notFound();

  const brand = org.brandPrimary ?? "#0057FF";
  const total = lineTotal(inv.items);
  const paid = inv.payments.reduce((s, p) => s + p.amountCents, 0);
  const balance = total - paid;
  const settled = inv.status === "PAID" || balance <= 0;
  const voided = inv.status === "VOID";
  const justPaid = searchParams.paid === "1";

  return (
    <main className="min-h-screen bg-slate-100 pb-16">
      <header className="px-4 py-6 text-white" style={{ backgroundColor: brand }}>
        <div className="mx-auto max-w-xl">
          <div className="text-xl font-bold">{org.name}</div>
          <div className="mt-1 text-sm opacity-90">
            {[org.businessPhone, org.businessEmail].filter(Boolean).join(" · ")}
          </div>
          {org.licenseNumber ? <div className="mt-0.5 text-xs opacity-75">License {org.licenseNumber}</div> : null}
        </div>
      </header>

      <div className="mx-auto max-w-xl space-y-6 px-4 pt-6">
        {justPaid && !settled ? (
          <section className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
            ✅ Thanks — your payment is processing. This page will show it as soon as it clears (usually seconds).
          </section>
        ) : null}
        {justPaid && settled ? (
          <section className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
            ✅ Payment received — thank you! A receipt is on its way.
          </section>
        ) : null}

        <section className="rounded-xl bg-white p-5 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Invoice {inv.number}</div>
          <h1 className="mt-1 text-lg font-semibold text-slate-900">{inv.customer.name}</h1>
          <p className="mt-1 text-sm text-slate-600">
            {inv.issuedAt ? `Issued ${fmtDate(inv.issuedAt)}` : ""}
            {inv.dueAt ? ` · due ${fmtDate(inv.dueAt)}` : ""}
            {inv.job ? ` · job ${inv.job.number}` : ""}
          </p>

          <table className="mt-4 w-full text-sm">
            <tbody>
              {inv.items.map((i) => (
                <tr key={i.id} className="border-t border-slate-100">
                  <td className="py-2 pr-2 text-slate-700">
                    {i.description}
                    {i.qty !== 1 ? ` × ${i.qty}` : ""}
                  </td>
                  <td className="py-2 text-right font-medium text-slate-900">
                    {money(Math.round(i.qty * i.unitPriceCents))}
                  </td>
                </tr>
              ))}
              <tr className="border-t border-slate-200">
                <td className="py-2 pr-2 font-medium text-slate-900">Total</td>
                <td className="py-2 text-right font-semibold text-slate-900">{money(total)}</td>
              </tr>
              {paid > 0 ? (
                <tr>
                  <td className="py-1 pr-2 text-slate-600">Paid to date</td>
                  <td className="py-1 text-right text-slate-700">−{money(paid)}</td>
                </tr>
              ) : null}
              <tr>
                <td className="py-2 pr-2 text-base font-semibold text-slate-900">Balance due</td>
                <td className="py-2 text-right text-2xl font-bold" style={{ color: settled ? "#059669" : undefined }}>
                  {money(Math.max(0, balance))}
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        {voided ? (
          <section className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-600">
            This invoice was voided — nothing is due. Questions? Call {org.businessPhone ?? "the office"}.
          </section>
        ) : settled ? (
          <section className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
            <h2 className="text-base font-semibold text-emerald-800">✅ Paid in full — thank you!</h2>
            <p className="mt-1 text-sm text-emerald-700">We appreciate your business.</p>
          </section>
        ) : stripeConnected ? (
          <form action={publicStartCheckout} className="rounded-xl bg-white p-5 shadow-sm">
            <input type="hidden" name="token" value={token} />
            <button
              type="submit"
              className="w-full rounded-lg px-6 py-3 text-base font-semibold text-white"
              style={{ backgroundColor: brand }}
            >
              💳 Pay {money(balance)} now
            </button>
            <p className="mt-2 text-center text-xs text-slate-400">
              Secure checkout — card details never touch our servers.
            </p>
          </form>
        ) : (
          <section className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800">
            Online payment isn&apos;t set up yet — call {org.businessPhone ?? "the office"} to pay by card, or mail a
            check.
          </section>
        )}

        <footer className="pt-2 text-center text-xs text-slate-400">
          {org.name}
          {org.businessAddress ? ` · ${org.businessAddress}` : ""}
          {org.businessPhone ? ` · ${org.businessPhone}` : ""}
        </footer>
      </div>
    </main>
  );
}
