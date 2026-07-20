import Link from "next/link";
import { notFound } from "next/navigation";
import { t, withTenant } from "@/db";
import { requireSession } from "@/lib/auth";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { Badge, Button, Card, CardBody, CardHeader, Field, Input, Select, Textarea } from "@/components/ui";
import { can } from "@/lib/permissions";
import { fmtDate, timeAgo } from "@/lib/format";
import { Markdown, snippet } from "@/lib/markdown";
import {
  archiveKbArticle,
  kbFeedback,
  markKbVerified,
  unarchiveKbArticle,
  unverifyKbArticle,
  updateKbArticle,
} from "@/lib/actions/shared";

export const dynamic = "force-dynamic";

const CAT_EMOJI: Record<string, string> = {
  SOP: "📋",
  POLICY: "📜",
  EQUIPMENT: "🔧",
  SAFETY: "⚠️",
  HR: "👥",
  EMERGENCY: "🚨",
};
const CAT_LABEL: Record<string, string> = {
  SOP: "SOP",
  POLICY: "Policy",
  EQUIPMENT: "Equipment",
  SAFETY: "Safety",
  HR: "HR",
  EMERGENCY: "Emergency",
};

export default async function KbArticlePage({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams: { fb?: string };
}) {
  const session = await requireSession();

  const article = await withTenant(session.organizationId, (tx) =>
    tx.query.kbArticles.findFirst({
      where: eq(t.kbArticles.slug, params.slug),
      with: { author: true },
    })
  );
  if (!article) notFound();

  const related = await withTenant(session.organizationId, (tx) =>
    tx.query.kbArticles.findMany({
      where: and(eq(t.kbArticles.category, article.category), ne(t.kbArticles.id, article.id), isNull(t.kbArticles.archivedAt)),
      orderBy: [desc(t.kbArticles.updatedAt)],
      limit: 3,
    })
  );

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 text-xs text-slate-500">
        <Link href="/kb" className="hover:text-blue-600">
          📖 Knowledge Base
        </Link>{" "}
        /{" "}
        <Link href={`/kb?cat=${article.category}`} className="hover:text-blue-600">
          {CAT_LABEL[article.category] ?? article.category}
        </Link>
      </div>

      <Card>
        <CardBody className="px-6 py-6 sm:px-8">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Badge tone="blue">
              {CAT_EMOJI[article.category] ?? "📄"} {CAT_LABEL[article.category] ?? article.category}
            </Badge>
            {article.verifiedAt ? (
              <Badge tone="green">✓ Verified {fmtDate(article.verifiedAt)}</Badge>
            ) : (
              <Badge tone="slate">Unverified</Badge>
            )}
          </div>
          <h1 className="text-2xl font-semibold leading-tight text-slate-900">{article.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span>By {article.author.name}</span>
            <span aria-hidden>·</span>
            <span>Updated {timeAgo(article.updatedAt)}</span>
          </div>
          {article.tags.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {article.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600"
                >
                  {tag}
                </span>
              ))}
            </div>
          ) : null}

          {article.archivedAt ? (
            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">
              <span>📦 Unpublished {fmtDate(article.archivedAt)} — hidden from the KB list and search.</span>
              {can(session.role, "kb.author") ? (
                <form action={unarchiveKbArticle}>
                  <input type="hidden" name="id" value={article.id} />
                  <Button type="submit" size="sm" variant="secondary">
                    ♻️ Republish
                  </Button>
                </form>
              ) : null}
            </div>
          ) : null}

          <div className="mt-4 flex flex-wrap gap-2">
            {session.role === "ADMIN" && !article.verifiedAt ? (
              <form action={markKbVerified}>
                <input type="hidden" name="id" value={article.id} />
                <input type="hidden" name="slug" value={article.slug} />
                <Button type="submit" variant="success" size="sm">
                  ✓ Mark verified today
                </Button>
              </form>
            ) : null}
            {session.role === "ADMIN" && article.verifiedAt ? (
              <form action={unverifyKbArticle}>
                <input type="hidden" name="id" value={article.id} />
                <input type="hidden" name="slug" value={article.slug} />
                <Button type="submit" variant="ghost" size="sm" title="Flags this article as needing re-review">
                  ↩ Un-verify (needs re-review)
                </Button>
              </form>
            ) : null}
            {can(session.role, "kb.author") && !article.archivedAt ? (
              <form action={archiveKbArticle}>
                <input type="hidden" name="id" value={article.id} />
                <Button type="submit" variant="ghost" size="sm" title="Unpublishes the article — reversible any time">
                  📦 Unpublish
                </Button>
              </form>
            ) : null}
          </div>

          {/* M4: edit the article — editing clears verification (stale content must be re-reviewed) */}
          {can(session.role, "kb.author") ? (
            <details className="mt-4 rounded-lg border border-slate-200">
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-blue-600">✏️ Edit article</summary>
              <form action={updateKbArticle} className="space-y-3 border-t border-slate-100 p-4">
                <input type="hidden" name="id" value={article.id} />
                <Field label="Title">
                  <Input name="title" required defaultValue={article.title} />
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Category">
                    <Select name="category" defaultValue={article.category}>
                      {Object.keys(CAT_LABEL).map((c) => (
                        <option key={c} value={c}>
                          {CAT_LABEL[c]}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Tags (comma-separated)">
                    <Input name="tags" defaultValue={article.tags.join(", ")} />
                  </Field>
                </div>
                <Field label="Body (markdown)">
                  <Textarea name="body" rows={14} required defaultValue={article.body} />
                </Field>
                <div className="flex items-center gap-3">
                  <Button type="submit" size="sm">
                    Save article
                  </Button>
                  <span className="text-[11px] text-slate-400">Saving updates “last updated” and clears verification.</span>
                </div>
              </form>
            </details>
          ) : null}

          <hr className="my-5 border-slate-100" />

          <Markdown text={article.body} />
        </CardBody>
      </Card>

      {/* Was this helpful */}
      <Card className="mt-4">
        <CardBody className="flex flex-wrap items-center justify-between gap-3">
          {searchParams.fb ? (
            <p className="text-sm font-medium text-emerald-700">Thanks for the feedback! 🙌</p>
          ) : (
            <>
              <p className="text-sm text-slate-600">Was this article helpful?</p>
              <div className="flex gap-2">
                <form action={kbFeedback}>
                  <input type="hidden" name="slug" value={article.slug} />
                  <input type="hidden" name="title" value={article.title} />
                  <input type="hidden" name="helpful" value="yes" />
                  <Button type="submit" variant="secondary" size="sm">
                    👍 Yes
                  </Button>
                </form>
                <form action={kbFeedback}>
                  <input type="hidden" name="slug" value={article.slug} />
                  <input type="hidden" name="title" value={article.title} />
                  <input type="hidden" name="helpful" value="no" />
                  <Button type="submit" variant="secondary" size="sm">
                    👎 Not really
                  </Button>
                </form>
              </div>
            </>
          )}
        </CardBody>
      </Card>

      {related.length > 0 ? (
        <Card className="mt-4">
          <CardHeader title={`Related in ${CAT_LABEL[article.category] ?? article.category}`} />
          <CardBody className="divide-y divide-slate-100 p-0">
            {related.map((r) => (
              <Link key={r.id} href={`/kb/${r.slug}`} className="block px-4 py-3 hover:bg-slate-50">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-slate-800">{r.title}</span>
                  {r.verifiedAt ? <Badge tone="green">✓</Badge> : null}
                </div>
                <p className="mt-0.5 text-xs text-slate-500">{snippet(r.body, 110)}</p>
              </Link>
            ))}
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
