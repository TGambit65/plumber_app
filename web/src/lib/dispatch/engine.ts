/**
 * AI-assisted dispatch engine (phase D4) — PURE module, fully unit-testable.
 *
 * Philosophy: THE ENGINE PROPOSES, THE DISPATCHER DISPOSES. Every output is a
 * suggestion with a TRANSPARENT score breakdown and human-readable reasons —
 * nothing here mutates anything, and the UI never auto-applies a proposal.
 *
 * Three capabilities:
 *   scoreTechsForJob   — rank techs for an unassigned job (best feasible slot,
 *                        added drive, cert match, load), with reasons.
 *   emergencyInsertion — least-disruption analysis: who can absorb this job
 *                        with the fewest pushed jobs / shifted minutes?
 *   optimizeDay        — reorder + retime one tech's day to minimize driving
 *                        (nearest-neighbor + 2-opt), returned as a DIFF.
 *
 * Drive times come from a caller-supplied sync lookup (prebuilt from the geo
 * service — routed when a maps connector is connected, else labeled
 * estimates). The engine itself never does I/O.
 */

import { estimateDriveMinutes, type LatLng } from "@/lib/geo/distance";

export type DriveFn = (from: LatLng, to: LatLng) => number;

export interface EngineJob {
  id: string;
  number: string;
  scheduledAt: Date;
  scheduledEnd: Date | null;
  point: LatLng | null;
}

export interface TechDay {
  techId: string;
  techName: string;
  /** Active (non-expired) certification names held by this tech. */
  certNames: string[];
  /** The tech's jobs for the day, any order. */
  jobs: EngineJob[];
}

export interface CandidateJob {
  jobType: string;
  priority: string;
  point: LatLng | null;
  durationMin?: number;
}

const DEFAULT_DURATION_MIN = 120;
const DAY_END_HOUR = 18;

const endOf = (j: EngineJob) => j.scheduledEnd ?? new Date(j.scheduledAt.getTime() + DEFAULT_DURATION_MIN * 60_000);
const minutes = (ms: number) => Math.round(ms / 60_000);

/** Transparent cert ↔ job-type match: shared significant word (≥4 chars). */
export function certMatch(jobType: string, certNames: string[]): string | null {
  const tokens = new Set(
    jobType
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length >= 4)
  );
  for (const cert of certNames) {
    for (const w of cert.toLowerCase().split(/[^a-z]+/)) {
      if (w.length >= 4 && tokens.has(w)) return cert;
    }
  }
  return null;
}

// ── Smart assign ─────────────────────────────────────────────────────────────

export interface SlotProposal {
  /** Insert after this job (null = start of day). */
  afterJobId: string | null;
  proposedStart: Date;
  addedDriveMin: number | null; // null when coords are missing
}

export interface TechScore {
  techId: string;
  techName: string;
  score: number;
  feasible: boolean;
  slot: SlotProposal | null;
  parts: {
    addedDriveMin: number | null;
    load: number;
    matchedCert: string | null;
  };
  reasons: string[];
}

/**
 * Rank techs for a candidate job on a given day. For each tech, find the
 * cheapest feasible gap (start-of-day / between jobs / end-of-day) and score:
 *   +100 base · −addedDrive · −6·load · +15 cert match · infeasible → −1000.
 */
