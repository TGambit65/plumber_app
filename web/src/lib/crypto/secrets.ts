import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";

/**
 * Application-level secret cipher (AES-256-GCM) for secrets stored AT REST:
 * connector credentials (API keys, OAuth tokens, shared secrets) and per-org
 * SSO client secrets. Authenticated encryption — tampering fails to decrypt
 * rather than returning garbage.
 *
 * Key resolution (in order):
 *   1. APP_ENCRYPTION_KEY — 32 bytes as hex (64 chars) or base64. PRODUCTION.
 *   2. Dev fallback: SHA-256 of `tradeops-enc:${SESSION_SECRET}` so local dev
 *      and tests work with no extra setup. NOT for production — set a real key.
 *
 * Wire format (all base64): `enc:v1:<iv>:<authTag>:<ciphertext>`. The `enc:v1:`
 * prefix lets us detect encrypted vs legacy-plaintext values, so migration is
 * lazy: old plaintext rows keep working and get encrypted on next write.
 *
 * PURE module (no server-only / db) → directly unit-testable.
 */

const PREFIX = "enc:v1:";
const ALGO = "aes-256-gcm";

let cachedKey: Buffer | null = null;

function resolveKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.APP_ENCRYPTION_KEY?.trim();
  if (raw) {
    const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    if (buf.length !== 32) {
      throw new Error("APP_ENCRYPTION_KEY must be exactly 32 bytes (64 hex chars or base64)");
    }
    cachedKey = buf;
    return buf;
  }
  // Dev/test fallback — deterministic, derived from the session secret.
  const secret = process.env.SESSION_SECRET ?? "dev-secret";
  cachedKey = createHash("sha256").update(`tradeops-enc:${secret}`).digest();
  return cachedKey;
}

/** For tests: clear the memoized key after mutating env. */
export function __resetKeyCache() {
  cachedKey = null;
}

/** True when a value is one of our ciphertexts (vs legacy plaintext). */
export function isEncrypted(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PREFIX);
}

/** Encrypt a UTF-8 string → `enc:v1:iv:tag:ct`. Idempotent-safe callers should check isEncrypted first. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12); // 96-bit nonce, GCM standard
  const cipher = createCipheriv(ALGO, resolveKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

/**
 * Decrypt an `enc:v1:` value. Legacy plaintext (no prefix) is returned as-is so
 * pre-encryption rows keep working. Throws only on a corrupted/tampered
 * ciphertext (GCM auth failure) — callers treat that as a hard error.
 */
export function decryptSecret(value: string): string {
  if (!isEncrypted(value)) return value;
  const parts = value.slice(PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("Malformed encrypted secret");
  const [ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv(ALGO, resolveKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}
