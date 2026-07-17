/**
 * Minimal mock OIDC IdP for end-to-end SSO verification (dev/test only).
 *
 * Implements: discovery, authorize (auto-approves a configured user), token
 * (authorization_code grant with PKCE S256 enforcement), and JWKS. Signs
 * id_tokens with a fresh RS256 key per process.
 *
 * Fault-injection query flags on /authorize (carried through the code):
 *   ?evil_sig=1    → id_token signed by a DIFFERENT key (bad signature)
 *   ?evil_nonce=1  → id_token carries the wrong nonce
 *   ?evil_aud=1    → id_token carries the wrong audience
 *
 * Env: PORT (default 8899), IDP_EMAIL (default owner@summithvac.demo),
 *      IDP_CLIENT_ID (default trade-ops-demo)
 */
import http from "node:http";
import crypto from "node:crypto";
import { SignJWT, exportJWK } from "jose";

const PORT = Number(process.env.PORT || 8899);
const ISSUER = process.env.IDP_ISSUER || `http://localhost:${PORT}`;
const EMAIL = process.env.IDP_EMAIL || "owner@summithvac.demo";
const CLIENT_ID = process.env.IDP_CLIENT_ID || "trade-ops-demo";

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const evil = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }); // never in JWKS
const KID = "mock-idp-key-1";

/** code → { nonce, challenge, flags } issued by /authorize */
const codes = new Map();

const b64url = (buf) => Buffer.from(buf).toString("base64url");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ISSUER);
  const send = (status, body, type = "application/json") => {
    res.writeHead(status, { "content-type": type });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };

  if (url.pathname === "/.well-known/openid-configuration") {
    return send(200, {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
      response_types_supported: ["code"],
      id_token_signing_alg_values_supported: ["RS256"],
      code_challenge_methods_supported: ["S256"],
    });
  }

  if (url.pathname === "/jwks") {
    const jwk = await exportJWK(publicKey);
    return send(200, { keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] });
  }

  if (url.pathname === "/authorize") {
    const redirectUri = url.searchParams.get("redirect_uri");
    const state = url.searchParams.get("state") ?? "";
    const nonce = url.searchParams.get("nonce") ?? "";
    const challenge = url.searchParams.get("code_challenge") ?? "";
    const method = url.searchParams.get("code_challenge_method") ?? "";
    if (!redirectUri || !state) return send(400, { error: "invalid_request" });
    if (!challenge || method !== "S256") return send(400, { error: "pkce_required" });
    const code = b64url(crypto.randomBytes(24));
    codes.set(code, {
      nonce,
      challenge,
      evil_sig: url.searchParams.get("evil_sig") === "1",
      evil_nonce: url.searchParams.get("evil_nonce") === "1",
      evil_aud: url.searchParams.get("evil_aud") === "1",
    });
    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    target.searchParams.set("state", state);
    res.writeHead(302, { location: target.toString() });
    return res.end();
  }

  if (url.pathname === "/token" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body);
    const grant = codes.get(form.get("code") ?? "");
    if (!grant) return send(400, { error: "invalid_grant" });
    codes.delete(form.get("code"));

    // PKCE: verifier must hash to the challenge from /authorize.
    const verifier = form.get("code_verifier") ?? "";
    const hashed = b64url(crypto.createHash("sha256").update(verifier).digest());
    if (hashed !== grant.challenge) return send(400, { error: "invalid_pkce" });

    const idToken = await new SignJWT({
      email: EMAIL,
      nonce: grant.evil_nonce ? "WRONG-NONCE" : grant.nonce,
    })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuer(ISSUER)
      .setAudience(grant.evil_aud ? "some-other-client" : (form.get("client_id") ?? CLIENT_ID))
      .setSubject("mock-user-1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(grant.evil_sig ? evil.privateKey : privateKey);

    return send(200, { access_token: b64url(crypto.randomBytes(16)), token_type: "Bearer", id_token: idToken });
  }

  send(404, { error: "not_found" });
});

server.listen(PORT, () => console.log(`mock-idp listening on ${ISSUER} (user ${EMAIL}, client ${CLIENT_ID})`));
