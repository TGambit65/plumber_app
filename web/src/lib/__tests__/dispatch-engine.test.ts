import { describe, expect, it } from "vitest";
import { certMatch, emergencyInsertion, optimizeDay, scoreTechsForJob, type EngineJob, type TechDay } from "../dispatch/engine";

const at = (h: number, m = 0) => new Date(2026, 6, 20, h, m);
const P = {
  west: { lat: 47.62, lng: -117.51 },
  mid: { lat: 47.66, lng: -117.42 },
  east: { lat: 47.71, lng: -117.32 },
  farEast: { lat: 47.72, lng: -117.29 },
};
// Simple synthetic drive: 10 min per 0.1 lng degree + 5 base.
const drive = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) =>
  Math.round(Math.abs(a.lng - b.lng) * 100 + Math.abs(a.lat - b.lat) * 100 + 5);

const job = (id: string, h: number, point: EngineJob["point"], endH?: number): EngineJob => ({
  id,
  number: id,
  scheduledAt: at(h),
  scheduledEnd: endH ? at(endH) : null,
  point,
});

describe("certMatch", () => {
  it("matches on shared significant words, transparently", () => {
    expect(certMatch("Backflow Testing", ["Journeyman Plumber", "Backflow Tester Cert"])).toBe("Backflow Tester Cert");
    expect(certMatch("Drain Clearing", ["Journeyman Plumber"])).toBeNull();
    expect(certMatch("Water Heater Replacement", ["Water Heater Specialist"])).toBe("Water Heater Specialist");
  });
});

describe("scoreTechsForJob", () => {
  const candidate = { jobType: "Backflow Testing", priority: "NORMAL", point: P.mid };

  it("prefers the nearer, lighter, certified tech — with transparent reasons", () => {
    const techs: TechDay[] = [
      { techId: "near", techName: "Near Nick", certNames: ["Backflow Tester"], jobs: [job("A", 9, P.mid, 10)] },
      { techId: "far", techName: "Far Fred", certNames: [], jobs: [job("B", 9, P.west, 10), job("C", 11, P.west, 12), job("D", 13, P.west, 14)] },
    ];
    const ranked = scoreTechsForJob(candidate, techs, at(0), drive);
    expect(ranked[0].techId).toBe("near");
    expect(ranked[0].feasible).toBe(true);
    expect(ranked[0].parts.matchedCert).toBe("Backflow Tester");
    expect(ranked[0].reasons.join(" | ")).toMatch(/added drive|no jobs/);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it("marks a fully-booked tech infeasible and scores them last", () => {
    // Jobs back-to-back 8:00–18:00 → no gap fits a 2h candidate.
    const jobs: EngineJob[] = [0, 1, 2, 3, 4].map((i) => job(`J${i}`, 8 + i * 2, P.mid, 10 + i * 2));
    const techs: TechDay[] = [
      { techId: "full", techName: "Full Fiona", certNames: [], jobs },
      { techId: "free", techName: "Free Frank", certNames: [], jobs: [] },
    ];
    const ranked = scoreTechsForJob(candidate, techs, at(0), drive);
    expect(ranked[0].techId).toBe("free");
    const full = ranked.find((r) => r.techId === "full")!;
    expect(full.feasible).toBe(false);
    expect(full.reasons.join()).toContain("no feasible gap");
  });

  it("proposes a concrete slot start after the preceding job + drive", () => {
    const techs: TechDay[] = [
      { techId: "t", techName: "T", certNames: [], jobs: [job("A", 8, P.west, 10), job("B", 16, P.east)] },
    ];
    const [r] = scoreTechsForJob(candidate, techs, at(0), drive);
    expect(r.slot?.afterJobId).toBe("A");
    // A ends 10:00 at west; drive west→mid = |0.09|*100+|0.04|*100+5 = 9+4+5 = 18 → 10:18
    expect(r.slot?.proposedStart.getHours()).toBe(10);
    expect(r.slot?.proposedStart.getMinutes()).toBe(18);
  });
});

describe("emergencyInsertion", () => {
  const emergency = { jobType: "Leak Repair", priority: "EMERGENCY", point: P.mid };

  it("ranks the tech who absorbs with zero pushed jobs first", () => {
    const techs: TechDay[] = [
      // Busy Bob: wall-to-wall afternoon → must push.
      { techId: "busy", techName: "Busy Bob", certNames: [], jobs: [job("A", 13, P.mid, 15), job("B", 15, P.mid, 17)] },
      // Open Olive: free after 13:00.
      { techId: "open", techName: "Open Olive", certNames: [], jobs: [job("C", 9, P.east, 11)] },
    ];
    const ranked = emergencyInsertion(emergency, techs, at(13), drive);
    expect(ranked[0].techId).toBe("open");
    expect(ranked[0].pushedJobs).toBe(0);
    expect(ranked[0].reasons.join(" | ")).toContain("without moving any job");
    const busy = ranked.find((r) => r.techId === "busy")!;
    expect(busy.pushedJobs).toBeGreaterThan(0);
    expect(busy.shiftMinutes).toBeGreaterThan(0);
  });
});

describe("optimizeDay", () => {
  it("reduces total drive on a deliberately bad order and retimes with drive gaps", () => {
    // Current order west → farEast → mid → east zig-zags; optimal path from
    // west is monotonic west→mid→east→farEast.
    const jobs = [job("W", 8, P.west, 9), job("F", 10, P.farEast, 11), job("M", 12, P.mid, 13), job("E", 14, P.east, 15)];
    const plan = optimizeDay(jobs, drive)!;
    expect(plan).not.toBeNull();
    expect(plan.order).toEqual(["W", "M", "E", "F"]);
    expect(plan.totalDriveAfterMin).toBeLessThan(plan.totalDriveBeforeMin);
    expect(plan.minutesSaved).toBe(plan.totalDriveBeforeMin - plan.totalDriveAfterMin);

    // Retiming: first job keeps its start; each next = prev end + drive.
    expect(plan.schedule[0].id).toBe("W");
    expect(plan.schedule[0].start.getTime()).toBe(at(8).getTime());
    const wEnd = at(9).getTime();
    const wm = drive(P.west, P.mid);
    expect(plan.schedule[1].start.getTime()).toBe(wEnd + wm * 60_000);
    // Durations preserved (each 60 min).
    for (const s of plan.schedule) expect(s.end.getTime() - s.start.getTime()).toBe(3600_000);
  });

  it("returns null for <3 jobs or missing coordinates", () => {
    expect(optimizeDay([job("A", 8, P.mid), job("B", 10, P.east)], drive)).toBeNull();
    expect(optimizeDay([job("A", 8, P.mid), job("B", 10, null), job("C", 12, P.east)], drive)).toBeNull();
  });
});
