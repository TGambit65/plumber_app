import { redirect } from "next/navigation";
import { getSession, createSession, verifyCredentials } from "@/lib/auth";
import { ROLE_HOME } from "@/lib/permissions";
import type { Role } from "@/lib/auth";

export const metadata = { title: "Sign in" };

const DEMO_ACCOUNTS: { email: string; role: Role; org: string }[] = [
  { email: "owner@apexplumbing.demo", role: "ADMIN", org: "Apex Plumbing" },
  { email: "sales@apexplumbing.demo", role: "SALES_PM", org: "Apex Plumbing" },
  { email: "tech@apexplumbing.demo", role: "TECH", org: "Apex Plumbing" },
  { email: "owner@summithvac.demo", role: "ADMIN", org: "Summit HVAC" },
  { email: "tech@summithvac.demo", role: "TECH", org: "Summit HVAC" },
];

async function login(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const user = await verifyCredentials(email, password);
  if (!user) redirect("/login?error=1");
  await createSession({ id: user.id, name: user.name, email: user.email, role: user.role, organizationId: user.organizationId });
  redirect(ROLE_HOME[user.role]);
}

// Federated login: send the browser to the per-org OIDC entry point, which
// redirects to that org's IdP. Local email/password above stays the default.
async function ssoRedirect(formData: FormData) {
  "use server";
  const slug = String(formData.get("slug") ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]/g, "");
  if (!slug) redirect("/login?error=sso");
  redirect(`/auth/sso/${slug}`);
}

export default async function LoginPage({ searchParams }: { searchParams: { error?: string } }) {
  const session = await getSession();
  if (session) redirect(ROLE_HOME[session.role]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-brand-navy via-brand-900 to-slate-900 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/10 text-3xl">🔧</div>
          <h1 className="text-2xl font-bold text-white">Apex Plumbing</h1>
          <p className="mt-1 text-sm text-blue-200">Sales-first. Field-tough. One platform.</p>
        </div>

        <div className="rounded-2xl bg-white p-6 shadow-xl">
          {searchParams.error === "sso" ? (
            <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              SSO sign-in unavailable for that workspace. Use email &amp; password below.
            </p>
          ) : searchParams.error ? (
            <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              Invalid email or password.
            </p>
          ) : null}
          <form action={login} className="space-y-4">
            <div>
              <label htmlFor="email" className="mb-1 block text-xs font-medium text-slate-600">
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
                className="h-11 w-full rounded-lg border border-slate-300 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="you@company.com"
              />
            </div>
            <div>
              <label htmlFor="password" className="mb-1 block text-xs font-medium text-slate-600">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                autoComplete="current-password"
                className="h-11 w-full rounded-lg border border-slate-300 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="••••••••"
              />
            </div>
            <button
              type="submit"
              className="h-11 w-full rounded-lg bg-blue-600 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
            >
              Sign in
            </button>
          </form>

          {/* Optional SSO path — local auth above stays the default. */}
          <div className="mt-5 border-t border-slate-100 pt-4">
            <p className="mb-2 text-center text-[11px] font-medium uppercase tracking-wide text-slate-400">
              Or sign in with your company workspace
            </p>
            <form action={ssoRedirect} className="flex gap-2">
              <input
                name="slug"
                type="text"
                autoComplete="organization"
                className="h-10 flex-1 rounded-lg border border-slate-300 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="workspace slug (e.g. apex-plumbing)"
              />
              <button
                type="submit"
                className="h-10 shrink-0 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
              >
                Sign in with SSO
              </button>
            </form>
          </div>

          <div className="mt-6 border-t border-slate-100 pt-4">
            <p className="mb-2 text-center text-xs font-medium uppercase tracking-wide text-slate-400">
              Demo accounts · password <code className="rounded bg-slate-100 px-1">demo1234</code>
            </p>
            <ul className="space-y-1 text-xs text-slate-600">
              {DEMO_ACCOUNTS.map((a) => (
                <li key={a.email} className="flex items-center justify-between gap-2 rounded-md bg-slate-50 px-2.5 py-1.5">
                  <code className="truncate">{a.email}</code>
                  <span className="shrink-0 text-slate-400">{a.org}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </main>
  );
}
