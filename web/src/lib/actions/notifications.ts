"use server";

import { t, withTenant } from "@/db";
import { requireSession } from "@/lib/auth";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function markAllNotificationsRead() {
  const session = await requireSession();
  await withTenant(session.organizationId, (tx) =>
    tx
      .update(t.notifications)
      .set({ readAt: new Date() })
      .where(and(eq(t.notifications.userId, session.userId), isNull(t.notifications.readAt)))
  );
  revalidatePath("/", "layout");
}
