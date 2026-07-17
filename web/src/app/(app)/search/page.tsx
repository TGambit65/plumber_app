import Link from "next/link";
import { db, t, withTenant } from "@/db";
import { requireSession } from "@/lib/auth";
import { desc, ilike, or, sql } from "drizzle-orm";
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, Input, PageHeader } from "@/components/ui";
import { money, fmtDate } from "@/lib/format";
import { snippet } from "@/lib/markdown";
import type { ReactNode } from "react";

export const dynamic = "force-dynamic";

const FETCH_LIMIT = 25;
const SHOW = 5;

type ResultRow = {
  key: string;
  href: string;
  primary: ReactNode;
  secondary?: ReactNode;
  badge?: ReactNode;
};

function Section({ title, icon, rows }: { title: string; icon: string; rows: ResultRow[] }) {
  if (rows.length === 0) return null;
  const shown = rows.slice(0, SHOW);
  const more = rows.length - shown.length;
  return (
    <Card>
      <CardHeader title={`${icon} ${title}`} subtitle={`${rows.length}${rows.length === FETCH_LIMIT ? "+" : ""} match${rows.length === 1 ? "" : "es"}`} />
      <CardBody className="divide-y divide-slate-100 p-0">
        {shown.map((r) => (
          <Link key={r.key} href={r.href} className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-slate-50">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-slate-900">{r.primary}</div>
              {r.secondary ? <div className="truncate text-xs text-slate-500">{r.secondary}</div> : null}
            </div>
            {r.badge}
          </Link>
        ))}
        {more > 0 ? <div className="px-4 py-2 text-xs text-slate-400">+{more} more…</div> : null}
      </CardBody>
    </Card>
  );
}

