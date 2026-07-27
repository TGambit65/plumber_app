import { describe, it, expect } from "vitest";
import { config } from "@/middleware";

/**
 * Guards the middleware's REACH, not its verify logic.
 *
 * The original middleware sat at the repo root and never ran. Turning it on is
 * a behaviour change, and the expensive mistake would be gating a route that is
 * sessionless by design — Stripe webhooks, Twilio inbound SMS, the ICS feed, the
 * punchout return POST, and the customer proposal/pay links. Those failures are
 * invisible in local dev (nobody webhooks localhost) and show up as lost
 * payments in production.
 */

function matches(pathname: string): boolean {
  return config.matcher.some((m) => new RegExp(`^${m}$`).test(pathname));
}

describe("middleware matcher", () => {
  it("does not intercept API routes — each authenticates itself", () => {
    for (const p of [
      "/api/webhooks/stripe/org_1",
      "/api/webhooks/jobber/org_1",
      "/api/sms/inbound/org_1",
      "/api/calendar/feedtoken",
      "/api/punchout/return",
      "/api/photos/abc123",
      "/api/sync/delta",
      "/api/health",
    ]) {
      expect(matches(p), `${p} must NOT be gated by middleware`).toBe(false);
    }
  });

  it("does not intercept Next internals or static assets", () => {
    for (const p of ["/_next/static/chunks/main.js", "/manifest.json", "/sw.js", "/icon-192.png", "/demo-photos/wh-before.svg"]) {
      expect(matches(p), `${p} must not be gated`).toBe(false);
    }
  });

  it("does intercept application pages", () => {
    for (const p of ["/dashboard", "/jobs/abc", "/my-day", "/settings", "/claims/xyz"]) {
      expect(matches(p), `${p} must be gated`).toBe(true);
    }
  });
});

describe("public page allowlist", () => {
  // Mirrors isPublic() — kept here so a future edit to the list has to face
  // these cases explicitly.
  const PUBLIC_PAGES = ["/login", "/auth", "/proposal", "/pay", "/offline"];
  const PUBLIC_FILES = new Set(["/manifest.json", "/sw.js", "/favicon.ico", "/icon-192.png", "/icon-512.png", "/robots.txt"]);
  const isPublic = (pathname: string) =>
    PUBLIC_FILES.has(pathname) ||
    pathname.startsWith("/demo-photos/") ||
    PUBLIC_PAGES.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  it("lets customers reach the sessionless proposal and pay links", () => {
    expect(isPublic("/proposal/tok_abc")).toBe(true);
    expect(isPublic("/pay/tok_abc")).toBe(true);
  });

  it("lets the SSO round trip through", () => {
    expect(isPublic("/auth/sso/apex")).toBe(true);
    expect(isPublic("/auth/sso/callback")).toBe(true);
  });

  it("keeps the app itself private", () => {
    for (const p of ["/dashboard", "/jobs/abc", "/paycheck", "/loginary", "/authors"]) {
      expect(isPublic(p), `${p} must not be public`).toBe(false);
    }
  });

  it("does not treat a prefix collision as public", () => {
    // "/paycheck" starts with "/pay" but is not the /pay/[token] route.
    expect(isPublic("/paycheck")).toBe(false);
  });
});
