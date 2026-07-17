import "server-only";
import { t, withTenant } from "@/db";
import { and, eq } from "drizzle-orm";
import type { Role } from "@/lib/auth";

/**
 * Per-org OIDC SSO federation helpers (constraints 2 & 10).
 *
 * Standalone-first: local email/password auth is ALWAYS the default and keeps
 * working. When an organization has configured an OIDC provider (ssoProvider =
 * "oidc"), users of THAT org may additionally sign in through their IdP. SSO is
 * strictly per-org — one org's IdP never resolves users in another org.
 */

export type SsoOrg = typeof t.organizations.$inferSelect;

/** True when the org has a usable OIDC configuration. */
export function isSsoConfigured(org: Pick<SsoOrg, "ssoProvider" | "ssoIssuerUrl" | "ssoClientId">): boolean {
  return Boolean(org.ssoProvider === "oidc" && org.ssoIssuerUrl && org.ssoClientId);
}

/**
 * Build the OIDC authorize URL the browser is redirected to.
 *
 * We use the conventional `<issuer>/authorize` endpoint. A production
 * implementation should first fetch `<issuer>/.well-known/openid-configuration`
 * and read `authorization_endpoint` from the discovery document rather than
 * assuming the path — left as a documented follow-up so the demo has no live
 * IdP dependency.
 */
export function buildAuthorizeUrl(org: SsoOrg, redirectUri: string, state: string): string {
  const issuer = (org.ssoIssuerUrl ?? "").replace(/\/+$/, "");
  const url = new URL(`${issuer}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("client_id", org.ssoClientId ?? "");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export type ExchangeResult =
  | { ok: true; email: string }
  | { ok: false; error: string };

/** Decode a JWT payload WITHOUT verifying the signature (demo only). */
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const part = jwt.split(".")[1];
    if (!part) return null;
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Exchange an authorization `code` for tokens at the org's IdP and resolve the
 * caller's email.
 *
 * This is a BEST-EFFORT implementation that POSTs to `<issuer>/token` with the
 * standard `authorization_code` grant and reads `email` from the returned
 * id_token. It requires a REAL IdP to succeed; with no live provider it simply
 * returns `{ ok: false }` and the callback falls back to local auth.
 *
 * A production implementation MUST:
 *   - use the discovery document's `token_endpoint`,
 *   - verify the id_token signature against the issuer JWKS,
 *   - validate `iss`, `aud` (== clientId), `exp`, and the `nonce`/`state`.
 */
export async function exchangeCode(org: SsoOrg, code: string, redirectUri: string): Promise<ExchangeResult> {
  if (!isSsoConfigured(org)) return { ok: false, error: "sso_not_configured" };
  const issuer = (org.ssoIssuerUrl ?? "").replace(/\/+$/, "");
  try {
    const res = await fetch(`${issuer}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: org.ssoClientId ?? "",
        client_secret: org.ssoClientSecret ?? "",
      }),
      // Never hang the login request on a slow/unreachable IdP.
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, error: `token_endpoint_${res.status}` };
    const tokens = (await res.json()) as { id_token?: string; access_token?: string };
    const claims = tokens.id_token ? decodeJwtPayload(tokens.id_token) : null;
    const email = claims && typeof claims.email === "string" ? claims.email : null;
    if (!email) return { ok: false, error: "no_email_claim" };
    return { ok: true, email };
  } catch (e) {
    // No live IdP in the demo → surface a clean failure the callback can handle.
    return { ok: false, error: e instanceof Error ? e.name : "exchange_failed" };
  }
}

export type SsoUser = { id: string; name: string; email: string; role: Role; organizationId: string };

/**
 * Resolve an IdP-provided email to an ACTIVE user IN THIS ORG.
 *
 * `auth_user_by_email()` is global (it resolves across every tenant), so it is
 * the wrong tool for federated login: an Apex IdP must never mint a session for
 * a Summit user. Instead we query within `withTenant(org.id)` — RLS scopes the
 * lookup to the org — and additionally assert `organizationId === org.id`.
 */
export async function emailToUser(org: SsoOrg, email: string): Promise<SsoUser | null> {
  const normalized = email.toLowerCase().trim();
  if (!normalized) return null;
  const user = await withTenant(org.id, (tx) =>
    tx.query.users.findFirst({
      where: and(eq(t.users.email, normalized), eq(t.users.active, true)),
      columns: { id: true, name: true, email: true, role: true, organizationId: true, active: true },
    })
  );
  if (!user || !user.active || user.organizationId !== org.id) return null;
  return { id: user.id, name: user.name, email: user.email, role: user.role, organizationId: user.organizationId };
}
