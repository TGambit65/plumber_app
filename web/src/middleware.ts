import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

/**
 * Session gate for PAGE navigations.
 *
 * This file used to live at the project root (`web/middleware.ts`). Next only
 * loads middleware from the app's own directory — `src/` here — so it was never
 * registered and never ran: `.next/server/middleware-manifest.json` listed no
 * middleware at all. Auth held anyway because `(app)/layout.tsx` calls
 * `requireSession()`, which is the real gate; this is defence in depth, and it
 * only works from `src/`.
 *
 * Scope is deliberately PAGES ONLY. `/api/*` is excluded in the matcher below,
 * because several API routes are sessionless BY DESIGN and each already
 * authenticates itself:
 *
 *   /api/webhooks/stripe/[org]   Stripe        — HMAC (Stripe-Signature)
 *   /api/webhooks/jobber/[org]   Jobber        — HMAC
 *   /api/sms/inbound/[org]       Twilio        — X-Twilio-Signature
 *   /api/calendar/[token]        Apple/Google  — unguessable feed token
 *   /api/punchout/return         supplier POST — cross-site, buyerCookie token
 *   /api/photos/[id]             app           — getSession() + RLS row lookup
 *
 * Redirecting those to /login would silently break payments, inbound SMS
 * opt-out handling, and calendar subscriptions.
 */

/** Pages reachable with no session. Prefix match. */
const PUBLIC_PAGES = [
  "/login",
  "/auth", //          SSO authorize + callback
  "/proposal", //      C1 customer e-sign — opened from an email/SMS link
  "/pay", //           C1 customer payment — same
  "/offline", //       PWA fallback shell
];

/** Static files in `public/` that must load before a session exists. */
const PUBLIC_FILES = new Set([
  "/manifest.json",
  "/sw.js",
  "/favicon.ico",
  "/icon-192.png",
  "/icon-512.png",
  "/robots.txt",
]);

function isPublic(pathname: string): boolean {
  if (PUBLIC_FILES.has(pathname)) return true;
  if (pathname.startsWith("/demo-photos/")) return true;
  return PUBLIC_PAGES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();

  const token = req.cookies.get("plumber_session")?.value;
  if (!token) return NextResponse.redirect(new URL("/login", req.url));

  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    // Fail CLOSED. A missing secret previously fell back to "dev-secret", which
    // would accept tokens forged with a publicly known key.
    console.error("SESSION_SECRET is not set — refusing to validate sessions.");
    return NextResponse.redirect(new URL("/login", req.url));
  }

  try {
    await jwtVerify(token, new TextEncoder().encode(secret));
    return NextResponse.next();
  } catch {
    return NextResponse.redirect(new URL("/login", req.url));
  }
}

export const config = {
  // Pages only: skip API routes (they authenticate themselves — see above),
  // Next internals, and the static asset pipeline.
  matcher: ["/((?!api/|_next/|.*\\.(?:png|jpg|jpeg|svg|ico|webp|json|js|css|woff2?)$).*)"],
};
