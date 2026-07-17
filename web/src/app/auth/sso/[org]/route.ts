import { NextResponse, type NextRequest } from "next/server";
import { db, t } from "@/db";
import { eq } from "drizzle-orm";
import {
  buildAuthorizeUrl,
  isSsoConfigured,
  newTransaction,
  sealTransaction,
  ssoTxnCookieOptions,
  SSO_TXN_COOKIE,
} from "@/lib/sso";

export const dynamic = "force-dynamic";

/**
 * GET /auth/sso/[org]
 *
 * Entry point for federated login. Looks up the org by slug and, if it has an
 * OIDC provider configured, redirects the browser to the IdP's authorize
 * endpoint — taken from the issuer's DISCOVERY DOCUMENT, never guessed.
 *
 * Each login gets a fresh transaction (CSRF `state`, replay `nonce`, PKCE
 * verifier/challenge). The secrets ride in a SIGNED httpOnly cookie scoped to
 * /auth/sso so the callback can verify state, prove PKCE possession, and match
 * the id_token nonce. If anything fails we bounce to the login page — local
 * auth remains the default path.
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

  try {
    const redirectUri = new URL("/auth/sso/callback", req.url).toString();
    const txn = newTransaction(slug);
    const authorizeUrl = await buildAuthorizeUrl(org, redirectUri, txn);

    const res = NextResponse.redirect(authorizeUrl);
    res.cookies.set(SSO_TXN_COOKIE, await sealTransaction(txn), ssoTxnCookieOptions);
    return res;
  } catch {
    // Discovery unreachable/invalid → clean fallback to local auth.
    return NextResponse.redirect(loginUrl);
  }
}
