import "server-only";
import type { ConnectorConfig, ConnectorDescriptor } from "./types";
import { decryptSecret, encryptSecret, isEncrypted } from "@/lib/crypto/secrets";

/**
 * Encrypt/decrypt the SECRET fields of a connector config at the DB boundary.
 *
 * "Secret" = any descriptor field declared `kind: "password"` (API keys,
 * OAuth tokens, shared secrets). Non-secret fields (URLs, identities, realm
 * IDs) and dynamically-added keys like `lastError` stay plaintext so they
 * remain queryable/inspectable. Encryption happens right before a write and
 * decryption right after a read, so all connector ops keep working in
 * plaintext and never learn about encryption.
 */

function secretKeys(descriptor: ConnectorDescriptor): Set<string> {
  return new Set(descriptor.configFields.filter((f) => f.kind === "password").map((f) => f.key));
}

/** Encrypt secret fields for storage. Already-encrypted values are left as-is. */
export function encryptConfig(descriptor: ConnectorDescriptor, config: ConnectorConfig): ConnectorConfig {
  const secrets = secretKeys(descriptor);
  const out: ConnectorConfig = { ...config };
  for (const key of Array.from(secrets)) {
    const v = out[key];
    if (typeof v === "string" && v.length > 0 && !isEncrypted(v)) out[key] = encryptSecret(v);
  }
  return out;
}

/** Decrypt secret fields for in-app use. Legacy plaintext passes through. */
export function decryptConfig(descriptor: ConnectorDescriptor, config: ConnectorConfig): ConnectorConfig {
  const secrets = secretKeys(descriptor);
  const out: ConnectorConfig = { ...config };
  for (const key of Array.from(secrets)) {
    const v = out[key];
    if (typeof v === "string" && isEncrypted(v)) out[key] = decryptSecret(v);
  }
  return out;
}

/** Replace secret field values with a fixed mask for safe display in the UI. */
export function maskConfig(descriptor: ConnectorDescriptor, config: ConnectorConfig): ConnectorConfig {
  const secrets = secretKeys(descriptor);
  const out: ConnectorConfig = { ...config };
  for (const key of Array.from(secrets)) {
    if (typeof out[key] === "string" && out[key]) out[key] = "••••••••";
  }
  return out;
}
