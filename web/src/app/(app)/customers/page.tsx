import Link from "next/link";
import { t, withTenant } from "@/db";
import { and, asc, ilike, isNotNull, isNull, or } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { createCustomer } from "@/lib/actions/office";
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
  Select,
  THead,
  TCell,
  TRow,
  Table,
} from "@/components/ui";
import { lineTotal, money } from "@/lib/format";

export const dynamic = "force-dynamic";

const UNPAID = new Set(["SENT", "PARTIAL", "OVERDUE"]);
const OPEN_JOB = new Set(["UNSCHEDULED", "SCHEDULED", "DISPATCHED", "EN_ROUTE", "IN_PROGRESS"]);

export default async function CustomersPage({ searchParams }: { searchParams: { q?: string; archived?: string } }) {
  const session = await requireSession();
  const q = (searchParams.q ?? "").trim();
  const like = `%${q}%`;
  const showArchived = searchParams.archived === "1";

  // M1: archived customers are hidden by default; ?archived=1 shows ONLY them.
  const archivedCond = showArchived ? isNotNull(t.customers.archivedAt) : isNull(t.customers.archivedAt);
  const customers = await withTenant(session.organizationId, (tx) =>
    tx.query.customers.findMany({
      where: q
        ? and(
            archivedCond,
            or(
              ilike(t.customers.name, like),
              ilike(t.customers.company, like),
              ilike(t.customers.phone, like),
              ilike(t.customers.email, like)
            )
          )
        : archivedCond,
      with: {
        properties: { columns: { id: true } },
        jobs: { columns: { id: true, status: true } },
        membership: true,
        invoices: { with: { items: true, payments: true } },
      },
      orderBy: asc(t.customers.name),
    })
  );

  const canEdit = can(session.role, "customers.edit");

  return (
    <div>
      <PageHeader title="Customers" subtitle={`${customers.length} record${customers.length === 1 ? "" : "s"}${q ? ` matching “${q}”` : ""}`} />

      <Card className="mb-4">
        <CardBody>
          <form method="get" action="/customers" className="flex flex-wrap items-end gap-3">
            <div className="w-full md:w-72">
              <Input name="q" defaultValue={q} placeholder="Search name, company, phone, email…" aria-label="Search customers" />
            </div>
            <Button type="submit" variant="secondary">
              Search
            </Button>
            <Link
              href={showArchived ? "/customers" : "/customers?archived=1"}
              className="rounded-full border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              {showArchived ? "← Back to active customers" : "📦 Show archived"}
            </Link>
            {q ? (
              <Link href="/customers" className="text-xs text-blue-600 hover:underline">
                Clear
              </Link>
            ) : null}
          </form>
        </CardBody>
      </Card>

      {customers.length === 0 ? (
        <EmptyState title="No customers found" hint={q ? "Try a different search." : "Add your first customer below."} />
      ) : (
        <Card className="mb-5">
          <Table>
            <THead cols={["Name", "Type", "Phone", "Properties", "Open jobs", "AR balance", "Membership"]} />
            <tbody>
              {customers.map((c) => {
                const openJobs = c.jobs.filter((j) => OPEN_JOB.has(j.status)).length;
                const ar = c.invoices
                  .filter((inv) => UNPAID.has(inv.status))
                  .reduce((sum, inv) => sum + lineTotal(inv.items) - inv.payments.reduce((s, p) => s + p.amountCents, 0), 0);
                return (
                  <TRow key={c.id}>
                    <TCell>
                      <Link href={`/customers/${c.id}`} className="font-medium text-blue-700 hover:underline">
                        {c.name}
                      </Link>
                      {c.company ? <div className="text-xs text-slate-400">{c.company}</div> : null}
                    </TCell>
                    <TCell>
                      <Badge tone={c.type === "COMMERCIAL" ? "violet" : "blue"}>{c.type === "COMMERCIAL" ? "Commercial" : "Residential"}</Badge>
                    </TCell>
                    <TCell>{c.phone ?? "—"}</TCell>
                    <TCell>{c.properties.length}</TCell>
                    <TCell>{openJobs > 0 ? <Badge tone="amber">{openJobs}</Badge> : <span className="text-slate-400">0</span>}</TCell>
                    <TCell>
                      {ar > 0 ? <span className="font-medium text-red-600">{money(ar)}</span> : <span className="text-slate-400">$0</span>}
                    </TCell>
                    <TCell>
                      {c.membership ? <Badge tone="green">★ {c.membership.plan}</Badge> : <span className="text-slate-400">—</span>}
                    </TCell>
                  </TRow>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}

      {canEdit ? (
        <Card>
          <CardHeader title="Add customer" subtitle="Creates the record and opens the customer 360 view." />
          <CardBody>
            <form action={createCustomer} className="grid gap-3 md:grid-cols-5">
              <Field label="Name">
                <Input name="name" required placeholder="Full name" />
              </Field>
              <Field label="Type">
                <Select name="type" defaultValue="RESIDENTIAL">
                  <option value="RESIDENTIAL">Residential</option>
                  <option value="COMMERCIAL">Commercial</option>
                </Select>
              </Field>
              <Field label="Company (optional)">
                <Input name="company" placeholder="Company LLC" />
              </Field>
              <Field label="Email">
                <Input type="email" name="email" placeholder="name@example.com" />
              </Field>
              <Field label="Phone">
                <Input name="phone" placeholder="555-0100" />
              </Field>
              <div className="md:col-span-5">
                <Button type="submit">Add customer</Button>
              </div>
            </form>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