export function scoreTechsForJob(
  candidate: CandidateJob,
  techs: TechDay[],
  day: Date,
  driveFor?: DriveFn
): TechScore[] {
  const drive: DriveFn = driveFor ?? estimateDriveMinutes;
  const duration = (candidate.durationMin ?? DEFAULT_DURATION_MIN) * 60_000;
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 8, 0);
  const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate(), DAY_END_HOUR, 0);

  const scores: TechScore[] = techs.map((tech) => {
    const jobs = [...tech.jobs].sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
    const load = jobs.length;
    const matchedCert = certMatch(candidate.jobType, tech.certNames);

    // Enumerate insertion slots and pick the cheapest feasible one.
    let best: SlotProposal | null = null;
    const consider = (slot: SlotProposal) => {
      if (!best) best = slot;
      else if ((slot.addedDriveMin ?? 15) < (best.addedDriveMin ?? 15)) best = slot;
    };

    const hop = (a: LatLng | null, b: LatLng | null): number | null =>
      a && b ? drive(a, b) : null;

    if (jobs.length === 0) {
      consider({ afterJobId: null, proposedStart: dayStart, addedDriveMin: 0 });
    } else {
      // Start-of-day slot (before first job).
      const first = jobs[0];
      {
        const d = hop(candidate.point, first.point);
        const latestStart = first.scheduledAt.getTime() - duration - (d ?? 0) * 60_000;
        if (latestStart >= dayStart.getTime()) {
          consider({ afterJobId: null, proposedStart: dayStart, addedDriveMin: d });
        }
      }
      // Between consecutive jobs.
      for (let i = 0; i < jobs.length - 1; i++) {
        const a = jobs[i];
        const b = jobs[i + 1];
        const dIn = hop(a.point, candidate.point);
        const dOut = hop(candidate.point, b.point);
        const dSkip = hop(a.point, b.point);
        const earliest = endOf(a).getTime() + (dIn ?? 0) * 60_000;
        const latest = b.scheduledAt.getTime() - duration - (dOut ?? 0) * 60_000;
        if (earliest <= latest) {
          const added = dIn !== null && dOut !== null && dSkip !== null ? dIn + dOut - dSkip : null;
          consider({ afterJobId: a.id, proposedStart: new Date(earliest), addedDriveMin: added });
        }
      }
      // End-of-day slot (after last job).
      const last = jobs[jobs.length - 1];
      {
        const d = hop(last.point, candidate.point);
        const start = endOf(last).getTime() + (d ?? 0) * 60_000;
        if (start + duration <= dayEnd.getTime()) {
          consider({ afterJobId: last.id, proposedStart: new Date(start), addedDriveMin: d });
        }
      }
    }

    const feasible = best !== null;
    const slot = best as SlotProposal | null;
    const addedDriveMin = slot?.addedDriveMin ?? null;

    let score = 100;
    if (!feasible) score -= 1000;
    if (addedDriveMin !== null) score -= addedDriveMin;
    score -= load * 6;
    if (matchedCert) score += 15;

    const reasons: string[] = [];
    if (!feasible) reasons.push("no feasible gap today");
    else if (addedDriveMin !== null) reasons.push(`~${addedDriveMin} min added drive`);
    else reasons.push("drive unknown (missing coordinates)");
    reasons.push(load === 0 ? "no jobs yet today" : `${load} job${load > 1 ? "s" : ""} today`);
    if (matchedCert) reasons.push(`holds ${matchedCert}`);

    return {
      techId: tech.techId,
      techName: tech.techName,
      score,
      feasible,
      slot,
      parts: { addedDriveMin, load, matchedCert },
      reasons,
    };
  });

  return scores.sort((a, b) => b.score - a.score);
}

// ── Emergency / least-disruption insertion ───────────────────────────────────

export interface DisruptionOption {
  techId: string;
  techName: string;
  proposedStart: Date;
  addedDriveMin: number | null;
  /** Jobs whose times must shift to absorb the emergency. */
  pushedJobs: number;
  shiftMinutes: number;
  reasons: string[];
}

/**
 * For an emergency that should start ASAP (at `asap`): per tech, find the
 * earliest slot at/after `asap`; if none fits without moving work, compute the
 * "push" plan (later jobs shift right) and its total shifted minutes. Ranked
 * by fewest pushed jobs, then shift minutes, then added drive.
 */
export function emergencyInsertion(
  candidate: CandidateJob,
  techs: TechDay[],
  asap: Date,
  driveFor?: DriveFn
): DisruptionOption[] {
  const drive: DriveFn = driveFor ?? estimateDriveMinutes;
  const duration = (candidate.durationMin ?? DEFAULT_DURATION_MIN) * 60_000;

  const options: DisruptionOption[] = techs.map((tech) => {
    const jobs = [...tech.jobs].sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
    const upcoming = jobs.filter((j) => endOf(j).getTime() > asap.getTime());

    const hop = (a: LatLng | null, b: LatLng | null): number | null => (a && b ? drive(a, b) : null);

    // Where is the tech coming from at `asap`? The job they're in / last done.
    const current = jobs.filter((j) => j.scheduledAt.getTime() <= asap.getTime()).pop() ?? null;
    const dIn = hop(current?.point ?? null, candidate.point);
    const travelMs = (dIn ?? 0) * 60_000;
    const arrive = new Date(Math.max(asap.getTime(), (current ? endOf(current).getTime() : asap.getTime())) + travelMs);
    const emergencyEnd = arrive.getTime() + duration;

    // Which upcoming jobs collide, and how far do they shift?
    let pushedJobs = 0;
    let shiftMinutes = 0;
    let cursor = emergencyEnd;
    for (const j of upcoming.filter((j) => j.scheduledAt.getTime() >= asap.getTime())) {
      const dOut = hop(candidate.point, j.point) ?? 0;
      const neededStart = cursor + dOut * 60_000;
      if (j.scheduledAt.getTime() < neededStart) {
        pushedJobs += 1;
        shiftMinutes += minutes(neededStart - j.scheduledAt.getTime());
        cursor = neededStart + (endOf(j).getTime() - j.scheduledAt.getTime());
      } else {
        break; // this and later jobs are unaffected
      }
    }

    const reasons: string[] = [];
    reasons.push(dIn !== null ? `~${dIn} min to the scene${current ? ` from ${current.number}` : ""}` : "drive unknown (missing coordinates)");
    reasons.push(
      pushedJobs === 0 ? "absorbs it without moving any job" : `pushes ${pushedJobs} job${pushedJobs > 1 ? "s" : ""} by ${shiftMinutes} min total`
    );

    return {
      techId: tech.techId,
      techName: tech.techName,
      proposedStart: arrive,
      addedDriveMin: dIn,
      pushedJobs,
      shiftMinutes,
      reasons,
    };
  });

  return options.sort(
    (a, b) =>
      a.pushedJobs - b.pushedJobs ||
      a.shiftMinutes - b.shiftMinutes ||
      (a.addedDriveMin ?? 15) - (b.addedDriveMin ?? 15) ||
      a.proposedStart.getTime() - b.proposedStart.getTime()
  );
}

