import { describe, expect, it } from "vitest";
import { externalJobNumber, externalRef, mapExternalStatus, splitAddress } from "../map";

/** Unit tests for the pure FSM import mapping (dispatch D5). */

describe("mapExternalStatus", () => {
  it("maps cancellation variants", () => {
    expect(mapExternalStatus("cancelled", true)).toBe("CANCELLED");
    expect(mapExternalStatus("Canceled", false)).toBe("CANCELLED");
  });

  it("maps completion variants (Jobber archives, ST 'Completed', generic done/closed)", () => {
    expect(mapExternalStatus("complete", true)).toBe("COMPLETED");
    expect(mapExternalStatus("archived", true)).toBe("COMPLETED");
    expect(mapExternalStatus("Done", false)).toBe("COMPLETED");
    expect(mapExternalStatus("closed", false)).toBe("COMPLETED");
  });

  it("maps active-work variants", () => {
    expect(mapExternalStatus("in_progress", true)).toBe("IN_PROGRESS");
    expect(mapExternalStatus("InProgress", true)).toBe("IN_PROGRESS");
    expect(mapExternalStatus("on_site", true)).toBe("IN_PROGRESS");
    expect(mapExternalStatus("Working", true)).toBe("IN_PROGRESS");
  });

  it("maps en-route and dispatched", () => {
    expect(mapExternalStatus("en_route", true)).toBe("EN_ROUTE");
    expect(mapExternalStatus("Driving", true)).toBe("EN_ROUTE");
    expect(mapExternalStatus("Dispatched", true)).toBe("DISPATCHED");
  });

  it("maps scheduled variants (Jobber 'upcoming', ST 'Scheduled'/'Hold', 'booked')", () => {
    expect(mapExternalStatus("scheduled", true)).toBe("SCHEDULED");
    expect(mapExternalStatus("upcoming", false)).toBe("SCHEDULED");
    expect(mapExternalStatus("Booked", false)).toBe("SCHEDULED");
    expect(mapExternalStatus("Hold", false)).toBe("SCHEDULED");
  });

  it("derives unknown statuses from schedule presence", () => {
    expect(mapExternalStatus("something_weird", true)).toBe("SCHEDULED");
    expect(mapExternalStatus("something_weird", false)).toBe("UNSCHEDULED");
    expect(mapExternalStatus(undefined, true)).toBe("SCHEDULED");
    expect(mapExternalStatus(undefined, false)).toBe("UNSCHEDULED");
  });
});

describe("splitAddress", () => {
  it("prefers structured fields when the provider gives them", () => {
    expect(splitAddress({ address: "18 Birchwood Ln", city: "Spokane", state: "WA", zip: "99201" })).toEqual({
      address: "18 Birchwood Ln",
      city: "Spokane",
      state: "WA",
      zip: "99201",
    });
  });

  it("parses 'street, city, ST 12345' single-line addresses", () => {
    expect(splitAddress({ address: "400 Grandview Ave, Spokane, WA 99201" })).toEqual({
      address: "400 Grandview Ave",
      city: "Spokane",
      state: "WA",
      zip: "99201",
    });
  });

  it("parses zip+4 and lowercases state to uppercase", () => {
    expect(splitAddress({ address: "1 Main St, Liberty Lake, wa 99019-1234" })).toEqual({
      address: "1 Main St",
      city: "Liberty Lake",
      state: "WA",
      zip: "99019-1234",
    });
  });

  it("handles 'street, city' with no state/zip", () => {
    expect(splitAddress({ address: "77 Elm Ct, Spokane Valley" })).toEqual({
      address: "77 Elm Ct",
      city: "Spokane Valley",
      state: "—",
      zip: "—",
    });
  });

  it("keeps bare streets and marks missing parts honestly", () => {
    expect(splitAddress({ address: "18 Birchwood Ln" })).toEqual({ address: "18 Birchwood Ln", city: "—", state: "—", zip: "—" });
    expect(splitAddress({})).toEqual({ address: "—", city: "—", state: "—", zip: "—" });
  });
});

describe("externalJobNumber / externalRef", () => {
  it("uses known provider prefixes", () => {
    expect(externalJobNumber("JOBBER", "5501")).toBe("JB-5501");
    expect(externalJobNumber("SERVICETITAN", "88213")).toBe("ST-88213");
    expect(externalJobNumber("HOUSECALL_PRO", "2210")).toBe("HC-2210");
  });

  it("falls back to a derived prefix and sanitizes ids", () => {
    expect(externalJobNumber("WORKIZ", "wz/91-a")).toBe("WO-wz91a");
  });

  it("builds stable provenance refs", () => {
    expect(externalRef("JOBBER", "5501")).toBe("JOBBER:5501");
  });
});
