import { describe, it, expect } from "vitest";
import { money, monthly, lineTotal, timeAgo, initials } from "../format";

describe("money", () => {
  it("formats whole dollars without cents", () => {
    expect(money(185000)).toBe("$1,850");
  });
  it("formats fractional cents", () => {
    expect(money(13375)).toBe("$133.75");
  });
  it("handles zero and null", () => {
    expect(money(0)).toBe("$0");
    expect(money(null)).toBe("—");
    expect(money(undefined)).toBe("—");
  });
});

describe("monthly", () => {
  it("computes a sane 60-month payment at ~10% APR", () => {
    // $2,450 → roughly $52/mo
    const val = monthly(245000);
    const num = Number(val.replace(/[^0-9.]/g, ""));
    expect(num).toBeGreaterThan(45);
    expect(num).toBeLessThan(60);
  });
});

describe("lineTotal", () => {
  it("sums qty * unitPrice in cents", () => {
    expect(
      lineTotal([
        { qty: 2, unitPriceCents: 2800 },
        { qty: 1, unitPriceCents: 42500 },
      ])
    ).toBe(48100);
  });
  it("rounds fractional quantities correctly", () => {
    expect(lineTotal([{ qty: 1.5, unitPriceCents: 333 }])).toBe(500);
  });
  it("returns 0 for empty", () => {
    expect(lineTotal([])).toBe(0);
  });
});

describe("timeAgo", () => {
  it("says just now for fresh timestamps", () => {
    expect(timeAgo(new Date())).toBe("just now");
  });
  it("reports minutes and hours", () => {
    expect(timeAgo(new Date(Date.now() - 5 * 60000))).toBe("5m ago");
    expect(timeAgo(new Date(Date.now() - 3 * 3600000))).toBe("3h ago");
  });
});

describe("initials", () => {
  it("takes first letters of first two words", () => {
    expect(initials("Jake Sullivan")).toBe("JS");
    expect(initials("Dana")).toBe("D");
  });
});