// ── Optimize my day ──────────────────────────────────────────────────────────

export interface OptimizedPlan {
  /** Proposed visit order (job ids). */
  order: string[];
  /** Retimed schedule preserving each job's duration. */
  schedule: Array<{ id: string; start: Date; end: Date }>;
  totalDriveBeforeMin: number;
  totalDriveAfterMin: number;
  minutesSaved: number;
  dayEndsBefore: Date;
  dayEndsAfter: Date;
}

function pathDrive(order: EngineJob[], drive: DriveFn): number {
  let total = 0;
  for (let i = 0; i < order.length - 1; i++) {
    const a = order[i].point;
    const b = order[i + 1].point;
    if (a && b) total += drive(a, b);
  }
  return total;
}

/**
 * Reorder + retime one tech's day to minimize total driving. Every job needs
 * coordinates (caller filters). Order: nearest-neighbor from the current
 * first job, improved by 2-opt. Retiming packs jobs from the day's original
 * first start, inserting exact drive gaps, preserving each job's duration.
 * Returns null when there's nothing to optimize (< 3 jobs).
 */
export function optimizeDay(jobs: EngineJob[], driveFor?: DriveFn): OptimizedPlan | null {
  if (jobs.length < 3 || jobs.some((j) => !j.point)) return null;
  const drive: DriveFn = driveFor ?? estimateDriveMinutes;

  const current = [...jobs].sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
  const totalBefore = pathDrive(current, drive);

  // Nearest-neighbor from the current first stop.
  const remaining = [...current];
  const route: EngineJob[] = [remaining.shift()!];
  while (remaining.length > 0) {
    const here = route[route.length - 1].point!;
    let bestIdx = 0;
    let bestD = Infinity;
    remaining.forEach((j, i) => {
      const d = drive(here, j.point!);
      if (d < bestD) {
        bestD = d;
        bestIdx = i;
      }
    });
    route.push(remaining.splice(bestIdx, 1)[0]);
  }

  // 2-opt improvement (open path).
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < route.length - 2; i++) {
      for (let k = i + 1; k < route.length - 1; k++) {
        const candidate = [...route.slice(0, i + 1), ...route.slice(i + 1, k + 1).reverse(), ...route.slice(k + 1)];
        if (pathDrive(candidate, drive) < pathDrive(route, drive) - 0.01) {
          route.splice(0, route.length, ...candidate);
          improved = true;
        }
      }
    }
  }

  const totalAfter = pathDrive(route, drive);

  // Retime: pack from the original first start with exact drive gaps.
  const firstStart = current[0].scheduledAt;
  const schedule: OptimizedPlan["schedule"] = [];
  let cursor = firstStart.getTime();
  for (let i = 0; i < route.length; i++) {
    const j = route[i];
    const dur = endOf(j).getTime() - j.scheduledAt.getTime();
    const start = new Date(cursor);
    const end = new Date(cursor + dur);
    schedule.push({ id: j.id, start, end });
    if (i < route.length - 1) {
      cursor = end.getTime() + drive(j.point!, route[i + 1].point!) * 60_000;
    }
  }

  return {
    order: route.map((j) => j.id),
    schedule,
    totalDriveBeforeMin: Math.round(totalBefore),
    totalDriveAfterMin: Math.round(totalAfter),
    minutesSaved: Math.round(totalBefore - totalAfter),
    dayEndsBefore: endOf(current[current.length - 1]),
    dayEndsAfter: schedule[schedule.length - 1].end,
  };
}
