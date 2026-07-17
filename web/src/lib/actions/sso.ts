"use server";

import { db, t } from "@/db";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { audit } from "@/lib/actions/helpers";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { encryptSecret, isEncrypted } from "@/lib/crypto/secrets";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

/**
 * Per-org OIDC SSO configuration (constraints 2 & 10).
 *
 * The `organizations` table is NOT under RLS (it's the tenant root), so we read
 * and write the caller's org row on the base `db` client — BUT we always gate by
 * role first and only ever touch `session.organizationId`, never an arbitrary
 * org. Local auth stays the default; configuring SSO is purely additive.
 */
function ensureSsoAdmin(session: { role: Parameters<typeof can>[0] }) {
  // Either integrations or user management authority may administer federation.
  if (!can(session.role, "integrations.manage") && !can(session.role, "users.manage")) {
    throw new Error("Not allowed");
  }
}

/** Save OIDC issuer/client config onto the caller's organization. */
export async function configureSso(formData: FormData) {
  const session = await requireSession();
  ensureSsoAdmin(session);

  const issuerUrl = str(formData, "issuerUrl");
  const clientId = str(formData, "clientId");
  const clientSecret = str(formData, "clientSecret");
  if (!issuerUrl || !clientId) return;

  // If the secret field is left blank on an update, keep the existing secret
  // (already encrypted at rest). A newly-entered secret is encrypted here.
  const existing = await db.query.organizations.findFirst({
    where: eq(t.organizations.id, session.organizationId),
    columns: { ssoClientSecret: true },
  });
  const secret = clientSecret
    ? encryptSecret(clientSecret)
    : existing?.ssoClientSecret
      ? isEncrypted(existing.ssoClientSecret)
        ? existing.ssoClientSecret
        : encryptSecret(existing.ssoClientSecret) // migrate legacy plaintext on touch
      : "";

  await db
    .update(t.organizations)
    .set({
      ssoProvider: "oidc",
      ssoIssuerUrl: issuerUrl,
      ssoClientId: clientId,
      ssoClientSecret: secret,
    })
    .where(eq(t.organizations.id, session.organizationId));

  // Never log the secret — audit records only non-sensitive config.
  await audit(session.userId, "CONFIGURE", "SSO", session.organizationId, {
    provider: "oidc",
    issuerUrl,
    clientId,
  });
  revalidatePath("/settings");
}

/** Clear SSO config — the org falls back to local auth only. */
export async function disableSso() {
  const session = await requireSession();
  ensureSsoAdmin(session);

  await db
    .update(t.organizations)
    .set({ ssoProvider: null, ssoIssuerUrl: null, ssoClientId: null, ssoClientSecret: null })
    .where(eq(t.organizations.id, session.organizationId));

  await audit(session.userId, "DISABLE", "SSO", session.organizationId, { provider: "oidc" });
  revalidatePath("/settings");
}
