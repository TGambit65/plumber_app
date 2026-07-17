import Link from "next/link";
import { headers } from "next/headers";
import { db, t, withTenant } from "@/db";
import { asc, desc, eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import type { Role } from "@/lib/auth";
import {
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  PERMISSION_GROUPS,
  PERMISSION_LABELS,
  type Permission,
} from "@/lib/permissions";
import { clsx } from "@/lib/clsx";
import { setUserRole, setPermissionOverride, clearAllOverrides, reassignAndDeactivate, countOpenWork, configureOrgMemory, disconnectOrgMemory } from "@/lib/actions/admin";
import { ReassignUser } from "@/components/admin/reassign-user";
import {
  addCommissionRule,
  approveCommissionEntry,
  connectIntegration,
  disconnectIntegration,
  inviteUser,
  payCommissionEntry,
  syncIntegration,
  toggleCommissionRule,
  toggleUserActive,
} from "@/lib/actions/office";
import {
  configureConnector,
  disconnectConnector,
  syncCrmNow,
  testConnector,
} from "@/lib/actions/connectors";
import { configureSso, disableSso } from "@/lib/actions/sso";
import { enablePack, disablePack, provisionPackTemplates } from "@/lib/actions/packs";
import { packCatalog } from "@/lib/trade-packs";
import { getConnector, listByCapability } from "@/lib/connectors/providers";
import { CAPABILITY_LABELS, type Connector } from "@/lib/connectors/types";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  THead,
  TCell,
  TRow,
  Table,
  type BadgeTone,
} from "@/components/ui";
import { money, timeAgo } from "@/lib/format";

export const dynamic = "force-dynamic";

const TABS = ["team", "packs", "integrations", "identity", "commissions", "audit", "company"] as const;
type Tab = (typeof TABS)[number];

const TAB_LABELS: Record<Tab, string> = {
  team: "👥 Team",
  packs: "🧩 Trade Packs",
  integrations: "🔌 Integrations",
  identity: "🔐 SSO / Identity",
  commissions: "💵 Commissions",
  audit: "🧾 Audit log",
  company: "🏢 Company",
};

const ROLE_TONES: Record<string, BadgeTone> = {
  ADMIN: "violet",
  OFFICE: "blue",
  SALES_PM: "cyan",
  TECH: "green",
};

/** Legacy providers with a seeded row but no typed connector yet ("Other" group). */
const LEGACY_PROVIDERS: Record<string, { emoji: string; label: string; blurb: string }> = {
  STRIPE: { emoji: "💳", label: "Stripe", blurb: "Card & ACH payment processing" },
  FERGUSON: { emoji: "🔩", label: "Ferguson", blurb: "Supplier punchout — POs & pricing" },
  GOOGLE_LSA: { emoji: "🔍", label: "Google LSA", blurb: "Local Services Ads lead intake" },
  ANGI: { emoji: "🏠", label: "Angi", blurb: "Marketplace lead intake" },
};

const INTEGRATION_TONE: Record<string, BadgeTone> = {
  CONNECTED: "green",
  ERROR: "red",
  DISCONNECTED: "slate",
};

const COMMISSION_STATUS_TONE: Record<string, BadgeTone> = {
  PENDING: "amber",
  APPROVED: "blue",
  PAID: "green",
};

function rateLabel(kind: string, rate: number): string {
  return kind === "SPIFF" ? money(Math.round(rate)) : `${rate}%`;
}

export default async function SettingsPage({ searchParams }: { searchParams: { tab?: string } }) {
  const session = await requireSession();
  if (session.role !== "ADMIN") {
    return (
      <Card>
        <CardBody>
          <EmptyState title="403 — Admin / Owner only" hint="Settings are restricted to admins." />
        </CardBody>
      </Card>
    );
  }

  const tab: Tab = (TABS as readonly string[]).includes(searchParams.tab ?? "") ? (searchParams.tab as Tab) : "team";

  return (
    <div>
      <PageHeader title="Settings" subtitle="Team, integrations, commission rules, audit trail and company info." />

      <div className="mb-5 flex flex-wrap gap-1 border-b border-slate-200">
        {TABS.map((tk) => (
          <Link
            key={tk}
            href={`/settings?tab=${tk}`}
            className={clsx(
              "rounded-t-lg border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              tab === tk
                ? "border-blue-600 text-blue-700"
                : "border-transparent text-slate-500 hover:bg-slate-50 hover:text-slate-700"
            )}
          >
            {TAB_LABELS[tk]}
          </Link>
        ))}
      </div>

      {tab === "team" ? <TeamTab currentUserId={session.userId} organizationId={session.organizationId} /> : null}
      {tab === "integrations" ? <IntegrationsTab organizationId={session.organizationId} /> : null}
      {tab === "identity" ? <IdentityTab organizationId={session.organizationId} /> : null}
      {tab === "commissions" ? <CommissionsTab organizationId={session.organizationId} /> : null}
      {tab === "audit" ? <AuditTab organizationId={session.organizationId} /> : null}
      {tab === "packs" ? <PacksTab organizationId={session.organizationId} /> : null}
      {tab === "company" ? <CompanyTab /> : null}
    </div>
  );
}

