import { SignJWT, jwtVerify } from "jose";
import { createHash, randomBytes } from "crypto";

/**
 * SSO login-transaction primitives (pure — no server-only/db imports, so they
 * are unit-testable). Each federated login mints one transaction carrying the
 * CSRF `state`, the id_token replay `nonce`, and the PKCE `verifier`; the
 * secrets ride in a SIGNED short-lived httpOnly cookie between the authorize
 * redirect and the callback.
 */

export const SSO_TXN_COOKIE = "sso_txn";
export const TXN_TTL_SECONDS = 10 * 60;

const txnSecret = () => new TextEncoder().encode(process.env.SESSION_SECRET ?? "dev-secret");

export interface SsoTransaction {
  slug: string;
  state: string;
  nonce: string;
  verifier: string; // PKCE code_verifier
}

const b64url = (buf: Buffer) => buf.toString("base64url");

/** RFC 7636 S256: code_challenge = BASE64URL(SHA256(code_verifier)). */
export const pkceChallenge = (verifier: string) => b64url(createHash("sha256").update(verifier).digest());

/** Create the per-login transaction: CSRF state, replay nonce, PKCE pair. */
export function newTransaction(slug: string): SsoTransaction & { challenge: string } {
  const state = b64url(randomBytes(24));
  const nonce = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48)); // 64 chars, within RFC 7636 43..128
  return { slug, state, nonce, verifier, challenge: pkceChallenge(verifier) };
}

/** Sign the transaction into a compact JWT for the httpOnly cookie. */
export async function sealTransaction(txn: SsoTransaction): Promise<string> {
  return new SignJWT({ slug: txn.slug, state: txn.state, nonce: txn.nonce, verifier: txn.verifier })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${TXN_TTL_SECONDS}s`)
    .sign(txnSecret());
}

/** Verify + open the transaction cookie. Null on any tamper/expiry. */
export async function openTransaction(sealed: string): Promise<SsoTransaction | null> {
  try {
    const { payload } = await jwtVerify(sealed, txnSecret());
    const { slug, state, nonce, verifier } = payload as Record<string, unknown>;
    if (
      typeof slug !== "string" ||
      typeof state !== "string" ||
      typeof nonce !== "string" ||
      typeof verifier !== "string"
    ) {
      return null;
    }
    return { slug, state, nonce, verifier };
  } catch {
    return null;
  }
}

export const ssoTxnCookieOptions = {
  httpOnly: true as const,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/auth/sso",
  maxAge: TXN_TTL_SECONDS,
};
