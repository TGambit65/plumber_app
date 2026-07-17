"use server";

import { db, t } from "@/db";
import { requireSession } from "@/lib/auth";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { notify } from "./helpers";
import { redirect } from "next/navigation";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

/** Find an existing 1:1 conversation between two users, or null. */
async function find1to1(a: string, b: string): Promise<string | null> {
  const rows = await db
    .select({ conversationId: t.conversationParticipants.conversationId })
    .from(t.conversationParticipants)
    .where(inArray(t.conversationParticipants.userId, [a, b]));
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.conversationId, (counts.get(r.conversationId) ?? 0) + 1);
  const candidates = Array.from(counts.entries()).filter(([, n]) => n === 2).map(([id]) => id);
  for (const cid of candidates) {
    const parts = await db
      .select({ userId: t.conversationParticipants.userId })
      .from(t.conversationParticipants)
      .where(eq(t.conversationParticipants.conversationId, cid));
    const grp = await db.select({ isGroup: t.conversations.isGroup }).from(t.conversations).where(eq(t.conversations.id, cid));
    if (parts.length === 2 && !grp[0]?.isGroup) return cid;
  }
  return null;
}

/** Start (or reuse) a conversation and post the first message. */
export async function startConversation(formData: FormData) {
  const session = await requireSession();
  const recipientIds = formData.getAll("recipients").map((v) => String(v)).filter((v) => v && v !== session.userId);
  const title = str(formData, "title") || null;
  const body = str(formData, "body");
  if (recipientIds.length === 0) return;

  const isGroup = recipientIds.length > 1;
  let conversationId: string | null = null;

  if (!isGroup) {
    conversationId = await find1to1(session.userId, recipientIds[0]);
  }

  if (!conversationId) {
    const [conv] = await db
      .insert(t.conversations)
      .values({ title: isGroup ? title : null, isGroup, createdById: session.userId })
      .returning();
    conversationId = conv.id;
    const everyone = [session.userId, ...recipientIds];
    await db.insert(t.conversationParticipants).values(
      everyone.map((userId) => ({ conversationId: conv.id, userId, lastReadAt: userId === session.userId ? new Date() : null }))
    );
  }

  if (body) {
    await postMessage(conversationId, session.userId, session.name, body, recipientIds);
  }
  revalidatePath("/messages");
  redirect(`/messages/${conversationId}`);
}

async function postMessage(conversationId: string, senderId: string, senderName: string, body: string, notifyIds?: string[]) {
  await db.insert(t.messages).values({ conversationId, senderId, body });
  await db.update(t.conversations).set({ lastMessageAt: new Date() }).where(eq(t.conversations.id, conversationId));
  await db
    .update(t.conversationParticipants)
    .set({ lastReadAt: new Date() })
    .where(and(eq(t.conversationParticipants.conversationId, conversationId), eq(t.conversationParticipants.userId, senderId)));

  // Notify other participants.
  let recipients = notifyIds;
  if (!recipients) {
    const parts = await db
      .select({ userId: t.conversationParticipants.userId })
      .from(t.conversationParticipants)
      .where(eq(t.conversationParticipants.conversationId, conversationId));
    recipients = parts.map((p) => p.userId).filter((id) => id !== senderId);
  }
  const preview = body.length > 60 ? body.slice(0, 60) + "…" : body;
  for (const uid of recipients) {
    await notify(uid, `💬 ${senderName}`, preview, `/messages/${conversationId}`);
  }
}

/** Send a message to an existing conversation. */
export async function sendMessage(formData: FormData) {
  const session = await requireSession();
  const conversationId = str(formData, "conversationId");
  const body = str(formData, "body");
  if (!conversationId || !body) return;
  // Membership check.
  const [member] = await db
    .select({ id: t.conversationParticipants.id })
    .from(t.conversationParticipants)
    .where(and(eq(t.conversationParticipants.conversationId, conversationId), eq(t.conversationParticipants.userId, session.userId)));
  if (!member) throw new Error("Not a participant");
  await postMessage(conversationId, session.userId, session.name, body);
  revalidatePath(`/messages/${conversationId}`);
  revalidatePath("/messages");
}

/** Mark a conversation read for the current user. */
export async function markConversationRead(conversationId: string) {
  const session = await requireSession();
  await db
    .update(t.conversationParticipants)
    .set({ lastReadAt: new Date() })
    .where(
      and(
        eq(t.conversationParticipants.conversationId, conversationId),
        eq(t.conversationParticipants.userId, session.userId)
      )
    );
  revalidatePath("/", "layout");
}
