import "server-only";
import path from "path";

/**
 * Job-photo storage layout.
 *
 * Photos used to be written into `public/uploads/<orgId>/` and referenced by
 * their raw path. Anything under `public/` is served by Next as a static asset
 * with NO session check, so on any deployment those files were world-readable
 * to whoever held (or guessed) the URL — across tenants, with the org id right
 * there in the path. They were also invisible until the next restart, because
 * `next start` snapshots the public directory at boot; the practical effect was
 * "photos look broken, then silently become public after a deploy".
 *
 * Files now live OUTSIDE the web root and are served only by
 * `GET /api/photos/[id]`, which resolves the row inside withTenant() so RLS
 * decides who may read it. The DB row is the capability; the path is not.
 */

/** Root of the private photo store. Must not be inside `public/`. */
export function uploadRoot(): string {
  return process.env.UPLOADS_DIR || path.join(process.cwd(), "var", "uploads");
}

/** Storage key for a newly written file: `<orgId>/<filename>`. */
export function storageKey(orgId: string, filename: string): string {
  return `${orgId}/${filename}`;
}

/**
 * Legacy rows stored `/uploads/<orgId>/<file>`; seed/demo rows store
 * `/demo-photos/x.svg` or an absolute URL. Normalise the managed ones to a
 * bare key and leave the rest recognisable.
 */
export function normalizeKey(url: string): string {
  return url.startsWith("/uploads/") ? url.slice("/uploads/".length) : url;
}

/** True when the stored value is a file WE hold, rather than a demo/external asset. */
export function isManagedKey(url: string): boolean {
  if (/^https?:\/\//i.test(url)) return false;
  if (url.startsWith("/demo-photos/")) return false;
  return true;
}

/** `a/b/c.jpg` → `a/b/c.thumb.jpg`. Mirrors what the upload route writes. */
export function thumbKey(key: string): string {
  const dot = key.lastIndexOf(".");
  if (dot <= key.lastIndexOf("/")) return key; // no extension → no thumb variant
  return `${key.slice(0, dot)}.thumb${key.slice(dot)}`;
}

/**
 * Resolve a storage key to an absolute path, refusing anything that escapes the
 * root. Keys are server-generated today, but this is the boundary where a
 * crafted value would otherwise become an arbitrary file read.
 */
export function resolveStoredPath(key: string): string | null {
  if (!key || key.includes("\0")) return null;
  const root = path.resolve(uploadRoot());
  const full = path.resolve(root, key);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
};

export function contentTypeFor(key: string): string {
  return CONTENT_TYPES[path.extname(key).toLowerCase()] || "application/octet-stream";
}
