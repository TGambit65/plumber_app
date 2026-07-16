import Link from "next/link";
import { db, t } from "@/db";
import { asc, desc, eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import type { Role } from "@/lib/auth";
import { ROLE_LABELS } from "@/lib/permissions";
import { clsx } from "@/lib/clsx";
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

const TABS = ["team", "integrations", "commissions", "audit", "company"] as const;
type Tab = (typeof TABS)[number];

const TAB_LABELS: Record<Tab, string> = {
  team: "👥 Team",
  integrations: "🔌 Integrations",
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

const PROVIDERS: Record<string, { emoji: string; label: string; blurb: string }> = {
  QUICKBOOKS: { emoji: "📗", label: "QuickBooks", blurb: "Accounting — invoices, payments, GL sync" },
  HUBSPOT: { emoji: "🟠", label: "HubSpot", blurb: "CRM — inbound leads, outbound activity" },
  SALESFORCE: { emoji: "☁️", label: "Salesforce", blurb: "CRM — enterprise pipeline sync" },
  STRIPE: { emoji: "💳", label: "Stripe", blurb: "Card & ACH payment processing" },
  TWILIO: { emoji: "💬", label: "Twilio", blurb: "SMS — on-my-way texts & follow-ups" },
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

      {tab === "team" ? <TeamTab currentUserId={session.userId} /> : null}
      {tab === "integrations" ? <IntegrationsTab /> : null}
      {tab === "commissions" ? <CommissionsTab /> : null}
      {tab === "audit" ? <AuditTab /> : null}
      {tab === "company" ? <CompanyTab /> : null}
    </div>
  );
}

// ── Team ─────────────────────────────────────────────────────────────────────

async function TeamTab({ currentUserId }: { currentUserId: string }) {
  const users = await db.query.users.findMany({ with: { truck: true }, orderBy: asc(t.users.name) });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Team" subtitle={`${users.length} users`} />
        <CardBody>
          {users.length === 0 ? (
            <EmptyState title="No users" />
          ) : (
            <Table>
              <THead cols={["Name", "Email", "Role", "Phone", "Truck", "Status", ""]} />
              <tbody>
                {users.map((u) => (
                  <TRow key={u.id} className={!u.active ? "opacity-60" : undefined}>
                    <TCell>
                      <span className="font-medium">{u.name}</span>
                      {u.id === currentUserId ? <span className="ml-1 text-xs text-slate-400">(you)</span> : null}
                    </TCell>
                    <TCell>{u.email}</TCell>
                    <TCell>
                      <Badge tone={ROLE_TONES[u.role]}>{ROLE_LABELS[u.role]}</Badge>
                    </TCell>
                    <TCell>{u.phone ?? "—"}</TCell>
                    <TCell>{u.role === "TECH" ? u.truck?.name ?? <span className="text-slate-400">—</span> : "—"}</TCell>
                    <TCell>{u.active ? <Badge tone="green">Active</Badge> : <Badge tone="red">Inactive</Badge>}</TCell>
                    <TCell>
                      {u.id !== currentUserId ? (
                        <form action={toggleUserActive}>
                          <input type="hidden" name="userId" value={u.id} />
                          <input type="hidden" name="next" value={String(!u.active)} />
                          <Button type="submit" size="sm" variant={u.active ? "secondary" : "success"}>
                            {u.active ? "Deactivate" : "Activate"}
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

async function IntegrationsTab() {
  const connections = await db.query.integrationConnections.findMany({
    orderBy: asc(t.integrationConnections.provider),
  });

  return (
    <div className="space-y-4">
      <Card className="border-blue-200 bg-blue-50/50">
        <CardBody className="text-sm text-slate-700">
          ℹ️ Connectors are demo stubs — drop in real OAuth credentials via the integration layer (docs/06).
        </CardBody>
      </Card>

      {connections.length === 0 ? (
        <EmptyState title="No integrations configured" hint="Seed the database to see the integrations hub." />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {connections.map((conn) => {
            const meta = PROVIDERS[conn.provider] ?? { emoji: "🔌", label: conn.provider, blurb: "" };
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
      )}
    </div>
  );
}

// ── Commissions ──────────────────────────────────────────────────────────────

async function CommissionsTab() {
  const [rules, entries] = await Promise.all([
    db.query.commissionRules.findMany({ orderBy: asc(t.commissionRules.name) }),
    db.query.commissionEntries.findMany({ with: { user: true }, orderBy: desc(t.commissionEntries.createdAt) }),
  ]);

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

async function AuditTab() {
  const logs = await db
    .select({ log: t.auditLogs, user: t.users })
    .from(t.auditLogs)
    .leftJoin(t.users, eq(t.auditLogs.userId, t.users.id))
    .orderBy(desc(t.auditLogs.createdAt))
    .limit(50);

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
              <dd className="mt-0.5 text-slate-800">Apex Plumbing LLC</dd>
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
