import "server-only";
import { t, withTenant } from "@/db";
import { and, eq } from "drizzle-orm";
import type { Role } from "@/lib/auth";
import { jwtVerify, createRemoteJWKSet, decodeProtectedHeader } from "jose";

export {
  SSO_TXN_COOKIE,
  newTransaction,
  sealTransaction,
  openTransaction,
  ssoTxnCookieOptions,
  type SsoTransaction,
} from "@/lib/sso-txn";

/**
 * Per-org OIDC SSO federation (constraints 2 & 10) — FULLY VERIFIED flow.
 *
 * Standalone-first: local email/password auth is ALWAYS the default and keeps
 * working. When an organization has configured an OIDC provider (ssoProvider =
 * "oidc"), users of THAT org may additionally sign in through their IdP. SSO is
 * strictly per-org — one org's IdP never resolves users in another org.
 *
 * Security properties enforced here (not "left as follow-ups"):
 *   - Endpoints come from the issuer's DISCOVERY DOCUMENT
 *     (/.well-known/openid-configuration), and the document's `issuer` must
 *     match the configured issuer exactly (normalized) — no endpoint guessing.
 *   - The authorize request carries `state`, `nonce`, and a PKCE S256
 *     `code_challenge`. All three secrets ride in a SIGNED, httpOnly,
 *     short-lived transaction cookie, so the callback can verify them.
 *   - The returned id_token's SIGNATURE is verified against the issuer's JWKS
 *     (jose createRemoteJWKSet), together with `iss`, `aud` (== clientId),
 *     `exp`/`nbf`, and the `nonce` claim. Only asymmetric algs are accepted.
 */

export type SsoOrg = typeof t.organizations.$inferSelect;

/** True when the org has a usable OIDC configuration. */
export function isSsoConfigured(org: Pick<SsoOrg, "ssoProvider" | "ssoIssuerUrl" | "ssoClientId">): boolean {
  return Boolean(org.ssoProvider === "oidc" && org.ssoIssuerUrl && org.ssoClientId);
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const normalizeIssuer = (iss: string) => iss.replace(/\/+$/, "");

/** In-memory discovery cache — discovery docs are static per IdP. */
const discoveryCache = new Map<string, { doc: OidcDiscovery; expires: number }>();
const DISCOVERY_TTL_MS = 10 * 60 * 1000;

/**
 * Fetch and validate the issuer's discovery document. Throws on any mismatch —
 * an IdP whose discovery `issuer` differs from what the org configured is
 * either misconfigured or hostile, and we refuse both.
 */
export async function fetchDiscovery(issuerUrl: string): Promise<OidcDiscovery> {
  const issuer = normalizeIssuer(issuerUrl);
  const cached = discoveryCache.get(issuer);
  if (cached && cached.expires > Date.now()) return cached.doc;

  const res = await fetch(`${issuer}/.well-known/openid-configuration`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`discovery_${res.status}`);
  const doc = (await res.json()) as Partial<OidcDiscovery>;
  if (
    !doc.issuer ||
    normalizeIssuer(doc.issuer) !== issuer ||
    !doc.authorization_endpoint ||
    !doc.token_endpoint ||
    !doc.jwks_uri
  ) {
    throw new Error("discovery_invalid");
  }
  const valid: OidcDiscovery = {
    issuer: normalizeIssuer(doc.issuer),
    authorization_endpoint: doc.authorization_endpoint,
    token_endpoint: doc.token_endpoint,
    jwks_uri: doc.jwks_uri,
  };
  discoveryCache.set(issuer, { doc: valid, expires: Date.now() + DISCOVERY_TTL_MS });
  return valid;
}

/** JWKS resolvers are cached per jwks_uri (jose caches keys internally too). */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwksFor(jwksUri: string) {
  let jwks = jwksCache.get(jwksUri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUri), { timeoutDuration: 8000 });
    jwksCache.set(jwksUri, jwks);
  }
  return jwks;
}

// ---------------------------------------------------------------------------
// Authorize URL (discovery-driven, PKCE + nonce)
// ---------------------------------------------------------------------------

/**
 * Build the OIDC authorize URL from the issuer's DISCOVERY DOCUMENT.
 * Throws if discovery fails — the caller falls back to /login?error=sso.
 */
export async function buildAuthorizeUrl(
  org: SsoOrg,
  redirectUri: string,
  txn: { state: string; nonce: string; challenge: string }
): Promise<string> {
  const discovery = await fetchDiscovery(org.ssoIssuerUrl ?? "");
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("client_id", org.ssoClientId ?? "");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", txn.state);
  url.searchParams.set("nonce", txn.nonce);
  url.searchParams.set("code_challenge", txn.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

// ---------------------------------------------------------------------------
// Code exchange + id_token verification
// ---------------------------------------------------------------------------

export type ExchangeResult =
  | { ok: true; email: string }
  | { ok: false; error: string };

/** Only asymmetric signature algs — never accept HS* from a remote IdP. */
const ALLOWED_ALGS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512"];

/**
 * Exchange the authorization `code` (with the PKCE verifier) and FULLY verify
 * the returned id_token: signature against the issuer JWKS, `iss`, `aud`
 * (== clientId), `exp`/`nbf` (via jose), and the `nonce` claim.
 */
export async function exchangeAndVerify(
  org: SsoOrg,
  code: string,
  redirectUri: string,
  codeVerifier: string,
  expectedNonce: string
): Promise<ExchangeResult> {
  if (!isSsoConfigured(org)) return { ok: false, error: "sso_not_configured" };
  try {
    const discovery = await fetchDiscovery(org.ssoIssuerUrl ?? "");

    const res = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: org.ssoClientId ?? "",
        client_secret: org.ssoClientSecret ?? "",
        code_verifier: codeVerifier,
      }),
      // Never hang the login request on a slow/unreachable IdP.
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, error: `token_endpoint_${res.status}` };
    const tokens = (await res.json()) as { id_token?: string };
    if (!tokens.id_token) return { ok: false, error: "no_id_token" };

    // Refuse symmetric algs before touching the JWKS.
    const header = decodeProtectedHeader(tokens.id_token);
    if (!header.alg || !ALLOWED_ALGS.includes(header.alg)) {
      return { ok: false, error: "alg_not_allowed" };
    }

    // Signature + iss + aud + exp/nbf, all enforced by jose against the JWKS.
    const { payload } = await jwtVerify(tokens.id_token, jwksFor(discovery.jwks_uri), {
      issuer: discovery.issuer,
      audience: org.ssoClientId ?? "",
      algorithms: ALLOWED_ALGS,
      clockTolerance: 60,
    });

    if (payload.nonce !== expectedNonce) return { ok: false, error: "nonce_mismatch" };

    const email = typeof payload.email === "string" ? payload.email : null;
    if (!email) return { ok: false, error: "no_email_claim" };
    return { ok: true, email };
  } catch (e) {
    // Verification failures land here too (bad signature, wrong iss/aud/exp).
    return { ok: false, error: e instanceof Error ? `${e.name}:${e.message}`.slice(0, 120) : "exchange_failed" };
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
