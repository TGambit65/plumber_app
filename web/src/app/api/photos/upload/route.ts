import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import sharp from "sharp";
import { t, withTenant } from "@/db";
import { getSession } from "@/lib/auth";
import { audit } from "@/lib/actions/helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PHOTO_KINDS = new Set(["BEFORE", "DURING", "AFTER", "PROBLEM", "COVERUP"]);
const MAX_BYTES = 15 * 1024 * 1024; // 15 MB
const UPLOAD_ROOT = path.join(process.cwd(), "public", "uploads");

/**
 * Photo upload — completes the offline photo pipeline (spec §5).
 * The offline client queues captures locally and POSTs them here (multipart)
 * when connectivity returns; this stores the original + a thumbnail and records
 * an org-scoped job_photos row. Org isolation is enforced via withTenant/RLS;
 * the file lands under public/uploads/<orgId>/ so it can never be reached from
 * another tenant's job (the DB row is the only index and it's RLS-filtered).
 */
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  }

  const file = form.get("file");
  const jobId = String(form.get("jobId") ?? "").trim();
  const kindRaw = String(form.get("kind") ?? "AFTER").trim().toUpperCase();
  const caption = String(form.get("caption") ?? "").trim() || null;
  const localId = String(form.get("localId") ?? "").trim() || null;

  if (!(file instanceof Blob)) return NextResponse.json({ error: "file is required" }, { status: 400 });
  if (!jobId) return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  if (file.size === 0 || file.size > MAX_BYTES) return NextResponse.json({ error: "file too large or empty" }, { status: 400 });
  const kind = PHOTO_KINDS.has(kindRaw) ? kindRaw : "AFTER";

  // Verify the job belongs to the caller's org BEFORE writing any file.
  const job = await withTenant(session.organizationId, (tx) =>
    tx.query.jobs.findFirst({ columns: { id: true }, where: (j, { eq }) => eq(j.id, jobId) })
  );
  if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });

  const input = Buffer.from(await file.arrayBuffer());
  const dir = path.join(UPLOAD_ROOT, session.organizationId);
  await fs.mkdir(dir, { recursive: true });

  // Re-encode to JPEG (normalizes + strips EXIF), plus a small thumbnail.
  const base = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let fullName = `${base}.jpg`;
  let thumbName = `${base}.thumb.jpg`;
  try {
    await sharp(input).rotate().jpeg({ quality: 82 }).toFile(path.join(dir, fullName));
    await sharp(input).rotate().resize(400, 400, { fit: "inside" }).jpeg({ quality: 70 }).toFile(path.join(dir, thumbName));
  } catch {
    // Non-image or sharp failure → store the raw bytes as-is; skip thumbnail.
    fullName = `${base}.bin`;
    thumbName = fullName;
    await fs.writeFile(path.join(dir, fullName), input);
  }

  const url = `/uploads/${session.organizationId}/${fullName}`;
  const thumbUrl = `/uploads/${session.organizationId}/${thumbName}`;

  const [row] = await withTenant(session.organizationId, (tx) =>
    tx
      .insert(t.jobPhotos)
      .values({ jobId, kind: kind as "BEFORE" | "DURING" | "AFTER" | "PROBLEM" | "COVERUP", url, caption, takenById: session.userId })
      .returning()
  );

  await audit(session.userId, "UPLOAD_PHOTO", "JobPhoto", row.id, { jobId, kind, bytes: file.size });

  return NextResponse.json({ localId, photo: { id: row.id, jobId, kind, url, thumbUrl, caption } }, { status: 201 });
}
