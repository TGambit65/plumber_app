import "server-only";
import { cache } from "react";
import { db, t } from "@/db";
import { eq } from "drizzle-orm";
import { ROLE_PERMISSIONS, type Permission } from "./permissions";
import type { Role, Session } from "./auth";

/**
 * Effective permissions = role bundle + granted overrides − revoked overrides.
 * Cached per request so repeated checks in one render don't re-query.
 */
export const effectivePermissions = cache(
  async (userId: string, role: Role): Promise<Set<Permission>> => {
    const base = new Set<Permission>(ROLE_PERMISSIONS[role]);
    const overrides = await db
      .select({ permission: t.userPermissionOverrides.permission, granted: t.userPermissionOverrides.granted })
      .from(t.userPermissionOverrides)
      .where(eq(t.userPermissionOverrides.userId, userId));
    for (const o of overrides) {
      if (o.granted) base.add(o.permission as Permission);
      else base.delete(o.permission as Permission);
    }
    return base;
  }
);

/** Override-aware permission check for the current session. */
export async function userCan(session: Session, permission: Permission): Promise<boolean> {
  const perms = await effectivePermissions(session.userId, session.role);
  return perms.has(permission);
}
