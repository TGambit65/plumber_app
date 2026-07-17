import { NextResponse, type NextRequest } from "next/server";
import { db, t } from "@/db";
import { eq } from "drizzle-orm";
import { createSession } from "@/lib/auth";
import { ROLE_HOME } from "@/lib/permissions";
import {
  exchangeAndVerify,
  emailToUser,
  isSsoConfigured,
  openTransaction,
  SSO_TXN_COOKIE,
  ssoTxnCookieOptions,
} from "@/lib/sso";

export const dynamic = "force-dynamic";

/**
 * GET /auth/sso/callback?code=…&state=…
 *
 * OIDC redirect target. Verified flow:
 *   1. Open the SIGNED transaction cookie set by /auth/sso/[org]; reject if
 *      missing/tampered/expired.
 *   2. Verify the `state` query param matches the transaction (CSRF).
 *   3. Exchange the code at the IdP's discovered token_endpoint WITH the PKCE
 *      code_verifier, then verify the id_token: JWKS signature, iss, aud,
 *      exp, and nonce (replay).
 *   4. Resolve the IdP email to an ACTIVE user IN THAT ORG (never cross-tenant).
 *   5. Mint the same local session cookie local login uses, redirect to home.
 *
 * ANY failure falls back to /login?error=sso — local auth is always available.
 * The transaction cookie is single-use: cleared on every outcome.
 */
export async function GET(req: NextRequest) {
  const loginUrl = new URL("/login?error=sso", req.url);
  const fail = () => {
    const res = NextResponse.redirect(loginUrl);
    res.cookies.set(SSO_TXN_COOKIE, "", { ...ssoTxnCookieOptions, maxAge: 0 });
    return res;
  };
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    if (!code || !state) return fail();

    const sealed = req.cookies.get(SSO_TXN_COOKIE)?.value ?? "";
    const txn = sealed ? await openTransaction(sealed) : null;
    if (!txn || txn.state !== state) return fail();

    const org = await db.query.organizations.findFirst({
      where: eq(t.organizations.slug, txn.slug),
    });
    if (!org || !org.active || !isSsoConfigured(org)) return fail();

    // Must match the redirect_uri sent in the authorize request.
    const redirectUri = new URL("/auth/sso/callback", req.url).toString();
    const result = await exchangeAndVerify(org, code, redirectUri, txn.verifier, txn.nonce);
    if (!result.ok) return fail();

    const user = await emailToUser(org, result.email);
    if (!user) return fail();

    await createSession({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      organizationId: user.organizationId,
    });
    const res = NextResponse.redirect(new URL(ROLE_HOME[user.role], req.url));
    res.cookies.set(SSO_TXN_COOKIE, "", { ...ssoTxnCookieOptions, maxAge: 0 });
    return res;
  } catch {
    return fail();
  }
}
