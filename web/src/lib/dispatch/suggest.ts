import "server-only";
import { and, eq, gt, gte, inArray, isNull, lt, or } from "drizzle-orm";
import { t, withTenant } from "@/db";
import { driveTimeResolver } from "@/lib/geo/service";
import { estimateDriveMinutes, type LatLng } from "@/lib/geo/distance";
import {
  emergencyInsertion,
  scoreTechsForJob,
  type DriveFn,
  type EngineJob,
  type TechDay,
  type TechScore,
} from "./engine";

/**
 * Server glue for the D4 suggestion engine: loads the day's tech context
 * (jobs + coords + active certs), prebuilds a SYNC drive lookup from the geo
 * service (routed when a maps connector is connected), and asks the PURE
 * engine for proposals. Nothing here mutates — accept/dismiss are separate,
 * audited server actions.
 */

const MAX_POINTS_FOR_ROUTED = 14; // n² pair cap before falling back to estimates

export interface Suggestion {
  jobId: string;
  kind: "NORMAL" | "EMERGENCY";
  techId: string;
  techName: string;
  whenIso: string;
  reasons: string[];
  score?: number;
  runnerUp?: string;
}

export async function buildTechDays(organizationId: string, day: Date): Promise<TechDay[]> {
  const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  return withTenant(organizationId, async (tx) => {
    const techs = await tx.query.users.findMany({
      where: and(eq(t.users.role, "TECH"), eq(t.users.active, true)),
    });
    const techIds = techs.map((u) => u.id);
    const [jobs, certs] = await Promise.all([
      tx.query.jobs.findMany({
        where: and(
          gte(t.jobs.scheduledAt, day),
          lt(t.jobs.scheduledAt, dayEnd),
          inArray(t.jobs.status, ["SCHEDULED", "DISPATCHED", "EN_ROUTE", "IN_PROGRESS"]),
          isNull(t.jobs.deletedAt)
        ),
        with: { property: true },
      }),
      techIds.length > 0
        ? tx.query.certifications.findMany({
            where: and(
              eq(t.certifications.holderType, "USER"),
              inArray(t.certifications.userId, techIds),
              or(isNull(t.certifications.expiresAt), gt(t.certifications.expiresAt, new Date()))
            ),
          })
        : Promise.resolve([]),
    ]);

    return techs.map((tech) => ({
      techId: tech.id,
      techName: tech.name,
      certNames: certs.filter((c) => c.userId === tech.id).map((c) => c.name),
      jobs: jobs
        .filter((j) => j.assignedToId === tech.id && j.scheduledAt)
        .map(
          (j): EngineJob => ({
            id: j.id,
            number: j.number,
            scheduledAt: j.scheduledAt as Date,
            scheduledEnd: j.scheduledEnd,
            point: j.property.lat !== null && j.property.lng !== null ? { lat: j.property.lat, lng: j.property.lng } : null,
          })
        ),
    }));
  });
}

/** Prebuild a SYNC drive fn over the given points (routed when available). */
export async function buildDriveFn(organizationId: string, points: LatLng[]): Promise<DriveFn> {
  const unique = new Map<string, LatLng>();
  for (const p of points) unique.set(`${p.lat},${p.lng}`, p);
  const list = Array.from(unique.values());

  const { source, resolve } = await driveTimeResolver(organizationId);
  if (source === "estimate" || list.length > MAX_POINTS_FOR_ROUTED) {
    return estimateDriveMinutes;
  }
  const pairs = new Map<string, number>();
  for (const a of list) {
    for (const b of list) {
      if (a === b) continue;
      pairs.set(`${a.lat},${a.lng}|${b.lat},${b.lng}`, await resolve(a, b));
    }
  }
  return (from, to) => pairs.get(`${from.lat},${from.lng}|${to.lat},${to.lng}`) ?? estimateDriveMinutes(from, to);
}

/**
 * Top suggestion per unassigned job. EMERGENCY jobs get least-disruption
 * framing (start ASAP); everything else gets the ranked smart-assign slot.
 */
export function suggestForJobs(
  unassigned: Array<{
    id: string;
    jobType: string;
    priority: string;
    point: LatLng | null;
  }>,
  techDays: TechDay[],
  day: Date,
  now: Date,
  driveFn: DriveFn
): Map<string, Suggestion> {
  const out = new Map<string, Suggestion>();
  for (const job of unassigned) {
    const candidate = { jobType: job.jobType, priority: job.priority, point: job.point };
    if (job.priority === "EMERGENCY") {
      const ranked = emergencyInsertion(candidate, techDays, now, driveFn);
      const best = ranked[0];
      if (best) {
        out.set(job.id, {
          jobId: job.id,
          kind: "EMERGENCY",
          techId: best.techId,
          techName: best.techName,
          whenIso: best.proposedStart.toISOString(),
          reasons: best.reasons,
          runnerUp: ranked[1] ? `${ranked[1].techName}: ${ranked[1].reasons[1] ?? ""}` : undefined,
        });
      }
    } else {
      const ranked: TechScore[] = scoreTechsForJob(candidate, techDays, day, driveFn);
      const best = ranked.find((r) => r.feasible && r.slot);
      if (best && best.slot) {
        out.set(job.id, {
          jobId: job.id,
          kind: "NORMAL",
          techId: best.techId,
          techName: best.techName,
          whenIso: best.slot.proposedStart.toISOString(),
          reasons: best.reasons,
          score: Math.round(best.score),
          runnerUp: ranked[1] ? `${ranked[1].techName} (${Math.round(ranked[1].score)})` : undefined,
        });
      }
    }
  }
  return out;
}
