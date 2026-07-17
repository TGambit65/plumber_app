import { NextResponse, type NextRequest } from "next/server";
import { db, t } from "@/db";
import { eq } from "drizzle-orm";
import { buildAuthorizeUrl, isSsoConfigured } from "@/lib/sso";
import { randomUUID } from "crypto";

export const dynamic = "force-dynamic";

/**
 * GET /auth/sso/[org]
 *
 * Entry point for federated login. Looks up the org by slug and, if it has an
 * OIDC provider configured, redirects the browser to the IdP's authorize URL.
 * If SSO is not configured for that org we bounce back to the login page (local
 * auth remains the default path).
 *
 * `organizations` is not RLS-scoped, so the slug lookup uses the base client.
 */
export async function GET(req: NextRequest, { params }: { params: { org: string } }) {
  const slug = params.org?.toLowerCase().trim();
  const loginUrl = new URL("/login?error=sso", req.url);
  if (!slug) return NextResponse.redirect(loginUrl);

  const org = await db.query.organizations.findFirst({
    where: eq(t.organizations.slug, slug),
  });
  if (!org || !org.active || !isSsoConfigured(org)) {
    return NextResponse.redirect(loginUrl);
  }

  // Callback is a single fixed route for all orgs; `state` carries the org slug
  // so the callback knows which tenant to resolve against. The random suffix is
  // a CSRF token — a production build should also store it in a cookie and
  // verify it on the callback.
  const redirectUri = new URL("/auth/sso/callback", req.url).toString();
  const state = `${slug}:${randomUUID()}`;
  const authorizeUrl = buildAuthorizeUrl(org, redirectUri, state);

  return NextResponse.redirect(authorizeUrl);
}
