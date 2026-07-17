import Link from "next/link";
import { db, t } from "@/db";
import { requireSession } from "@/lib/auth";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { Card, CardBody, CardHeader, PageHeader, EmptyState, Avatar, Badge } from "@/components/ui";
import { ROLE_LABELS } from "@/lib/permissions";
import { timeAgo } from "@/lib/format";
import { NewMessage } from "@/components/messaging/new-message";

export const dynamic = "force-dynamic";

export default async function MessagesPage() {
  const session = await requireSession();

  const myParts = await db
    .select({ conversationId: t.conversationParticipants.conversationId, lastReadAt: t.conversationParticipants.lastReadAt })
    .from(t.conversationParticipants)
    .where(eq(t.conversationParticipants.userId, session.userId));
  const convoIds = myParts.map((p) => p.conversationId);
  const lastRead = new Map(myParts.map((p) => [p.conversationId, p.lastReadAt?.getTime() ?? 0]));

  const convos = convoIds.length
    ? await db.query.conversations.findMany({
        where: inArray(t.conversations.id, convoIds),
        with: { participants: { with: { user: true } }, messages: { orderBy: [desc(t.messages.createdAt)], limit: 1 } },
        orderBy: [desc(t.conversations.lastMessageAt)],
      })
    : [];

  // Unread counts per conversation.
  const unreadByConvo = new Map<string, number>();
  if (convoIds.length) {
    const msgs = await db
      .select({ conversationId: t.messages.conversationId, createdAt: t.messages.createdAt })
      .from(t.messages)
      .where(and(inArray(t.messages.conversationId, convoIds), ne(t.messages.senderId, session.userId)));
    for (const m of msgs) {
      if (m.createdAt.getTime() > (lastRead.get(m.conversationId) ?? 0)) {
        unreadByConvo.set(m.conversationId, (unreadByConvo.get(m.conversationId) ?? 0) + 1);
      }
    }
  }

  const others = await db
    .select({ id: t.users.id, name: t.users.name, role: t.users.role })
    .from(t.users)
    .where(and(ne(t.users.id, session.userId), eq(t.users.active, true)));

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="💬 Messages"
        subtitle="Direct and group messaging across the field and office"
        action={<NewMessage users={others} />}
      />

      <Card>
        <CardHeader title="Conversations" subtitle={`${convos.length} threads`} />
        <CardBody className="p-0">
          {convos.length === 0 ? (
            <div className="p-4">
              <EmptyState title="No conversations yet" hint="Start one with the New message button." />
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {convos.map((c) => {
                const participants = c.participants.map((p) => p.user).filter((u) => u.id !== session.userId);
                const title = c.title || participants.map((u) => u.name).join(", ") || "Conversation";
                const last = c.messages[0];
                const unread = unreadByConvo.get(c.id) ?? 0;
                const roleHint = !c.isGroup && participants[0] ? ROLE_LABELS[participants[0].role] : `${c.participants.length} people`;
                return (
                  <li key={c.id}>
                    <Link href={`/messages/${c.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50">
                      {c.isGroup ? (
                        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-violet-100 text-violet-700">👥</span>
                      ) : (
                        <Avatar name={participants[0]?.name ?? "?"} />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className={`truncate text-sm ${unread ? "font-semibold text-slate-900" : "font-medium text-slate-800"}`}>
                            {title}
                          </span>
                          {c.isGroup ? <Badge tone="violet">group</Badge> : null}
                        </div>
                        <div className="truncate text-xs text-slate-500">
                          {last ? last.body : <span className="italic">No messages yet</span>}
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        {last ? <span className="text-[11px] text-slate-400">{timeAgo(last.createdAt)}</span> : null}
                        {unread > 0 ? (
                          <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1.5 text-[11px] font-bold text-white">
                            {unread}
                          </span>
                        ) : (
                          <span className="text-[11px] text-slate-400">{roleHint}</span>
                        )}
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
