import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import {
  contentTypeFor,
  isManagedKey,
  normalizeKey,
  resolveStoredPath,
  storageKey,
  thumbKey,
  uploadRoot,
} from "@/lib/photo-storage";

describe("photo storage", () => {
  const original = process.env.UPLOADS_DIR;
  beforeEach(() => {
    process.env.UPLOADS_DIR = "/srv/photos";
  });
  afterEach(() => {
    if (original === undefined) delete process.env.UPLOADS_DIR;
    else process.env.UPLOADS_DIR = original;
  });

  it("never resolves inside the web root", () => {
    // The whole point of the move: a served-by-Next directory must not be the store.
    delete process.env.UPLOADS_DIR;
    expect(uploadRoot()).not.toContain(`${path.sep}public${path.sep}`);
    expect(uploadRoot().endsWith(path.join("var", "uploads"))).toBe(true);
  });

  it("builds org-scoped keys", () => {
    expect(storageKey("org_1", "123-abc.jpg")).toBe("org_1/123-abc.jpg");
  });

  it("derives the thumbnail key the upload route writes", () => {
    expect(thumbKey("org_1/123-abc.jpg")).toBe("org_1/123-abc.thumb.jpg");
  });

  it("leaves extensionless keys alone rather than inventing a thumb", () => {
    expect(thumbKey("org_1/noext")).toBe("org_1/noext");
  });

  it("normalises legacy /uploads/ rows written before the move", () => {
    expect(normalizeKey("/uploads/org_1/123-abc.jpg")).toBe("org_1/123-abc.jpg");
    expect(normalizeKey("org_1/123-abc.jpg")).toBe("org_1/123-abc.jpg");
  });

  it("treats demo and external assets as unmanaged", () => {
    expect(isManagedKey("/demo-photos/wh-before.svg")).toBe(false);
    expect(isManagedKey("https://cdn.example.com/x.jpg")).toBe(false);
    expect(isManagedKey("org_1/123-abc.jpg")).toBe(true);
  });

  it("refuses path traversal out of the store", () => {
    expect(resolveStoredPath("../../etc/passwd")).toBeNull();
    expect(resolveStoredPath("org_1/../../../etc/passwd")).toBeNull();
    expect(resolveStoredPath("/etc/passwd")).toBeNull();
  });

  it("refuses null bytes and empty keys", () => {
    expect(resolveStoredPath("")).toBeNull();
    expect(resolveStoredPath("org_1/a\0b.jpg")).toBeNull();
  });

  it("resolves legitimate keys under the configured root", () => {
    expect(resolveStoredPath("org_1/123-abc.jpg")).toBe("/srv/photos/org_1/123-abc.jpg");
  });

  it("does not let a sibling directory masquerade as the root", () => {
    // /srv/photos-evil must not pass a naive startsWith(root) check.
    expect(resolveStoredPath("../photos-evil/x.jpg")).toBeNull();
  });

  it("maps content types and defaults to a non-renderable type", () => {
    expect(contentTypeFor("a/b.jpg")).toBe("image/jpeg");
    expect(contentTypeFor("a/b.PNG")).toBe("image/png");
    expect(contentTypeFor("a/b.bin")).toBe("application/octet-stream");
  });
});
