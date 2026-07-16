import Link from "next/link";
import { db, t } from "@/db";
import { and, asc, desc, eq, ilike, or, type SQL } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Input,
  PageHeader,
  Select,
  THead,
  TCell,
  TRow,
  Table,
  jobStatusTone,
  statusLabel,
} from "@/components/ui";
import { priorityTone } from "@/components/office/job-card";
import { fmtDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

const STATUSES = ["UNSCHEDULED", "SCHEDULED", "DISPATCHED", "EN_ROUTE", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const;
type JobStatus = (typeof STATUSES)[number];

export default async function JobsPage({
  searchParams,
}: {
  searchParams: { status?: string; tech?: string; q?: string };
}) {
  await requireSession();

  const q = (searchParams.q ?? "").trim();
  const status = (STATUSES as readonly string[]).includes(searchParams.status ?? "")
    ? (searchParams.status as JobStatus)
    : undefined;
  const techId = (searchParams.tech ?? "").trim();

  const techs = await db.query.users.findMany({
    where: eq(t.users.role, "TECH"),
    orderBy: asc(t.users.name),
  });

  const conds: SQL[] = [];
  if (status) conds.push(eq(t.jobs.status, status));
  if (techId) conds.push(eq(t.jobs.assignedToId, techId));
  if (q) {
    const like = `%${q}%`;
    const cond = or(ilike(t.jobs.number, like), ilike(t.jobs.jobType, like), ilike(t.customers.name, like));
    if (cond) conds.push(cond);
  }

  const rows = await db
    .select({ job: t.jobs, customer: t.customers, property: t.properties, tech: t.users })
    .from(t.jobs)
    .innerJoin(t.customers, eq(t.jobs.customerId, t.customers.id))
    .innerJoin(t.properties, eq(t.jobs.propertyId, t.properties.id))
    .leftJoin(t.users, eq(t.jobs.assignedToId, t.users.id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(t.jobs.createdAt));

  return (
    <div>
      <PageHeader title="Jobs" subtitle={`${rows.length} job${rows.length === 1 ? "" : "s"}${q ? ` matching “${q}”` : ""}`} />

      <Card className="mb-4">
        <CardBody>
          <form method="get" action="/jobs" className="flex flex-wrap items-end gap-3">
            <div className="w-full md:w-64">
              <Input name="q" defaultValue={q} placeholder="Search number, type, customer…" aria-label="Search jobs" />
            </div>
            <div className="w-40">
              <Select name="status" defaultValue={status ?? ""} aria-label="Filter by status">
                <option value="">All statuses</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {statusLabel(s)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="w-44">
              <Select name="tech" defaultValue={techId} aria-label="Filter by tech">
                <option value="">All techs</option>
                {techs.map((tech) => (
                  <option key={tech.id} value={tech.id}>
                    {tech.name}
                  </option>
                ))}
              </Select>
            </div>
            <Button type="submit" variant="secondary">
              Filter
            </Button>
            {q || status || techId ? (
              <Link href="/jobs" className="text-xs text-blue-600 hover:underline">
                Clear filters
              </Link>
            ) : null}
          </form>
        </CardBody>
      </Card>

      {rows.length === 0 ? (
        <EmptyState title="No jobs match" hint="Try clearing filters, or book a job from the dispatch board." />
      ) : (
        <Card>
          <Table>
            <THead cols={["Number", "Type", "Customer", "City", "Tech", "Scheduled", "Status", "Priority"]} />
            <tbody>
              {rows.map(({ job, customer, property, tech }) => (
                <TRow key={job.id}>
                  <TCell>
                    <Link href={`/jobs/${job.id}`} className="font-medium text-blue-700 hover:underline">
                      {job.number}
                    </Link>
                  </TCell>
                  <TCell>{job.jobType}</TCell>
                  <TCell>
                    <Link href={`/customers/${customer.id}`} className="hover:underline">
                      {customer.name}
                    </Link>
                  </TCell>
                  <TCell>{property.city}</TCell>
                  <TCell>{tech ? tech.name : <span className="text-slate-400">Unassigned</span>}</TCell>
                  <TCell>{job.scheduledAt ? fmtDateTime(job.scheduledAt) : <span className="text-slate-400">—</span>}</TCell>
                  <TCell>
                    <Badge tone={jobStatusTone[job.status]}>{statusLabel(job.status)}</Badge>
                  </TCell>
                  <TCell>
                    <Badge tone={priorityTone[job.priority]}>{statusLabel(job.priority)}</Badge>
                  </TCell>
                </TRow>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}
