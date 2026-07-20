import { notFound } from "next/navigation";
import { eq, sql } from "drizzle-orm";
import { db, t, withTenant } from "@/db";
import { publicApproveEstimate, publicDeclineEstimate } from "@/lib/actions/public";
import { logActivityOrg, notifyOrg } from "@/lib/actions/helpers";
import { fmtDate, lineTotal, money, monthly } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * C1 — PUBLIC customer proposal page (/proposal/[token]).
 *
 * No session, no app shell: the customer opens this from the email/SMS link on
 * their phone. The unguessable token IS the capability — resolved globally via
 * the SECURITY DEFINER lookup, then everything re-enters withTenant(org) so
 * RLS scopes every read/write. Opening the page counts a view (SENT → VIEWED,
 * hot-signal notification to the creator at 2+ views), exactly like the
 * internal recordEstimateView demo hook.
 */

const TIER_LABEL: Record<string, string> = {
  GOOD: "Good",
  BETTER: "Better",
  BEST: "Best",
  CUSTOM: "Custom",
};

export default async function PublicProposalPage({ params }: { params: { token: string } }) {
  const token = params.token.trim();
  if (!token || token.length < 16 || token.length > 128) notFound();

  const res = await db.execute(sql`SELECT id, organization_id FROM estimate_by_public_token(${token})`);
  const hit = (res.rows as Array<{ id: string; organization_id: string }>)[0];
  if (!hit) notFound();

  // organizations is the tenant root (not RLS-scoped) → base client, scoped by id.
  const org = await db.query.organizations.findFirst({ where: eq(t.organizations.id, hit.organization_id) });
  if (!org || !org.active) notFound();

  const { est, views } = await withTenant(hit.organization_id, async (tx) => {
    const est = await tx.query.estimates.findFirst({
      where: eq(t.estimates.id, hit.id),
      with: {
        customer: true,
        property: true,
        options: { with: { items: true } },
      },
    });
    if (!est) return { est: null, views: 0 };

    // Inline view tracking — every open counts, status flips SENT → VIEWED.
    const views = est.viewCount + 1;
    await tx
      .update(t.estimates)
      .set({
        viewCount: views,
        lastViewedAt: new Date(),
        status: est.status === "SENT" || est.status === "VIEWED" ? "VIEWED" : est.status,
      })
      .where(eq(t.estimates.id, est.id));
    return { est, views };
  });
  if (!est) notFound();

  await logActivityOrg(hit.organization_id, {
    kind: "ESTIMATE_VIEW",
    body: `${est.customer.name} viewed estimate ${est.number} (view #${views})`,
    customerId: est.customerId,
    leadId: est.leadId ?? undefined,
  });
  if (views >= 2 && (est.status === "SENT" || est.status === "VIEWED")) {
    await notifyOrg(
      hit.organization_id,
      est.createdById,
      `🔥 ${est.customer.name} viewed ${est.number} ${views} times`,
      "Hot signal — call while it's top of mind.",
      `/estimates/${est.id}`
    );
  }

  const brand = org.brandPrimary ?? "#0057FF";
  const expired = est.status === "EXPIRED" || (!!est.expiresAt && est.expiresAt < new Date() && !["APPROVED", "DECLINED"].includes(est.status));
  const open = !expired && (est.status === "SENT" || est.status === "VIEWED");
  const sortedOptions = [...est.options].sort((a, b) => a.sortOrder - b.sortOrder);
  const selectedOption = sortedOptions.find((o) => o.selected);

  return (
    <main className="min-h-screen bg-slate-100 pb-16">
      {/* Branded header */}
      <header className="px-4 py-6 text-white" style={{ backgroundColor: brand }}>
        <div className="mx-auto max-w-3xl">
          <div className="text-xl font-bold">{org.name}</div>
          <div className="mt-1 text-sm opacity-90">
            {[org.businessPhone, org.businessEmail].filter(Boolean).join(" · ")}
          </div>
          {org.licenseNumber ? <div className="mt-0.5 text-xs opacity-75">License {org.licenseNumber}</div> : null}
        </div>
      </header>

      <div className="mx-auto max-w-3xl space-y-6 px-4 pt-6">
        {/* Proposal summary */}
        <section className="rounded-xl bg-white p-5 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Proposal {est.number}</div>
          <h1 className="mt-1 text-lg font-semibold text-slate-900">Prepared for {est.customer.name}</h1>
          {est.property ? (
            <p className="mt-1 text-sm text-slate-600">
              {est.property.address}, {est.property.city}, {est.property.state} {est.property.zip}
            </p>
          ) : null}
          {est.notes ? <p className="mt-3 whitespace-pre-line text-sm text-slate-700">{est.notes}</p> : null}
          {est.expiresAt && open ? (
            <p className="mt-3 text-xs text-slate-500">This proposal is valid through {fmtDate(est.expiresAt)}.</p>
          ) : null}
        </section>

        {/* Terminal states */}
        {est.status === "APPROVED" ? (
          <section className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
            <h2 className="text-base font-semibold text-emerald-800">✅ You&apos;re all set!</h2>
            <p className="mt-1 text-sm text-emerald-700">
              {est.signedName ? `Signed by ${est.signedName}` : "Approved"}
              {est.signedAt ? ` on ${fmtDate(est.signedAt)}` : ""}
              {selectedOption ? ` — “${selectedOption.name}” option.` : "."} We&apos;ll reach out shortly to schedule the
              work. Questions? Call {org.businessPhone ?? "us"} any time.
            </p>
          </section>
        ) : null}
        {est.status === "DECLINED" ? (
          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-base font-semibold text-slate-800">This proposal was declined.</h2>
            <p className="mt-1 text-sm text-slate-600">
              Changed your mind, or want to talk through other options? Call {org.businessPhone ?? "us"} and we&apos;ll
              put together a fresh quote.
            </p>
          </section>
        ) : null}
        {expired ? (
          <section className="rounded-xl border border-amber-200 bg-amber-50 p-5">
            <h2 className="text-base font-semibold text-amber-800">This proposal has expired.</h2>
            <p className="mt-1 text-sm text-amber-700">
              Pricing was guaranteed for 30 days from sending. Call {org.businessPhone ?? "us"} and we&apos;ll refresh it
              for you — usually same-day.
            </p>
          </section>
        ) : null}

        {/* Options — good / better / best cards. On the open path the whole grid
            is one approve form: pick a card (radio), sign, submit. */}
        {open ? (
          <form action={publicApproveEstimate} className="space-y-6">
            <input type="hidden" name="token" value={token} />
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {sortedOptions.map((o) => {
                const total = lineTotal(o.items);
                const base = o.items.filter((i) => !i.optional);
                const addons = o.items.filter((i) => i.optional);
                return (
                  <label
                    key={o.id}
                    className="flex cursor-pointer flex-col rounded-xl border-2 border-slate-200 bg-white p-4 shadow-sm transition has-[:checked]:border-current has-[:checked]:shadow-md"
                    style={{ color: brand }}
                  >
                    <div className="flex items-center justify-between">
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
                        {TIER_LABEL[o.tier] ?? o.tier}
                        {o.tier === "BETTER" ? " · Most popular" : ""}
                      </span>
                      <input type="radio" name="optionId" value={o.id} required className="h-5 w-5" />
                    </div>
                    <div className="mt-2 text-base font-semibold text-slate-900">{o.name}</div>
                    {o.description ? <p className="mt-1 text-sm text-slate-600">{o.description}</p> : null}
                    <ul className="mt-3 flex-1 space-y-1.5 text-sm text-slate-700">
                      {base.map((i) => (
                        <li key={i.id} className="flex gap-2">
                          <span aria-hidden>✓</span>
                          <span>
                            {i.description}
                            {i.qty !== 1 ? ` × ${i.qty}` : ""}
                          </span>
                        </li>
                      ))}
                      {addons.map((i) => (
                        <li key={i.id} className="flex gap-2 text-slate-500">
                          <span aria-hidden>＋</span>
                          <span>
                            Optional: {i.description} ({money(Math.round(i.qty * i.unitPriceCents))})
                          </span>
                        </li>
                      ))}
                    </ul>
                    <div className="mt-4 border-t border-slate-100 pt-3">
                      <div className="text-2xl font-bold text-slate-900">{money(total)}</div>
                      {est.financingOffered && total > 0 ? (
                        <div className="text-xs text-slate-500">or about {monthly(total)}/mo with financing*</div>
                      ) : null}
                    </div>
                  </label>
                );
              })}
            </div>

            {/* E-sign */}
            <section className="rounded-xl bg-white p-5 shadow-sm">
              <h2 className="text-base font-semibold text-slate-900">Approve &amp; sign</h2>
              <p className="mt-1 text-sm text-slate-600">
                Pick an option above, then type your full name below — that&apos;s your electronic signature
                authorizing {org.name} to perform the selected work at the quoted price.
              </p>
              <div className="mt-3 flex flex-col gap-3 sm:flex-row">
                <input
                  type="text"
                  name="signedName"
                  required
                  placeholder="Type your full name"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base"
                />
                <button
                  type="submit"
                  className="rounded-lg px-6 py-2.5 text-base font-semibold text-white"
                  style={{ backgroundColor: brand }}
                >
                  Approve &amp; e-sign
                </button>
              </div>
              {est.financingOffered ? (
                <p className="mt-3 text-xs text-slate-400">
                  *Estimated payment based on 60 months at 9.99% APR on approved credit — ask us about financing.
                </p>
              ) : null}
            </section>
          </form>
        ) : null}

        {/* Options recap for terminal states (read-only). */}
        {!open ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {sortedOptions.map((o) => {
              const total = lineTotal(o.items);
              return (
                <div
                  key={o.id}
                  className={`rounded-xl border-2 bg-white p-4 shadow-sm ${o.selected ? "" : "border-slate-200 opacity-70"}`}
                  style={o.selected ? { borderColor: brand } : undefined}
                >
                  <div className="flex items-center justify-between">
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
                      {TIER_LABEL[o.tier] ?? o.tier}
                    </span>
                    {o.selected ? (
                      <span className="text-xs font-semibold" style={{ color: brand }}>
                        Selected
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-2 text-base font-semibold text-slate-900">{o.name}</div>
                  <div className="mt-2 text-2xl font-bold text-slate-900">{money(total)}</div>
                </div>
              );
            })}
          </div>
        ) : null}

        {/* Decline path */}
        {open ? (
          <details className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <summary className="cursor-pointer px-5 py-3 text-sm font-medium text-slate-600">
              Not ready to move forward?
            </summary>
            <form action={publicDeclineEstimate} className="space-y-3 px-5 pb-5">
              <input type="hidden" name="token" value={token} />
              <p className="text-sm text-slate-600">
                No hard feelings — let us know why, and we&apos;ll stop the reminders.
              </p>
              <textarea
                name="reason"
                rows={2}
                placeholder="Optional — e.g. going another direction, timing, budget…"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
              <button
                type="submit"
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700"
              >
                Decline this proposal
              </button>
            </form>
          </details>
        ) : null}

        <footer className="pt-2 text-center text-xs text-slate-400">
          {org.name}
          {org.businessAddress ? ` · ${org.businessAddress}` : ""}
          {org.businessPhone ? ` · ${org.businessPhone}` : ""}
        </footer>
      </div>
    </main>
  );
}
