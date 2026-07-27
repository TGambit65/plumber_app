import { NextResponse, type NextRequest } from "next/server";
import { promises as fs } from "fs";
import { and, eq, isNull } from "drizzle-orm";
import { t, withTenant } from "@/db";
import { getSession } from "@/lib/auth";
import {
  contentTypeFor,
  isManagedKey,
  normalizeKey,
  resolveStoredPath,
  thumbKey,
} from "@/lib/photo-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/photos/[id] — the ONLY way to read a job photo.
 *
 * Authorisation is the DB row, not the path: the lookup runs inside
 * withTenant(), so RLS scopes it to the caller's org and another tenant's
 * photo id is simply not found. Soft-deleted photos 404 too.
 *
 * `?v=thumb` serves the small variant, falling back to the original when a
 * thumbnail was never produced (non-image uploads skip it).
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const photo = await withTenant(session.organizationId, (tx) =>
    tx.query.jobPhotos.findFirst({
      columns: { id: true, url: true },
      where: and(eq(t.jobPhotos.id, params.id), isNull(t.jobPhotos.deletedAt)),
    })
  );
  if (!photo) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Seed/demo rows point at public assets or external URLs — hand those back as
  // a redirect rather than trying to read them off disk.
  if (!isManagedKey(photo.url)) {
    return NextResponse.redirect(new URL(photo.url, req.nextUrl.origin));
  }

  const key = normalizeKey(photo.url);
  const wantThumb = req.nextUrl.searchParams.get("v") === "thumb";

  let filePath = resolveStoredPath(wantThumb ? thumbKey(key) : key);
  if (wantThumb && filePath) {
    // Thumbnail may not exist (non-image upload) — fall back to the original.
    try {
      await fs.access(filePath);
    } catch {
      filePath = resolveStoredPath(key);
    }
  }
  if (!filePath) return NextResponse.json({ error: "not found" }, { status: 404 });

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(filePath);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": contentTypeFor(key),
      "Content-Length": String(bytes.length),
      // Customer property and insurance-claim documentation: never let a shared
      // cache hold this, and re-check the session on every view.
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    },
  });
}