// ── Team ─────────────────────────────────────────────────────────────────────

function PermButton({
  userId,
  perm,
  mode,
  label,
  disabled,
}: {
  userId: string;
  perm: Permission;
  mode: "grant" | "revoke" | "clear";
  label: string;
  disabled?: boolean;
}) {
  return (
    <form action={setPermissionOverride}>
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="permission" value={perm} />
      <input type="hidden" name="mode" value={mode} />
      <button
        type="submit"
        disabled={disabled}
        className={clsx(
          "rounded px-1.5 py-0.5 text-[10px] font-medium",
          mode === "clear"
            ? "text-slate-500 hover:bg-slate-200"
            : mode === "grant"
              ? "text-emerald-700 hover:bg-emerald-100"
              : "text-red-700 hover:bg-red-100",
          disabled && "cursor-not-allowed opacity-40"
        )}
      >
        {label}
      </button>
    </form>
  );
}

async function TeamTab({ currentUserId, organizationId }: { currentUserId: string; organizationId: string }) {
  const [users, overrides] = await withTenant(organizationId, (tx) =>
    Promise.all([
      tx.query.users.findMany({ with: { truck: true }, orderBy: asc(t.users.name) }),
      tx.select().from(t.userPermissionOverrides),
    ])
  );
  const ovByUser = new Map<string, Map<Permission, boolean>>();
  for (const o of overrides) {
    if (!ovByUser.has(o.userId)) ovByUser.set(o.userId, new Map());
    ovByUser.get(o.userId)!.set(o.permission as Permission, o.granted);
  }
  const reassignTargets = users.filter((u) => u.active).map((u) => ({ id: u.id, name: u.name, role: u.role }));

  return (
    <div className="space-y-4">
      {users.map((u) => {
        const roleBase = new Set(ROLE_PERMISSIONS[u.role]);
        const uOv = ovByUser.get(u.id) ?? new Map<Permission, boolean>();
        const overrideCount = uOv.size;
        return (
          <Card key={u.id} className={!u.active ? "opacity-70" : undefined}>
            <CardHeader
              title={
                <span>
                  {u.name}
                  {u.id === currentUserId ? <span className="ml-1 text-xs font-normal text-slate-400">(you)</span> : null}
                  {!u.active ? <Badge tone="red" className="ml-2">Inactive</Badge> : null}
                </span>
              }
              subtitle={`${u.email}${u.phone ? " · " + u.phone : ""}${u.role === "TECH" && u.truck ? " · " + u.truck.name : ""}`}
              action={<Badge tone={ROLE_TONES[u.role]}>{ROLE_LABELS[u.role]}</Badge>}
            />
            <CardBody className="space-y-3">
              {/* Role change */}
              <div className="flex flex-wrap items-end gap-2">
                <form action={setUserRole} className="flex items-end gap-2">
                  <input type="hidden" name="userId" value={u.id} />
                  <Field label="Role">
                    <Select name="role" defaultValue={u.role} className="w-52">
                      {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Button type="submit" size="sm" variant="secondary">Update role</Button>
                </form>
                {u.id !== currentUserId && u.active ? (
                  <ReassignUser
                    user={{ id: u.id, name: u.name }}
                    targets={reassignTargets.filter((tg) => tg.id !== u.id)}
                    active={u.active}
                    getCounts={countOpenWork}
                    reassign={reassignAndDeactivate}
                  />
                ) : null}
                {u.id !== currentUserId && !u.active ? (
                  <form action={toggleUserActive}>
                    <input type="hidden" name="userId" value={u.id} />
                    <input type="hidden" name="next" value="true" />
                    <Button type="submit" size="sm" variant="success">Reactivate</Button>
                  </form>
                ) : null}
              </div>

              {/* Per-user permission overrides */}
              <details className="rounded-lg border border-slate-200">
                <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium text-slate-700">
                  Permissions
                  {overrideCount > 0 ? (
                    <Badge tone="amber" className="ml-2">{overrideCount} override{overrideCount === 1 ? "" : "s"}</Badge>
                  ) : (
                    <span className="ml-2 text-xs font-normal text-slate-400">role defaults</span>
                  )}
                </summary>
                <div className="space-y-3 border-t border-slate-100 p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-slate-500">
                      Effective = role default ± overrides. Grant adds a permission; Revoke removes one the role normally has.
                    </p>
                    {overrideCount > 0 ? (
                      <form action={clearAllOverrides}>
                        <input type="hidden" name="userId" value={u.id} />
                        <Button type="submit" size="sm" variant="ghost">Reset to role</Button>
                      </form>
                    ) : null}
                  </div>
                  {PERMISSION_GROUPS.map((grp) => (
                    <div key={grp.label}>
                      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{grp.label}</div>
                      <div className="grid gap-1.5 sm:grid-cols-2">
                        {grp.permissions.map((perm) => {
                          const ov = uOv.get(perm);
                          const inRole = roleBase.has(perm);
                          const effective = ov === undefined ? inRole : ov;
                          return (
                            <div key={perm} className="flex items-center justify-between gap-2 rounded-md bg-slate-50 px-2.5 py-1.5">
                              <span className="text-xs text-slate-700">
                                {PERMISSION_LABELS[perm]}
                                {ov !== undefined ? (
                                  <Badge tone={ov ? "green" : "red"} className="ml-1">{ov ? "granted" : "revoked"}</Badge>
                                ) : null}
                              </span>
                              <div className="flex items-center gap-1">
                                <span className={clsx("text-[10px] font-medium", effective ? "text-emerald-600" : "text-slate-400")}>
                                  {effective ? "ON" : "off"}
                                </span>
                                <PermButton userId={u.id} perm={perm} mode={inRole ? "revoke" : "grant"} label={inRole ? "Revoke" : "Grant"} disabled={ov !== undefined && ((inRole && ov === false) || (!inRole && ov === true))} />
                                {ov !== undefined ? <PermButton userId={u.id} perm={perm} mode="clear" label="Reset" /> : null}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            </CardBody>
          </Card>
        );
      })}

      <Card>
        <CardHeader title="Invite user" subtitle="Creates the account immediately with a temporary password (bcrypt-hashed)." />
        <CardBody>
          <form action={inviteUser} className="grid gap-3 md:grid-cols-5">
            <Field label="Name">
              <Input name="name" required />
            </Field>
            <Field label="Email">
              <Input type="email" name="email" required />
            </Field>
            <Field label="Role">
              <Select name="role" defaultValue="TECH">
                {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Phone">
              <Input name="phone" placeholder="555-0100" />
            </Field>
            <Field label="Temp password">
              <Input type="text" name="password" required minLength={8} placeholder="min 8 chars" />
            </Field>
            <div className="md:col-span-5">
              <Button type="submit">Invite user</Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}

// ── Integrations ─────────────────────────────────────────────────────────────

type ConnectionRow = typeof t.integrationConnections.$inferSelect;

/** One typed-connector card: status, config form (descriptor-driven), actions. */
function ConnectorCard({ connector, conn }: { connector: Connector; conn?: ConnectionRow }) {
  const d = connector.descriptor;
  const status = conn?.status ?? "DISCONNECTED";
  const cfg = (conn?.config ?? {}) as Record<string, string | undefined>;
  const isCrm = d.capabilities.includes("crm");
  const isReal = d.provider === "ODOO";

  return (
    <Card className={status === "ERROR" ? "border-red-200" : undefined}>
      <CardBody>
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-2xl" aria-hidden="true">{d.emoji}</span>
            <div>
              <div className="text-sm font-semibold text-slate-900">
                {d.label}
                {isReal ? <Badge tone="violet" className="ml-1.5">Live API</Badge> : <Badge tone="slate" className="ml-1.5">Demo stub</Badge>}
              </div>
              <div className="text-xs text-slate-500">{d.blurb}</div>
            </div>
          </div>
          <Badge tone={INTEGRATION_TONE[status]}>
            {status === "ERROR" ? "Error" : status === "CONNECTED" ? "Connected" : "Disconnected"}
          </Badge>
        </div>

        <p className="mt-2 text-xs text-slate-500">Last sync: {conn?.lastSyncAt ? timeAgo(conn.lastSyncAt) : "never"}</p>
        {status === "ERROR" && cfg.lastError ? (
          <p className="mt-1 rounded-md bg-red-50 px-2 py-1 text-xs font-medium text-red-700" title={cfg.lastError}>
            ⚠️ {cfg.lastError}
          </p>
        ) : null}

        <details className="mt-3 rounded-lg border border-slate-200" open={status === "ERROR"}>
          <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-slate-700">
            {conn ? "Configuration" : "Configure & connect"}
          </summary>
          <form action={configureConnector} className="space-y-2 border-t border-slate-100 p-3">
            <input type="hidden" name="provider" value={d.provider} />
            {d.configFields.map((f) => {
              // Secrets are encrypted at rest — never render the value. When one
              // is already set, show a "leave blank to keep" hint and drop the
              // required flag so re-saving other fields keeps the stored secret.
              const isSecret = f.kind === "password";
              const hasStoredSecret = isSecret && Boolean(cfg[f.key]);
              return (
                <Field key={f.key} label={`${f.label}${f.required ? "" : " (optional)"}`}>
                  <Input
                    name={f.key}
                    type={isSecret ? "password" : f.kind === "url" ? "url" : "text"}
                    defaultValue={isSecret ? "" : (cfg[f.key] ?? "")}
                    placeholder={hasStoredSecret ? "•••••••• (set — leave blank to keep)" : f.placeholder}
                    required={f.required && !hasStoredSecret}
                    autoComplete={isSecret ? "new-password" : undefined}
                  />
                </Field>
              );
            })}
            <Button type="submit" size="sm">{status === "CONNECTED" ? "Save & reconnect" : "Save & connect"}</Button>
          </form>
        </details>

        <div className="mt-3 flex flex-wrap gap-2">
          {conn ? (
            <form action={testConnector}>
              <input type="hidden" name="provider" value={d.provider} />
              <Button type="submit" size="sm" variant="secondary">Test</Button>
            </form>
          ) : null}
          {isCrm && status === "CONNECTED" ? (
            <form action={syncCrmNow}>
              <input type="hidden" name="provider" value={d.provider} />
              <Button type="submit" size="sm" variant="secondary">Sync now</Button>
            </form>
          ) : null}
          {status === "CONNECTED" ? (
            <form action={disconnectConnector}>
              <input type="hidden" name="provider" value={d.provider} />
              <Button type="submit" size="sm" variant="ghost">Disconnect</Button>
            </form>
          ) : null}
        </div>
      </CardBody>
    </Card>
  );
}

async function IntegrationsTab({ organizationId }: { organizationId: string }) {
  const all = await withTenant(organizationId, (tx) =>
    tx.query.integrationConnections.findMany({
      orderBy: asc(t.integrationConnections.provider),
    })
  );
  const orgMemory = all.find((c) => c.provider === "ORGMEMORY");
  const orgCfg = (orgMemory?.config ?? {}) as { gatewayUrl?: string; token?: string; namespace?: string };
  const byProvider = new Map(all.map((c) => [c.provider, c]));
  const groups = listByCapability();
  // Rows with no typed connector (and not ORGMEMORY) fall back to the old simple actions.
  const legacy = all.filter((c) => c.provider !== "ORGMEMORY" && !getConnector(c.provider));

  return (
    <div className="space-y-4">
      {/* OrgMemory — company knowledge base backend */}
      <Card className="border-violet-200">
        <CardHeader
          title="🧠 OrgMemory — Company Knowledge Base"
          subtitle="On-prem MCP-native memory substrate. When connected, the knowledge base uses semantic search and mirrors SOPs into OrgMemory."
          action={
            <Badge tone={orgMemory?.status === "CONNECTED" ? "green" : "slate"}>
              {orgMemory?.status === "CONNECTED" ? "Connected" : "Not connected"}
            </Badge>
          }
        />
        <CardBody>
          <form action={configureOrgMemory} className="grid gap-3 md:grid-cols-3">
            <Field label="Gateway URL (MCP-over-HTTP)">
              <Input name="gatewayUrl" defaultValue={orgCfg.gatewayUrl ?? ""} placeholder="https://orgmemory.internal:8080" />
            </Field>
            <Field label="Access token (JWT)">
              <Input
                name="token"
                type="password"
                defaultValue=""
                placeholder={orgCfg.token ? "•••••••• (set — leave blank to keep)" : "Bearer token"}
                autoComplete="new-password"
              />
            </Field>
            <Field label="Namespace">
              <Input name="namespace" defaultValue={orgCfg.namespace ?? "plumber_app"} placeholder="plumber_app" />
            </Field>
            <div className="flex items-center gap-2 md:col-span-3">
              <Button type="submit">Save & connect</Button>
              {orgMemory?.status === "CONNECTED" ? (
                <span className="text-xs text-emerald-600">
                  ✓ Semantic search active · SOPs mirror to OrgMemory on save
                </span>
              ) : (
                <span className="text-xs text-slate-500">
                  Falls back to built-in keyword search until a live gateway is configured.
                </span>
              )}
            </div>
          </form>
          {orgMemory?.status === "CONNECTED" ? (
            <form action={disconnectOrgMemory} className="mt-2">
              <Button type="submit" size="sm" variant="ghost">Disconnect OrgMemory</Button>
            </form>
          ) : null}
        </CardBody>
      </Card>

      <Card className="border-blue-200 bg-blue-50/50">
        <CardBody className="text-sm text-slate-700">
          ℹ️ Connectors augment your existing stack — the app reads/writes your tools and stays fully functional when
          everything below is disconnected. <span className="font-medium">Odoo CRM</span> is a live JSON-RPC
          implementation; the others are demo stubs returning sample data until real credentials land. Synced CRM
          records flow into OrgMemory (when connected) as provenance-tagged <em>staged</em> candidates — never
          auto-canon.
        </CardBody>
      </Card>

      {groups.map(({ capability, connectors }) => (
        <section key={capability}>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            {CAPABILITY_LABELS[capability]}
            {capability === "crm" ? <span className="ml-2 text-[11px] font-normal normal-case text-slate-400">Odoo CRM is the reference live connector</span> : null}
          </h3>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {connectors.map((connector) => (
              <ConnectorCard
                key={connector.descriptor.provider}
                connector={connector}
                conn={byProvider.get(connector.descriptor.provider)}
              />
            ))}
          </div>
        </section>
      ))}

      {legacy.length > 0 ? (
        <section>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Other</h3>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {legacy.map((conn) => {
              const meta = LEGACY_PROVIDERS[conn.provider] ?? { emoji: "🔌", label: conn.provider, blurb: "" };
              return (
                <Card key={conn.id}>
                  <CardBody>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-2xl" aria-hidden="true">
                          {meta.emoji}
                        </span>
                        <div>
                          <div className="text-sm font-semibold text-slate-900">{meta.label}</div>
                          <div className="text-xs text-slate-500">{meta.blurb}</div>
                        </div>
                      </div>
                      <Badge tone={INTEGRATION_TONE[conn.status]}>{conn.status === "ERROR" ? "Error" : conn.status === "CONNECTED" ? "Connected" : "Disconnected"}</Badge>
                    </div>
                    <p className="mt-2 text-xs text-slate-500">
                      Last sync: {conn.lastSyncAt ? timeAgo(conn.lastSyncAt) : "never"}
                    </p>
                    {conn.status === "ERROR" ? (
                      <p className="mt-1 text-xs text-red-600">Connection error — reconnect to resume syncing.</p>
                    ) : null}
                    <div className="mt-3 flex flex-wrap gap-2">
                      {conn.status === "CONNECTED" ? (
                        <>
                          <form action={syncIntegration}>
                            <input type="hidden" name="id" value={conn.id} />
                            <Button type="submit" size="sm" variant="secondary">
                              Sync now
                            </Button>
                          </form>
                          <form action={disconnectIntegration}>
                            <input type="hidden" name="id" value={conn.id} />
                            <Button type="submit" size="sm" variant="ghost">
                              Disconnect
                            </Button>
                          </form>
                        </>
                      ) : (
                        <form action={connectIntegration}>
                          <input type="hidden" name="id" value={conn.id} />
                          <Button type="submit" size="sm">
                            {conn.status === "ERROR" ? "Reconnect" : "Connect"}
                          </Button>
                        </form>
                      )}
                    </div>
                  </CardBody>
                </Card>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}

// ── SSO / Identity ───────────────────────────────────────────────────────────

async function IdentityTab({ organizationId }: { organizationId: string }) {
  // organizations is the tenant root (not RLS-scoped) → base client, scoped to
  // the caller's own org id.
  const org = await db.query.organizations.findFirst({
    where: eq(t.organizations.id, organizationId),
  });

  const configured = Boolean(org?.ssoProvider === "oidc" && org?.ssoIssuerUrl && org?.ssoClientId);

  // The callback URL admins register with their IdP. Derived from the request
  // origin so it's correct in any environment.
  const h = headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${proto}://${host}`;
  const callbackUrl = `${origin}/auth/sso/callback`;
  const entryUrl = org?.slug ? `${origin}/auth/sso/${org.slug}` : `${origin}/auth/sso/<slug>`;

  return (
    <div className="space-y-4">
      <Card className="border-blue-200 bg-blue-50/50">
        <CardBody className="text-sm text-slate-700">
          ℹ️ <span className="font-medium">Local email &amp; password sign-in is always the default</span> and keeps working
          whether or not SSO is configured. Configuring an OIDC provider below is purely additive — it lets members of
          <span className="font-medium"> this workspace</span> sign in through your identity provider. SSO is per-org: your
          IdP only ever resolves users inside your own organization.
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="🔐 OIDC Single Sign-On"
          subtitle="Federate this workspace to an external identity provider (Okta, Entra ID, Auth0, Keycloak, …)."
          action={<Badge tone={configured ? "green" : "slate"}>{configured ? "Configured" : "Not configured"}</Badge>}
        />
        <CardBody className="space-y-4">
          {configured ? (
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Provider</dt>
                <dd className="mt-0.5 text-slate-800">OIDC</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Issuer URL</dt>
                <dd className="mt-0.5 break-all text-slate-800">{org?.ssoIssuerUrl}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Client ID</dt>
                <dd className="mt-0.5 break-all text-slate-800">{org?.ssoClientId}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Client secret</dt>
                <dd className="mt-0.5 text-slate-800">{org?.ssoClientSecret ? "•••••••• (set)" : "— not set"}</dd>
              </div>
            </dl>
          ) : null}

          <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3 text-xs text-slate-600">
            <div className="mb-1 font-medium text-slate-700">Register these with your IdP</div>
            <div className="space-y-1">
              <div>
                Redirect / callback URL:{" "}
                <code className="break-all rounded bg-white px-1.5 py-0.5 text-[11px] text-slate-800">{callbackUrl}</code>
              </div>
              <div>
                Workspace sign-in URL:{" "}
                <code className="break-all rounded bg-white px-1.5 py-0.5 text-[11px] text-slate-800">{entryUrl}</code>
              </div>
            </div>
          </div>

          <form action={configureSso} className="grid gap-3 md:grid-cols-3">
            <div className="md:col-span-3">
              <Field label="Issuer URL">
                <Input
                  name="issuerUrl"
                  type="url"
                  required
                  defaultValue={org?.ssoIssuerUrl ?? ""}
                  placeholder="https://login.example.com"
                />
              </Field>
            </div>
            <Field label="Client ID">
              <Input name="clientId" required defaultValue={org?.ssoClientId ?? ""} placeholder="oidc-client-id" />
            </Field>
            <div className="md:col-span-2">
              <Field label={configured ? "Client secret (leave blank to keep current)" : "Client secret"}>
                <Input
                  name="clientSecret"
                  type="password"
                  autoComplete="off"
                  placeholder={org?.ssoClientSecret ? "•••••••• stored — leave blank to keep" : "client secret"}
                />
              </Field>
            </div>
            <div className="md:col-span-3">
              <Button type="submit">{configured ? "Save SSO settings" : "Enable SSO"}</Button>
            </div>
          </form>

          {configured ? (
            <form action={disableSso} className="border-t border-slate-100 pt-3">
              <Button type="submit" size="sm" variant="ghost">
                Disable SSO
              </Button>
              <span className="ml-2 text-xs text-slate-500">
                Members keep signing in with email &amp; password.
              </span>
            </form>
          ) : null}
        </CardBody>
      </Card>
    </div>
  );
}

// ── Commissions ──────────────────────────────────────────────────────────────

async function CommissionsTab({ organizationId }: { organizationId: string }) {
  const [rules, entries] = await withTenant(organizationId, (tx) =>
    Promise.all([
      tx.query.commissionRules.findMany({ orderBy: asc(t.commissionRules.name) }),
      tx.query.commissionEntries.findMany({ with: { user: true }, orderBy: desc(t.commissionEntries.createdAt) }),
    ])
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Commission rules" subtitle="Percent rules pay on revenue/margin; spiffs are flat dollar bonuses." />
        <CardBody>
          {rules.length === 0 ? (
            <EmptyState title="No rules defined" hint="Add one below." />
          ) : (
            <Table>
              <THead cols={["Rule", "Kind", "Rate", "Role", "Category", "Status", ""]} />
              <tbody>
                {rules.map((r) => (
                  <TRow key={r.id} className={!r.active ? "opacity-60" : undefined}>
                    <TCell>
                      <span className="font-medium">{r.name}</span>
                    </TCell>
                    <TCell>{r.kind === "PERCENT_REVENUE" ? "% of revenue" : r.kind === "PERCENT_MARGIN" ? "% of margin" : "Spiff"}</TCell>
                    <TCell className="tabular-nums font-medium">{rateLabel(r.kind, r.rate)}</TCell>
                    <TCell>{r.role ? <Badge tone={ROLE_TONES[r.role]}>{ROLE_LABELS[r.role]}</Badge> : "Any"}</TCell>
                    <TCell>{r.category ?? "—"}</TCell>
                    <TCell>{r.active ? <Badge tone="green">Active</Badge> : <Badge tone="slate">Inactive</Badge>}</TCell>
                    <TCell>
                      <form action={toggleCommissionRule}>
                        <input type="hidden" name="id" value={r.id} />
                        <input type="hidden" name="next" value={String(!r.active)} />
                        <Button type="submit" size="sm" variant="secondary">
                          {r.active ? "Disable" : "Enable"}
                        </Button>
                      </form>
                    </TCell>
                  </TRow>
                ))}
              </tbody>
            </Table>
          )}

          <form action={addCommissionRule} className="mt-4 grid gap-3 border-t border-slate-100 pt-4 md:grid-cols-5">
            <Field label="Rule name">
              <Input name="name" required placeholder="e.g. Tech upsell spiff" />
            </Field>
            <Field label="Kind">
              <Select name="kind" defaultValue="PERCENT_REVENUE">
                <option value="PERCENT_REVENUE">% of revenue</option>
                <option value="PERCENT_MARGIN">% of margin</option>
                <option value="SPIFF">Spiff (flat $)</option>
              </Select>
            </Field>
            <Field label="Rate (% or $ for spiff)">
              <Input type="number" name="rate" step="0.01" min="0" required placeholder="5" />
            </Field>
            <Field label="Applies to role">
              <Select name="role" defaultValue="">
                <option value="">Any role</option>
                {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Category (optional)">
              <Input name="category" placeholder="e.g. Water Heaters" />
            </Field>
            <div className="md:col-span-5">
              <Button type="submit" size="sm">
                Add rule
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Commission entries" subtitle="Approve pending entries, then mark paid with payroll." />
        <CardBody>
          {entries.length === 0 ? (
            <EmptyState title="No commission entries" hint="Entries accrue as estimates are approved and spiffs earned." />
          ) : (
            <Table>
              <THead cols={["Who", "Description", "Amount", "Period", "Status", ""]} />
              <tbody>
                {entries.map((e) => (
                  <TRow key={e.id}>
                    <TCell>
                      <span className="font-medium">{e.user.name}</span>
                    </TCell>
                    <TCell>{e.description}</TCell>
                    <TCell className="tabular-nums font-medium">{money(e.amountCents)}</TCell>
                    <TCell>{e.period}</TCell>
                    <TCell>
                      <Badge tone={COMMISSION_STATUS_TONE[e.status]}>{e.status.charAt(0) + e.status.slice(1).toLowerCase()}</Badge>
                    </TCell>
                    <TCell>
                      {e.status === "PENDING" ? (
                        <form action={approveCommissionEntry}>
                          <input type="hidden" name="id" value={e.id} />
                          <Button type="submit" size="sm" variant="success">
                            Approve
                          </Button>
                        </form>
                      ) : e.status === "APPROVED" ? (
                        <form action={payCommissionEntry}>
                          <input type="hidden" name="id" value={e.id} />
                          <Button type="submit" size="sm" variant="secondary">
                            Mark paid
                          </Button>
                        </form>
                      ) : null}
                    </TCell>
                  </TRow>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

// ── Audit log ────────────────────────────────────────────────────────────────

async function AuditTab({ organizationId }: { organizationId: string }) {
  const logs = await withTenant(organizationId, (tx) =>
    tx
      .select({ log: t.auditLogs, user: t.users })
      .from(t.auditLogs)
      .leftJoin(t.users, eq(t.auditLogs.userId, t.users.id))
      .orderBy(desc(t.auditLogs.createdAt))
      .limit(50)
  );

  return (
    <Card>
      <CardHeader title="Audit log" subtitle="Every sensitive action — who, what, when. Last 50 entries." />
      <CardBody>
        {logs.length === 0 ? (
          <EmptyState title="No audit entries yet" hint="Voids, user changes, integration changes and commission approvals land here." />
        ) : (
          <Table>
            <THead cols={["When", "Who", "Action", "Entity", "Detail"]} />
            <tbody>
              {logs.map(({ log, user }) => {
                const detail = log.detail ? JSON.stringify(log.detail) : "";
                return (
                  <TRow key={log.id}>
                    <TCell className="whitespace-nowrap text-xs text-slate-500">{timeAgo(log.createdAt)}</TCell>
                    <TCell>
                      <span className="font-medium">{user?.name ?? "System"}</span>
                    </TCell>
                    <TCell>
                      <Badge tone="slate">{log.action}</Badge>
                    </TCell>
                    <TCell>{log.entity}</TCell>
                    <TCell>
                      <code className="block max-w-md truncate rounded bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-600" title={detail}>
                        {detail.length > 90 ? `${detail.slice(0, 90)}…` : detail || "—"}
                      </code>
                    </TCell>
                  </TRow>
                );
              })}
            </tbody>
          </Table>
        )}
      </CardBody>
    </Card>
  );
}

// ── Trade Packs ──────────────────────────────────────────────────────────────

async function PacksTab({ organizationId }: { organizationId: string }) {
  const packs = await packCatalog(organizationId);
  const enabled = packs.filter((p) => p.enabled);
  const available = packs.filter((p) => !p.enabled);

  // How many of each enabled pack's templates are already provisioned?
  const provisioned = await withTenant(organizationId, (tx) =>
    tx.select({ name: t.inspectionTemplates.name }).from(t.inspectionTemplates)
  );
  const provisionedNames = new Set(provisioned.map((p) => p.name));

  const ProvidesRow = ({ label, items }: { label: string; items: string[] }) =>
    items.length ? (
      <div className="mt-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
        <div className="mt-1 flex flex-wrap gap-1">
          {items.map((i) => (
            <span key={i} className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">{i}</span>
          ))}
        </div>
      </div>
    ) : null;

  return (
    <div className="space-y-4">
      <Card className="border-blue-200 bg-blue-50/50">
        <CardBody className="text-sm text-slate-700">
          🧩 One core, many packs. A pack composes this tenant&apos;s job types, equipment kinds, inspection
          templates, and certifications — all data-driven, no per-trade forks. Enabling multiple packs is
          supported (e.g. plumbing + sewer). Enabled: <b>{enabled.map((p) => p.name).join(", ") || "none"}</b>.
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Enabled packs" subtitle={`${enabled.length} active`} />
        <CardBody className="space-y-3">
          {enabled.length === 0 ? (
            <EmptyState title="No packs enabled" hint="Enable one below to compose this tenant's capabilities." />
          ) : (
            enabled.map((p) => {
              const total = p.inspectionTemplates.length;
              const have = p.inspectionTemplates.filter((tpl) => provisionedNames.has(tpl.name)).length;
              return (
                <div key={p.id} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-slate-900">{p.name}</span>
                        <Badge tone="green">enabled</Badge>
                        <code className="text-[11px] text-slate-400">{p.key}</code>
                      </div>
                      {p.description ? <p className="mt-0.5 text-xs text-slate-500">{p.description}</p> : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {total > 0 ? (
                        <form action={provisionPackTemplates}>
                          <input type="hidden" name="packId" value={p.id} />
                          <Button size="sm" variant={have < total ? "primary" : "secondary"} type="submit">
                            {have < total ? `Provision templates (${have}/${total})` : `Templates ✓ ${have}/${total}`}
                          </Button>
                        </form>
                      ) : null}
                      <form action={disablePack}>
                        <input type="hidden" name="packId" value={p.id} />
                        <Button size="sm" variant="ghost" type="submit">Disable</Button>
                      </form>
                    </div>
                  </div>
                  <ProvidesRow label="Job types" items={p.jobTypes} />
                  <ProvidesRow label="Equipment kinds" items={p.equipmentKinds} />
                  <ProvidesRow label="Inspection templates" items={p.inspectionTemplates.map((tpl) => tpl.name)} />
                  <ProvidesRow label="Certifications" items={p.certTypes} />
                  <ProvidesRow label="Safety docs" items={p.safetyDocs} />
                </div>
              );
            })
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Available packs" subtitle={`${available.length} in the catalog`} />
        <CardBody className="grid gap-3 md:grid-cols-2">
          {available.map((p) => (
            <div key={p.id} className="rounded-lg border border-slate-200 p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-semibold text-slate-900">{p.name}</div>
                  {p.description ? <p className="mt-0.5 text-xs text-slate-500">{p.description}</p> : null}
                </div>
                <form action={enablePack}>
                  <input type="hidden" name="packId" value={p.id} />
                  <Button size="sm" type="submit">Enable</Button>
                </form>
              </div>
              <ProvidesRow label="Job types" items={p.jobTypes.slice(0, 6)} />
            </div>
          ))}
        </CardBody>
      </Card>
    </div>
  );
}

// ── Company ──────────────────────────────────────────────────────────────────

function CompanyTab() {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Company" subtitle="Read-only demo profile" />
        <CardBody>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Business name</dt>
              <dd className="mt-0.5 text-slate-800">Plumb Zebra LLC</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">License</dt>
              <dd className="mt-0.5 text-slate-800">OH Master Plumber #PL-48122</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Hours</dt>
              <dd className="mt-0.5 text-slate-800">Mon–Fri 7:00 AM – 6:00 PM · 24/7 emergency dispatch</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Service area</dt>
              <dd className="mt-0.5 text-slate-800">Riverton, Maple Falls & surrounding counties (30-mile radius)</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Phone</dt>
              <dd className="mt-0.5 text-slate-800">555-APEX-247</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Email</dt>
              <dd className="mt-0.5 text-slate-800">hello@apexplumbing.demo</dd>
            </div>
          </dl>
        </CardBody>
      </Card>
      <Card className="border-slate-200 bg-slate-50/60">
        <CardBody className="text-xs leading-relaxed text-slate-600">
          🔒 <span className="font-medium">Data retention policy:</span> customer records, job history, photos, and financial documents are
          retained for 7 years to satisfy warranty, tax, and licensing requirements. Call recordings are retained for 12 months. GPS location
          data is captured during work hours only, retained for 90 days, and every tech can view their own history. Audit logs are immutable
          and retained indefinitely.
        </CardBody>
      </Card>
    </div>
  );
}
