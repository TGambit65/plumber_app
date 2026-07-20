import Link from "next/link";
import { notFound } from "next/navigation";
import { t, withTenant } from "@/db";
import { requireSession } from "@/lib/auth";
import { and, asc, eq } from "drizzle-orm";
import { Avatar, Badge } from "@/components/ui";
import { ROLE_LABELS } from "@/lib/permissions";
import { fmtDateTime } from "@/lib/format";
import {
  addParticipant,
  archiveThread,
  deleteOwnMessage,
  leaveConversation,
  markConversationRead,
  removeParticipant,
  renameConversation,
  sendMessage,
  unarchiveThread,
} from "@/lib/actions/messages";
import { MarkRead } from "@/components/messaging/mark-read";

export const dynamic = "force-dynamic";

export default async function ThreadPage({ params }: { params: { id: string } }) {
  const session = await requireSession();

  // All page queries run in ONE tenant-scoped transaction; notFound() is called
  // outside so it doesn't abort the transaction machinery mid-flight.
  const data = await withTenant(session.organizationId, async (tx) => {
    const [membership] = await tx
      .select({ id: t.conversationParticipants.id, archivedAt: t.conversationParticipants.archivedAt })
      .from(t.conversationParticipants)
      .where(and(eq(t.conversationParticipants.conversationId, params.id), eq(t.conversationParticipants.userId, session.userId)));
    if (!membership) return null;

    const convo = await tx.query.conversations.findFirst({
      where: eq(t.conversations.id, params.id),
      with: {
        participants: { with: { user: true } },
        messages: { with: { sender: true }, orderBy: [asc(t.messages.createdAt)] },
      },
    });
    if (!convo) return null;
    // M4: teammates available to add to a group.
    const allUsers = convo.isGroup
      ? await tx.query.users.findMany({ where: eq(t.users.active, true), orderBy: [t.users.name] })
      : [];
    return { convo, membership, allUsers };
  });
  if (!data) notFound();
  const { convo, membership, allUsers } = data;

  const others = convo.participants.map((p) => p.user).filter((u) => u.id !== session.userId);
  const title = convo.title || others.map((u) => u.name).join(", ") || "Conversation";
  const canManageGroup = convo.isGroup && (convo.createdById === session.userId || session.role === "ADMIN");
  const memberIds = new Set(convo.participants.map((p) => p.userId));
  const addable = allUsers.filter((u) => !memberIds.has(u.id));
  const GRACE_MS = 15 * 60 * 1000;

  return (
    <div className="mx-auto flex h-[calc(100vh-8rem)] max-w-2xl flex-col md:h-[calc(100vh-6rem)]">
      <MarkRead conversationId={params.id} action={markConversationRead} />

      {/* Header */}
      <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <Link href="/messages" className="text-slate-400 hover:text-slate-600">←</Link>
        {convo.isGroup ? (
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-violet-100 text-violet-700">👥</span>
        ) : (
          <Avatar name={others[0]?.name ?? "?"} />
        )}
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-sm font-semibold">{title}</h1>
            {convo.isGroup ? <Badge tone="violet">group</Badge> : null}
          </div>
          <p className="truncate text-xs text-slate-500">
            {convo.isGroup
              ? convo.participants.map((p) => p.user.name.split(" ")[0]).join(", ")
              : others[0]
                ? ROLE_LABELS[others[0].role]
                : ""}
          </p>
        </div>
        {/* M4: thread management */}
        <details className="relative ml-auto">
          <summary className="cursor-pointer rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-100">⋯</summary>
          <div className="absolute right-0 z-20 mt-1 w-72 space-y-2 rounded-lg border border-slate-200 bg-white p-3 shadow-lg">
            {membership.archivedAt ? (
              <form action={unarchiveThread}>
                <input type="hidden" name="conversationId" value={convo.id} />
                <button type="submit" className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-left text-xs font-medium text-slate-700 hover:bg-slate-50">
                  ♻️ Unarchive this thread (for you)
                </button>
              </form>
            ) : (
              <form action={archiveThread}>
                <input type="hidden" name="conversationId" value={convo.id} />
                <button type="submit" className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-left text-xs font-medium text-slate-700 hover:bg-slate-50" title="Hides the thread from YOUR list only">
                  📦 Archive thread (for you)
                </button>
              </form>
            )}
            {convo.isGroup ? (
              <form action={leaveConversation}>
                <input type="hidden" name="conversationId" value={convo.id} />
                <button type="submit" className="w-full rounded-md border border-red-200 px-2 py-1.5 text-left text-xs font-medium text-red-600 hover:bg-red-50">
                  🚪 Leave group
                </button>
              </form>
            ) : null}
            {canManageGroup ? (
              <>
                <form action={renameConversation} className="flex gap-1.5 border-t border-slate-100 pt-2">
                  <input type="hidden" name="conversationId" value={convo.id} />
                  <input name="title" required defaultValue={convo.title ?? ""} placeholder="Group name" aria-label="Group name" className="h-8 flex-1 rounded-md border border-slate-300 px-2 text-xs" />
                  <button type="submit" className="rounded-md bg-slate-800 px-2 text-xs font-medium text-white hover:bg-slate-700">Rename</button>
                </form>
                {addable.length > 0 ? (
                  <form action={addParticipant} className="flex gap-1.5">
                    <input type="hidden" name="conversationId" value={convo.id} />
                    <select name="userId" required defaultValue="" aria-label="Add teammate" className="h-8 flex-1 rounded-md border border-slate-300 px-1.5 text-xs">
                      <option value="" disabled>Add teammate…</option>
                      {addable.map((u) => (
                        <option key={u.id} value={u.id}>{u.name}</option>
                      ))}
                    </select>
                    <button type="submit" className="rounded-md bg-slate-800 px-2 text-xs font-medium text-white hover:bg-slate-700">Add</button>
                  </form>
                ) : null}
                <div className="space-y-1 border-t border-slate-100 pt-2">
                  {convo.participants.filter((p) => p.userId !== session.userId).map((p) => (
                    <form key={p.id} action={removeParticipant} className="flex items-center gap-2">
                      <input type="hidden" name="conversationId" value={convo.id} />
                      <input type="hidden" name="userId" value={p.userId} />
                      <span className="flex-1 truncate text-xs text-slate-700">{p.user.name}</span>
                      <button type="submit" className="rounded px-1.5 py-0.5 text-[11px] font-medium text-red-600 hover:bg-red-50">Remove</button>
                    </form>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        </details>
      </div>

      {/* Messages */}
      <div className="flex-1 space-y-3 overflow-y-auto bg-slate-50 p-4">
        {convo.messages.length === 0 ? (
          <p className="py-10 text-center text-sm text-slate-400">No messages yet — say hello 👋</p>
        ) : (
          convo.messages.map((m) => {
            const mine = m.senderId === session.userId;
            return (
              <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[80%] ${mine ? "items-end" : "items-start"}`}>
                  {!mine && convo.isGroup ? (
                    <div className="mb-0.5 ml-1 text-[11px] font-medium text-slate-500">{m.sender.name}</div>
                  ) : null}
                  {m.deletedAt ? (
                    <div className="rounded-2xl border border-dashed border-slate-300 px-3.5 py-2 text-sm italic text-slate-400">
                      🚫 message removed
                    </div>
                  ) : (
                    <div
                      className={`rounded-2xl px-3.5 py-2 text-sm ${
                        mine ? "rounded-br-sm bg-blue-600 text-white" : "rounded-bl-sm border border-slate-200 bg-white text-slate-800"
                      }`}
                    >
                      {m.body}
                    </div>
                  )}
                  <div className={`mt-0.5 flex items-center gap-1.5 text-[10px] text-slate-400 ${mine ? "justify-end" : "justify-start"}`}>
                    {fmtDateTime(m.createdAt)}
                    {/* M4: take back a mis-send within the 15-minute grace window */}
                    {!m.deletedAt &&
                    ((mine && Date.now() - m.createdAt.getTime() <= GRACE_MS) || session.role === "ADMIN") ? (
                      <form action={deleteOwnMessage}>
                        <input type="hidden" name="messageId" value={m.id} />
                        <button type="submit" title="Remove this message (leaves a placeholder)" className="rounded px-1 text-[10px] text-red-400 hover:bg-red-50 hover:text-red-600">
                          remove
                        </button>
                      </form>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Composer */}
      <form action={sendMessage} className="flex items-center gap-2 border-t border-slate-200 bg-white p-3">
        <input type="hidden" name="conversationId" value={params.id} />
        <input
          name="body"
          required
          autoComplete="off"
          placeholder="Type a message…"
          className="h-11 flex-1 rounded-full border border-slate-300 px-4 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <button type="submit" className="flex h-11 w-11 items-center justify-center rounded-full bg-blue-600 text-white hover:bg-blue-700">
          ➤
        </button>
      </form>
    </div>
  );
}