export default async function SearchPage({ searchParams }: { searchParams: { q?: string } }) {
  const session = await requireSession();
  const q = (searchParams.q ?? "").trim();

  if (!q) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="🔍 Search" subtitle="Customers, properties, jobs, estimates, invoices, parts, SOPs and leads" />
        <form method="GET" action="/search" className="mb-6 flex gap-2">
          <Input name="q" autoFocus placeholder="Try a name, phone fragment, address, job #, part code…" />
          <Button type="submit">Search</Button>
        </form>
        <EmptyState title="Type something to search" hint="Example: “water heater”, “555-2002”, “J-1041”, “PEX”" />
      </div>
    );
  }

  const like = `%${q}%`;

  const [customers, properties, jobs, estimates, invoices, pbItems, kb, leads] = await Promise.all([
    db
      .select()
      .from(t.customers)
      .where(
        or(
          ilike(t.customers.name, like),
          ilike(t.customers.company, like),
          ilike(t.customers.phone, like),
          ilike(t.customers.email, like)
        )
      )
      .limit(FETCH_LIMIT),
    db.query.properties.findMany({
      where: or(ilike(t.properties.address, like), ilike(t.properties.label, like)),
      with: { customer: true },
      limit: FETCH_LIMIT,
    }),
    db.query.jobs.findMany({
      where: or(ilike(t.jobs.number, like), ilike(t.jobs.jobType, like)),
      with: { customer: true },
      orderBy: [desc(t.jobs.createdAt)],
      limit: FETCH_LIMIT,
    }),
    db.query.estimates.findMany({
      where: ilike(t.estimates.number, like),
      with: { customer: true },
      limit: FETCH_LIMIT,
    }),
    db.query.invoices.findMany({
      where: ilike(t.invoices.number, like),
      with: { customer: true },
      limit: FETCH_LIMIT,
    }),
    db
      .select()
      .from(t.priceBookItems)
      .where(or(ilike(t.priceBookItems.code, like), ilike(t.priceBookItems.name, like)))
      .limit(FETCH_LIMIT),
    // kb_articles is RLS-enabled → must run inside the tenant transaction.
    withTenant(session.organizationId, (tx) =>
      tx
        .select()
        .from(t.kbArticles)
        .where(
          or(
            ilike(t.kbArticles.title, like),
            ilike(t.kbArticles.body, like),
            sql`array_to_string(${t.kbArticles.tags}, ' ') ilike ${like}`
          )
        )
        .limit(FETCH_LIMIT)
    ),
    db
      .select()
      .from(t.leads)
      .where(or(ilike(t.leads.title, like), ilike(t.leads.contactName, like)))
      .limit(FETCH_LIMIT),
  ]);

  const total =
    customers.length +
    properties.length +
    jobs.length +
    estimates.length +
    invoices.length +
    pbItems.length +
    kb.length +
    leads.length;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title="🔍 Search" subtitle={`Results for “${q}”`} />
      <form method="GET" action="/search" className="flex gap-2">
        <Input name="q" defaultValue={q} placeholder="Search everything…" />
        <Button type="submit">Search</Button>
      </form>

      {total === 0 ? (
        <EmptyState title={`No results for “${q}”`} hint="Try fewer or different keywords — phone fragments, addresses and part codes all work." />
      ) : (
        <>
          <Section
            title="Customers"
            icon="👥"
            rows={customers.map((c) => ({
              key: c.id,
              href: `/customers/${c.id}`,
              primary: c.name,
              secondary: [c.company, c.phone, c.email].filter(Boolean).join(" · "),
              badge: <Badge tone={c.type === "COMMERCIAL" ? "violet" : "slate"}>{c.type === "COMMERCIAL" ? "Commercial" : "Residential"}</Badge>,
            }))}
          />
          <Section
            title="Properties"
            icon="🏠"
            rows={properties.map((p) => ({
              key: p.id,
              href: `/customers/${p.customerId}`,
              primary: `${p.label ? `${p.label} — ` : ""}${p.address}, ${p.city}`,
              secondary: p.customer.name,
            }))}
          />
          <Section
            title="Jobs"
            icon="🔧"
            rows={jobs.map((j) => ({
              key: j.id,
              href: `/jobs/${j.id}`,
              primary: `${j.number} — ${j.jobType}`,
              secondary: `${j.customer.name}${j.scheduledAt ? ` · ${fmtDate(j.scheduledAt)}` : ""}`,
              badge: <Badge tone="blue">{j.status.replaceAll("_", " ")}</Badge>,
            }))}
          />
          <Section
            title="Estimates"
            icon="📝"
            rows={estimates.map((e) => ({
              key: e.id,
              href: `/estimates/${e.id}`,
              primary: e.number,
              secondary: e.customer.name,
              badge: <Badge tone="amber">{e.status}</Badge>,
            }))}
          />
          <Section
            title="Invoices"
            icon="🧾"
            rows={invoices.map((i) => ({
              key: i.id,
              href: `/invoices?q=${encodeURIComponent(i.number)}`,
              primary: i.number,
              secondary: i.customer.name,
              badge: <Badge tone={i.status === "PAID" ? "green" : i.status === "OVERDUE" ? "red" : "slate"}>{i.status}</Badge>,
            }))}
          />
          <Section
            title="Price book"
            icon="📗"
            rows={pbItems.map((p) => ({
              key: p.id,
              href: `/pricebook?q=${encodeURIComponent(p.code)}`,
              primary: `${p.code} — ${p.name}`,
              secondary: p.category,
              badge: <span className="text-sm font-semibold tabular-nums text-slate-700">{money(p.unitPriceCents)}</span>,
            }))}
          />
          <Section
            title="Knowledge base"
            icon="📖"
            rows={kb.map((a) => ({
              key: a.id,
              href: `/kb/${a.slug}`,
              primary: a.title,
              secondary: snippet(a.body, 100),
              badge: a.verifiedAt ? <Badge tone="green">✓ Verified</Badge> : undefined,
            }))}
          />
          <Section
            title="Leads"
            icon="📥"
            rows={leads.map((l) => ({
              key: l.id,
              href: `/leads/${l.id}`,
              primary: l.title,
              secondary: `${l.contactName}${l.estValueCents ? ` · est. ${money(l.estValueCents)}` : ""}`,
              badge: <Badge tone="cyan">{l.stage.replaceAll("_", " ")}</Badge>,
            }))}
          />
        </>
      )}
    </div>
  );
}
