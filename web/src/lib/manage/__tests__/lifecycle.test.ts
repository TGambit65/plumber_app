import { describe, expect, it } from "vitest";
import {
  customerArchiveBlocker,
  jobArchiveBlocker,
  jobCancelBlocker,
  jobRescheduleBlocker,
  jobRevertTarget,
  leadReopenBlocker,
  propertyArchiveBlocker,
  statusAfterReschedule,
  type JobStatus,
} from "../lifecycle";

/** Unit tests for the M1 lifecycle rules (management plan §2). */

describe("jobRevertTarget", () => {
  it("steps back exactly one place along the forward flow", () => {
    expect(jobRevertTarget("DISPATCHED")).toBe("SCHEDULED");
    expect(jobRevertTarget("EN_ROUTE")).toBe("DISPATCHED");
    expect(jobRevertTarget("IN_PROGRESS")).toBe("EN_ROUTE");
  });

  it("never reverts terminal or initial states", () => {
    for (const s of ["UNSCHEDULED", "SCHEDULED", "COMPLETED", "CANCELLED"] as JobStatus[]) {
      expect(jobRevertTarget(s)).toBeNull();
    }
  });
});

describe("jobCancelBlocker", () => {
  it("allows cancel from every open state", () => {
    for (const s of ["UNSCHEDULED", "SCHEDULED", "DISPATCHED", "EN_ROUTE", "IN_PROGRESS"] as JobStatus[]) {
      expect(jobCancelBlocker(s)).toBeNull();
    }
  });
  it("blocks cancel of completed and already-cancelled jobs", () => {
    expect(jobCancelBlocker("COMPLETED")).toMatch(/void the invoice/i);
    expect(jobCancelBlocker("CANCELLED")).toMatch(/already/i);
  });
});

describe("jobRescheduleBlocker", () => {
  it("allows rescheduling unstarted jobs", () => {
    for (const s of ["UNSCHEDULED", "SCHEDULED", "DISPATCHED", "EN_ROUTE"] as JobStatus[]) {
      expect(jobRescheduleBlocker(s)).toBeNull();
    }
  });
  it("blocks in-progress and closed jobs", () => {
    expect(jobRescheduleBlocker("IN_PROGRESS")).toMatch(/in progress/i);
    expect(jobRescheduleBlocker("COMPLETED")).toMatch(/closed/i);
    expect(jobRescheduleBlocker("CANCELLED")).toMatch(/closed/i);
  });
});

describe("jobArchiveBlocker", () => {
  it("only closed jobs archive", () => {
    expect(jobArchiveBlocker("COMPLETED")).toBeNull();
    expect(jobArchiveBlocker("CANCELLED")).toBeNull();
    for (const s of ["UNSCHEDULED", "SCHEDULED", "DISPATCHED", "EN_ROUTE", "IN_PROGRESS"] as JobStatus[]) {
      expect(jobArchiveBlocker(s)).toMatch(/completed or cancelled/i);
    }
  });
});

describe("statusAfterReschedule", () => {
  it("keeps DISPATCHED only while a tech stays assigned", () => {
    expect(statusAfterReschedule("DISPATCHED", true)).toBe("DISPATCHED");
    expect(statusAfterReschedule("DISPATCHED", false)).toBe("SCHEDULED");
  });
  it("promotes UNSCHEDULED to SCHEDULED and leaves EN_ROUTE alone", () => {
    expect(statusAfterReschedule("UNSCHEDULED", false)).toBe("SCHEDULED");
    expect(statusAfterReschedule("SCHEDULED", true)).toBe("SCHEDULED");
    expect(statusAfterReschedule("EN_ROUTE", true)).toBe("EN_ROUTE");
  });
});

describe("customerArchiveBlocker", () => {
  it("passes a clean customer", () => {
    expect(customerArchiveBlocker({ openJobs: 0, openInvoices: 0 })).toBeNull();
  });
  it("names every blocker, with counts and plurals", () => {
    expect(customerArchiveBlocker({ openJobs: 2, openInvoices: 0 })).toMatch(/2 open jobs/);
    expect(customerArchiveBlocker({ openJobs: 0, openInvoices: 1 })).toMatch(/1 unpaid invoice\b/);
    const both = customerArchiveBlocker({ openJobs: 1, openInvoices: 3 });
    expect(both).toMatch(/1 open job\b/);
    expect(both).toMatch(/3 unpaid invoices/);
  });
});

describe("propertyArchiveBlocker", () => {
  it("blocks only while open jobs reference the property", () => {
    expect(propertyArchiveBlocker({ openJobs: 0 })).toBeNull();
    expect(propertyArchiveBlocker({ openJobs: 2 })).toMatch(/2 open jobs/);
  });
});

describe("leadReopenBlocker", () => {
  it("only closed leads reopen", () => {
    expect(leadReopenBlocker("WON")).toBeNull();
    expect(leadReopenBlocker("LOST")).toBeNull();
    expect(leadReopenBlocker("NEW")).toMatch(/WON or LOST/);
    expect(leadReopenBlocker("FOLLOW_UP")).toMatch(/WON or LOST/);
  });
});
