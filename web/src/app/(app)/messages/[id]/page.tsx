import Link from "next/link";
import { notFound } from "next/navigation";
import { t, withTenant } from "@/db";
import { requireSession } from "@/lib/auth";
import { and, asc, eq } from "drizzle-orm";
import { Avatar, Badge } from "@/components/ui";
import { ROLE_LABELS } from "@/lib/permissions";
import { fmtDateTime } from "@/lib/format";
import { sendMessage, markConversationRead } from "@/lib/actions/messages";
import { MarkRead } from "@/components/messaging/mark-read";

export const dynamic = "force-dynamic";

export default async function ThreadPage({ params }: { params: { id: string } }) {
  const session = await requireSession();

  // All page queries run in ONE tenant-scoped transaction; notFound() is called
  // outside so it doesn't abort the transaction machinery mid-flight.
  const convo = await withTenant(session.organizationId, async (tx) => {
    const [membership] = await tx
      .select({ id: t.conversationParticipants.id })
      .from(t.conversationParticipants)
      .where(and(eq(t.conversationParticipants.conversationId, params.id), eq(t.conversationParticipants.userId, session.userId)));
    if (!membership) return null;

    return (
      (await tx.query.conversations.findFirst({
        where: eq(t.conversations.id, params.id),
        with: {
          participants: { with: { user: true } },
          messages: { with: { sender: true }, orderBy: [asc(t.messages.createdAt)] },
        },
      })) ?? null
    );
  });
  if (!convo) notFound();

  const others = convo.participants.map((p) => p.user).filter((u) => u.id !== session.userId);
  const title = convo.title || others.map((u) => u.name).join(", ") || "Conversation";

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
                  <div
                    className={`rounded-2xl px-3.5 py-2 text-sm ${
                      mine ? "rounded-br-sm bg-blue-600 text-white" : "rounded-bl-sm border border-slate-200 bg-white text-slate-800"
                    }`}
                  >
                    {m.body}
                  </div>
                  <div className={`mt-0.5 text-[10px] text-slate-400 ${mine ? "text-right" : "text-left"}`}>
                    {fmtDateTime(m.createdAt)}
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
