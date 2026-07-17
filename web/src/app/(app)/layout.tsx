import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSession, destroySession } from "@/lib/auth";
import { ROLE_LABELS } from "@/lib/permissions";
import { navForUser } from "@/lib/nav";
import { effectivePermissions } from "@/lib/effective-permissions";
import { db, t } from "@/db";
import { and, eq, isNull, desc, inArray, ne } from "drizzle-orm";
import { Avatar } from "@/components/ui";
import { NavLinks, MobileNav } from "@/components/nav-links";
import { NotificationsBell } from "@/components/notifications-bell";
import { GlobalSearch } from "@/components/global-search";

async function logout() {
  "use server";
  await destroySession();
  redirect("/login");
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const perms = await effectivePermissions(session.userId, session.role);
  const nav = navForUser(session.role, perms);

  const unread = await db
    .select({ id: t.notifications.id, title: t.notifications.title, body: t.notifications.body, href: t.notifications.href, createdAt: t.notifications.createdAt })
    .from(t.notifications)
    .where(and(eq(t.notifications.userId, session.userId), isNull(t.notifications.readAt)))
    .orderBy(desc(t.notifications.createdAt))
    .limit(10);

  // Unread message count for the Messages nav badge.
  const myConvos = await db
    .select({ conversationId: t.conversationParticipants.conversationId, lastReadAt: t.conversationParticipants.lastReadAt })
    .from(t.conversationParticipants)
    .where(eq(t.conversationParticipants.userId, session.userId));
  let unreadMessages = 0;
  if (myConvos.length > 0) {
    const msgs = await db
      .select({ conversationId: t.messages.conversationId, createdAt: t.messages.createdAt, senderId: t.messages.senderId })
      .from(t.messages)
      .where(
        and(
          inArray(
            t.messages.conversationId,
            myConvos.map((c) => c.conversationId)
          ),
          ne(t.messages.senderId, session.userId)
        )
      );
    const lastRead = new Map(myConvos.map((c) => [c.conversationId, c.lastReadAt?.getTime() ?? 0]));
    unreadMessages = msgs.filter((m) => m.createdAt.getTime() > (lastRead.get(m.conversationId) ?? 0)).length;
  }

  return (
    <div className="flex min-h-screen">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-56 flex-col border-r border-slate-200 bg-slate-900 md:flex">
        <div className="flex h-14 items-center gap-2 border-b border-slate-800 px-4">
          <span className="text-xl">🔧</span>
          <div>
            <div className="text-sm font-bold text-white">Apex Plumbing</div>
            <div className="text-[10px] uppercase tracking-wider text-slate-400">{ROLE_LABELS[session.role]}</div>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
          <NavLinks items={nav} badges={{ "/messages": unreadMessages }} />
        </nav>
        <div className="border-t border-slate-800 p-3">
          <div className="flex items-center gap-2">
            <Avatar name={session.name} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium text-white">{session.name}</div>
              <div className="truncate text-[10px] text-slate-400">{session.email}</div>
            </div>
            <form action={logout}>
              <button
                type="submit"
                title="Sign out"
                className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
              >
                ⏻
              </button>
            </form>
          </div>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-h-screen w-full flex-col md:pl-56">
        {/* Top bar */}
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-slate-200 bg-white px-4">
          <Link href="/" className="flex items-center gap-2 md:hidden">
            <span className="text-lg">🔧</span>
            <span className="text-sm font-bold">Apex</span>
          </Link>
          <div className="ml-auto flex items-center gap-2">
            <GlobalSearch />
            <NotificationsBell items={unread} />
          </div>
        </header>

        <main className="flex-1 p-4 pb-24 md:p-6 md:pb-6">{children}</main>

        {/* Mobile bottom nav — thumb-zone, ≥48px targets */}
        <MobileNav items={nav.slice(0, 5)} badges={{ "/messages": unreadMessages }} />
      </div>
    </div>
  );
}
