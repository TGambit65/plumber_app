import { NextResponse, type NextRequest } from "next/server";
import { db, t } from "@/db";
import { eq } from "drizzle-orm";
import { createSession } from "@/lib/auth";
import { ROLE_HOME } from "@/lib/permissions";
import { exchangeCode, emailToUser, isSsoConfigured } from "@/lib/sso";

export const dynamic = "force-dynamic";

/**
 * GET /auth/sso/callback?code=…&state=…
 *
 * OIDC redirect target. Flow:
 *   1. Parse the org slug out of `state` (set by /auth/sso/[org]).
 *   2. Exchange the authorization `code` for tokens at the org's IdP
 *      (best-effort — see exchangeCode; requires a real IdP to succeed).
 *   3. Resolve the IdP email to an ACTIVE user IN THAT ORG (never cross-tenant).
 *   4. Mint the same local session cookie local login uses, redirect to home.
 *
 * ANY failure (missing params, no IdP, unknown email, wrong org) falls back to
 * /login?error=sso — local auth is always available.
 */
export async function GET(req: NextRequest) {
  const loginUrl = new URL("/login?error=sso", req.url);
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const slug = state.split(":")[0]?.toLowerCase().trim();
    if (!code || !slug) return NextResponse.redirect(loginUrl);

    const org = await db.query.organizations.findFirst({
      where: eq(t.organizations.slug, slug),
    });
    if (!org || !org.active || !isSsoConfigured(org)) {
      return NextResponse.redirect(loginUrl);
    }

    // Must match the redirect_uri sent in the authorize request.
    const redirectUri = new URL("/auth/sso/callback", req.url).toString();
    const result = await exchangeCode(org, code, redirectUri);
    if (!result.ok) return NextResponse.redirect(loginUrl);

    const user = await emailToUser(org, result.email);
    if (!user) return NextResponse.redirect(loginUrl);

    await createSession({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      organizationId: user.organizationId,
    });
    return NextResponse.redirect(new URL(ROLE_HOME[user.role], req.url));
  } catch {
    return NextResponse.redirect(loginUrl);
  }
}
