import { describe, expect, it } from "vitest";
import { createHash } from "crypto";
import { newTransaction, sealTransaction, openTransaction, pkceChallenge } from "../sso-txn";

describe("sso transaction primitives", () => {
  it("mints unique state/nonce/verifier with a correct S256 challenge", () => {
    const a = newTransaction("summit-hvac");
    const b = newTransaction("summit-hvac");
    expect(a.state).not.toBe(b.state);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.verifier).not.toBe(b.verifier);
    // RFC 7636 verifier length bounds
    expect(a.verifier.length).toBeGreaterThanOrEqual(43);
    expect(a.verifier.length).toBeLessThanOrEqual(128);
    // challenge = BASE64URL(SHA256(verifier))
    const expected = createHash("sha256").update(a.verifier).digest().toString("base64url");
    expect(a.challenge).toBe(expected);
    expect(pkceChallenge(a.verifier)).toBe(expected);
  });

  it("round-trips through seal/open", async () => {
    const txn = newTransaction("apex-plumbing");
    const sealed = await sealTransaction(txn);
    const opened = await openTransaction(sealed);
    expect(opened).toEqual({
      slug: "apex-plumbing",
      state: txn.state,
      nonce: txn.nonce,
      verifier: txn.verifier,
    });
  });

  it("rejects tampered and garbage cookies", async () => {
    const sealed = await sealTransaction(newTransaction("apex-plumbing"));
    // Flip a char in the signature segment
    const tampered = sealed.slice(0, -2) + (sealed.endsWith("A") ? "BB" : "AA");
    expect(await openTransaction(tampered)).toBeNull();
    expect(await openTransaction("not-a-jwt")).toBeNull();
    expect(await openTransaction("")).toBeNull();
  });
});
