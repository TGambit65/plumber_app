"use server";

import { randomBytes } from "crypto";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { t, withTenant } from "@/db";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { audit } from "./helpers";

/**
 * ICS calendar-feed management (dispatch D2).
 *
 * Feeds are capability URLs: creating one mints an unguessable token; revoking
 * kills the URL immediately (the serving route 404s revoked feeds). Gated on
 * integrations.manage — the same authority that manages connectors.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

export async function createCalendarFeed(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "integrations.manage")) throw new Error("Not allowed");
  const scope = str(formData, "scope") === "TECH" ? "TECH" : "ORG";
  const userId = str(formData, "userId") || null;
  if (scope === "TECH" && !userId) return;

  const token = randomBytes(24).toString("base64url");
  await withTenant(session.organizationId, async (tx) => {
    if (scope === "TECH" && userId) {
      const user = await tx.query.users.findFirst({ where: eq(t.users.id, userId) });
      if (!user) throw new Error("Unknown user");
    }
    await tx.insert(t.calendarFeeds).values({
      scope,
      userId: scope === "TECH" ? userId : null,
      token,
      createdById: session.userId,
    });
  });
  await audit(session.userId, "CREATE", "CalendarFeed", token.slice(0, 8), { scope, userId });
  revalidatePath("/settings");
}

export async function revokeCalendarFeed(formData: FormData) {
  const session = await requireSession();
  if (!can(session.role, "integrations.manage")) throw new Error("Not allowed");
  const feedId = str(formData, "feedId");
  if (!feedId) return;

  await withTenant(session.organizationId, (tx) =>
    tx
      .update(t.calendarFeeds)
      .set({ revokedAt: new Date() })
      .where(and(eq(t.calendarFeeds.id, feedId), isNull(t.calendarFeeds.revokedAt)))
  );
  await audit(session.userId, "REVOKE", "CalendarFeed", feedId);
  revalidatePath("/settings");
}
