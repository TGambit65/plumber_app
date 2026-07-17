import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { can, ROLE_HOME } from "@/lib/permissions";
import { PageHeader } from "@/components/ui";
import { FieldWorkspace } from "@/components/field/field-workspace";

export const dynamic = "force-dynamic";

/**
 * Field Mode — offline-first workspace shell.
 *
 * Server component: authenticates + gates on `jobs.work`, then hands off to the
 * client workspace which does ALL data access against IndexedDB + the sync
 * client (so it keeps working with no signal). No tenant data is read here; the
 * org-scoped sync endpoints are the only data path, and they enforce RLS.
 */
export default async function FieldPage() {
  const session = await requireSession();
  if (!can(session.role, "jobs.work")) redirect(ROLE_HOME[session.role]);

  return (
    <div>
      <PageHeader
        title="Field Mode"
        subtitle="Works offline. Every tap saves locally first, then syncs when you have signal."
      />
      <FieldWorkspace currentUserId={session.userId} userName={session.name} role={session.role} />
    </div>
  );
}
