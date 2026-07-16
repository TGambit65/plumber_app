# Module build contract (read fully before writing any code)

You are building feature pages for plumber_app, a Next.js 14 App Router app in `/home/claude/plumber_app/web`. The foundation is FROZEN — do not edit these files:

- `src/db/schema.ts`, `src/db/index.ts`, `src/db/seed.ts` (schema/seed; read them to learn tables & seeded data)
- `src/lib/auth.ts`, `src/lib/permissions.ts`, `src/lib/format.ts`, `src/lib/clsx.ts`, `src/lib/nav.ts`
- `src/lib/actions/helpers.ts`, `src/lib/actions/notifications.ts`
- `src/components/ui.tsx`, `src/components/nav-links.tsx`, `src/components/notifications-bell.tsx`, `src/components/global-search.tsx`
- `src/app/layout.tsx`, `src/app/(app)/layout.tsx`, `src/app/login/page.tsx`, `src/app/page.tsx`, `src/app/globals.css`, `middleware.ts`
- `package.json`, config files

Only create files inside YOUR assigned routes (under `src/app/(app)/...`), your assigned `src/lib/actions/<name>.ts`, and components under `src/components/<your-module>/`.

## How to build pages

- **Server components by default.** Fetch with Drizzle directly in the page:
  ```ts
  import { db, t } from "@/db";
  import { eq, desc, and, sql, inArray, isNull, gte, lte, ilike, or } from "drizzle-orm";
  const rows = await db.query.jobs.findMany({ with: { customer: true, property: true }, orderBy: ... });
  ```
  Relational queries (`db.query.<table>.findMany({ with: ... })`) work — relations are defined in schema.ts.
- **Mutations via server actions** in your assigned actions file: `"use server";` at top of file, then exported async functions. Call `requireSession()` first; check permissions with `can(session.role, "...")` where relevant; `revalidatePath(...)` after writes. Use `audit()` from helpers for sensitive actions and `logActivity()`/`notify()` where the spec calls for timeline/notifications.
- **Auth in pages:** `const session = await requireSession();` — redirect or show 403 message if role shouldn't see the page (`can()` from `@/lib/permissions`).
- **Money is integer cents.** Format with `money(cents)` from `@/lib/format`; monthly financing framing with `monthly(cents)`. Dates: `fmtDate/fmtTime/fmtDateTime/timeAgo`.
- **UI kit** (`@/components/ui`): Card, CardHeader, CardBody, Badge (+ jobStatusTone/leadStageTone/invoiceStatusTone/estimateStatusTone + statusLabel), Button/LinkButton/buttonClass, Input/Textarea/Select/Label/Field, Table/THead/TRow/TCell, Stat, EmptyState, PageHeader, Avatar. Use these — do not hand-roll new patterns or install packages.
- **Design language:** light theme, slate/blue, rounded-xl cards, compact density, tasteful emoji icons (already used in nav). Mobile-first for tech-facing pages (big ≥48px touch targets, bottom-of-screen primary actions). No dark mode.
- **Client components** only where interactivity demands (forms with local state, kanban drag, dialogs). Mark with `"use client"` and keep them in `src/components/<your-module>/`.
- Use `<form action={serverAction}>` binding for mutations wherever possible (progressive enhancement), with hidden inputs for ids.
- Next 14 quirk: server actions passed to client components must be imported from a `"use server"` file (not defined inline in a server component and passed down).
- Never use `Date.now()` tricks for ids; DB generates ids. Use `redirect()` from `next/navigation` after create-then-view flows.

## Quality bar

- `npx tsc --noEmit` must pass when you finish (run it; fix everything yours).
- No `any` unless unavoidable; prefer `typeof t.jobs.$inferSelect` style types.
- Every page handles empty states (`EmptyState`).
- Realistic polish: the seeded data (see `src/db/seed.ts`) should make every page look alive. Demo accounts: owner@/office@/sales@/tech@apexplumbing.demo, password demo1234.
- Return a summary of files created and any deviations.
