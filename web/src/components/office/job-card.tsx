import Link from "next/link";
import type * as schema from "@/db/schema";
import { Badge, jobStatusTone, statusLabel, type BadgeTone } from "@/components/ui";
import { fmtTime } from "@/lib/format";

type Job = typeof schema.jobs.$inferSelect & {
  customer: typeof schema.customers.$inferSelect;
  property: typeof schema.properties.$inferSelect;
};

export const priorityTone: Record<string, BadgeTone> = {
  LOW: "slate",
  NORMAL: "slate",
  HIGH: "amber",
  EMERGENCY: "red",
};

/** Dispatch board job card (server component). */
export function DispatchJobCard({ job }: { job: Job }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-2.5 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold tabular-nums text-slate-700">
          {job.scheduledAt ? fmtTime(job.scheduledAt) : "—"}
          {job.scheduledEnd ? ` – ${fmtTime(job.scheduledEnd)}` : ""}
        </span>
        {job.priority !== "NORMAL" ? (
          <Badge tone={priorityTone[job.priority]}>{statusLabel(job.priority)}</Badge>
        ) : null}
      </div>
      <Link href={`/jobs/${job.id}`} className="mt-1 block text-sm font-medium text-blue-700 hover:underline">
        {job.number} · {job.jobType}
      </Link>
      <p className="mt-0.5 text-xs text-slate-600">{job.customer.name}</p>
      <p className="text-xs text-slate-400">
        {job.property.address}, {job.property.city}
      </p>
      <div className="mt-1.5">
        <Badge tone={jobStatusTone[job.status]}>{statusLabel(job.status)}</Badge>
      </div>
    </div>
  );
}
