import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encryptSecret, decryptSecret, isEncrypted, __resetKeyCache } from "../crypto/secrets";
import { encryptConfig, decryptConfig, maskConfig } from "../connectors/secret-config";
import type { ConnectorDescriptor } from "../connectors/types";

const DESC: ConnectorDescriptor = {
  provider: "TEST",
  label: "Test",
  emoji: "🧪",
  capabilities: ["crm"],
  blurb: "",
  configFields: [
    { key: "baseUrl", label: "Base URL", kind: "url", required: true },
    { key: "apiKey", label: "API key", kind: "password", required: true },
    { key: "sharedSecret", label: "Shared secret", kind: "password" },
  ],
};

describe("secret cipher (AES-256-GCM)", () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = "test-secret";
    delete process.env.APP_ENCRYPTION_KEY;
    __resetKeyCache();
  });
  afterEach(() => __resetKeyCache());

  it("round-trips a value and marks it encrypted", () => {
    const ct = encryptSecret("pat-na1-super-secret");
    expect(isEncrypted(ct)).toBe(true);
    expect(ct).not.toContain("super-secret");
    expect(ct.startsWith("enc:v1:")).toBe(true);
    expect(decryptSecret(ct)).toBe("pat-na1-super-secret");
  });

  it("produces a fresh IV each call (ciphertexts differ, both decrypt)", () => {
    const a = encryptSecret("same");
    const b = encryptSecret("same");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same");
    expect(decryptSecret(b)).toBe("same");
  });

  it("passes legacy plaintext through decrypt unchanged", () => {
    expect(isEncrypted("plain-token")).toBe(false);
    expect(decryptSecret("plain-token")).toBe("plain-token");
  });

  it("throws on a tampered ciphertext (GCM auth failure)", () => {
    const ct = encryptSecret("integrity-matters");
    // Flip the last base64 char of the ciphertext segment.
    const tampered = ct.slice(0, -1) + (ct.endsWith("A") ? "B" : "A");
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("cannot decrypt under a different key", () => {
    const ct = encryptSecret("key-bound");
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    __resetKeyCache();
    expect(() => decryptSecret(ct)).toThrow();
  });

  it("accepts a 32-byte hex or base64 APP_ENCRYPTION_KEY and rejects wrong length", () => {
    process.env.APP_ENCRYPTION_KEY = "aa".repeat(32); // 64 hex chars = 32 bytes
    __resetKeyCache();
    expect(decryptSecret(encryptSecret("hex-key"))).toBe("hex-key");

    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");
    __resetKeyCache();
    expect(decryptSecret(encryptSecret("b64-key"))).toBe("b64-key");

    process.env.APP_ENCRYPTION_KEY = "too-short";
    __resetKeyCache();
    expect(() => encryptSecret("x")).toThrow(/32 bytes/);
  });
});

describe("connector secret-config", () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = "test-secret";
    delete process.env.APP_ENCRYPTION_KEY;
    __resetKeyCache();
  });

  it("encrypts only password-kind fields, leaves the rest plaintext", () => {
    const enc = encryptConfig(DESC, { baseUrl: "https://x", apiKey: "KEY", sharedSecret: "S", lastError: "boom" });
    expect(enc.baseUrl).toBe("https://x");
    expect(enc.lastError).toBe("boom");
    expect(isEncrypted(enc.apiKey!)).toBe(true);
    expect(isEncrypted(enc.sharedSecret!)).toBe(true);
  });

  it("decryptConfig is the inverse; encryptConfig is idempotent on encrypted input", () => {
    const enc = encryptConfig(DESC, { baseUrl: "https://x", apiKey: "KEY", sharedSecret: "S" });
    const encTwice = encryptConfig(DESC, enc);
    expect(encTwice.apiKey).toBe(enc.apiKey); // not double-encrypted
    const dec = decryptConfig(DESC, encTwice);
    expect(dec).toMatchObject({ baseUrl: "https://x", apiKey: "KEY", sharedSecret: "S" });
  });

  it("does not encrypt empty secret values", () => {
    const enc = encryptConfig(DESC, { baseUrl: "https://x", apiKey: "", sharedSecret: "" });
    expect(enc.apiKey).toBe("");
    expect(enc.sharedSecret).toBe("");
  });

  it("maskConfig hides secrets for display", () => {
    const masked = maskConfig(DESC, { baseUrl: "https://x", apiKey: "KEY", sharedSecret: "S" });
    expect(masked.baseUrl).toBe("https://x");
    expect(masked.apiKey).toBe("••••••••");
    expect(masked.sharedSecret).toBe("••••••••");
  });
});
