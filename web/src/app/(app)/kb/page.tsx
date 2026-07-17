import Link from "next/link";
import { db, t } from "@/db";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
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
  Textarea,
} from "@/components/ui";
import { timeAgo, fmtDate } from "@/lib/format";
import { snippet } from "@/lib/markdown";
import { clsx } from "@/lib/clsx";
import { createKbArticle, suggestKbArticle } from "@/lib/actions/shared";
import { getKnowledgeStore } from "@/lib/knowledge/store";

export const dynamic = "force-dynamic";

const CATEGORIES = [
  { key: "SOP", label: "SOP", emoji: "📋" },
  { key: "POLICY", label: "Policy", emoji: "📜" },
  { key: "EQUIPMENT", label: "Equipment", emoji: "🔧" },
  { key: "SAFETY", label: "Safety", emoji: "⚠️" },
  { key: "HR", label: "HR", emoji: "👥" },
  { key: "EMERGENCY", label: "Emergency", emoji: "🚨" },
] as const;

type CatKey = (typeof CATEGORIES)[number]["key"];

function catMeta(key: string) {
  return CATEGORIES.find((c) => c.key === key) ?? { key, label: key, emoji: "📄" };
}

type Article = typeof t.kbArticles.$inferSelect & { author: typeof t.users.$inferSelect };

function ArticleCard({ article }: { article: Article }) {
  const cat = catMeta(article.category);
  return (
    <Link href={`/kb/${article.slug}`} className="block">
      <Card className="h-full transition-shadow hover:shadow-md">
        <CardBody className="flex h-full flex-col gap-2">
          <div className="flex items-center gap-2">
            <Badge tone="blue">
              {cat.emoji} {cat.label}
            </Badge>
            {article.verifiedAt ? (
              <Badge tone="green">✓ Verified {fmtDate(article.verifiedAt)}</Badge>
            ) : (
              <Badge tone="slate">Unverified</Badge>
            )}
          </div>
          <h3 className="text-sm font-semibold text-slate-900">{article.title}</h3>
          <p className="text-xs leading-5 text-slate-500">{snippet(article.body)}</p>
          {article.tags.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {article.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600"
                >
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
          <div className="mt-auto pt-1 text-[11px] text-slate-400">
            {article.author.name} · updated {timeAgo(article.updatedAt)}
          </div>
        </CardBody>
      </Card>
    </Link>
  );
}

export default async function KbPage({
  searchParams,
}: {
  searchParams: { q?: string; cat?: string; suggested?: string };
}) {
  const session = await requireSession();
  const q = (searchParams.q ?? "").trim();
  const cat = CATEGORIES.some((c) => c.key === searchParams.cat) ? (searchParams.cat as CatKey) : undefined;
  const isAuthor = can(session.role, "kb.author");
  const store = await getKnowledgeStore();
  const storeHealth = await store.health();

  const conds: SQL[] = [];
  if (q) {
    const like = `%${q}%`;
    conds.push(
      or(
        ilike(t.kbArticles.title, like),
        ilike(t.kbArticles.body, like),
        sql`array_to_string(${t.kbArticles.tags}, ' ') ilike ${like}`
      )!
    );
  }
  if (cat) conds.push(eq(t.kbArticles.category, cat));

  const articles = (await db.query.kbArticles.findMany({
    where: conds.length ? and(...conds) : undefined,
    with: { author: true },
    orderBy: [desc(t.kbArticles.updatedAt)],
  })) as Article[];

  const grouped = !q; // group by category when not searching

  return (
    <div>
      <PageHeader
        title="📖 Knowledge Base"
        subtitle="SOPs, policies, equipment references, safety and emergency procedures"
      />

      {searchParams.suggested ? (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
          Thanks — your suggestion was sent to the admins for review.
        </div>
      ) : null}

      {/* Search + category chips */}
      <form method="GET" action="/kb" className="mb-3 flex gap-2">
        {cat ? <input type="hidden" name="cat" value={cat} /> : null}
        <Input name="q" defaultValue={q} placeholder="Search SOPs, policies, equipment notes…" className="max-w-md" />
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>
      <div className="mb-3">
        {storeHealth.degraded ? (
          <Badge tone="red">
            ⚠️ OrgMemory unreachable — serving local keyword search (degraded)
          </Badge>
        ) : storeHealth.semantic ? (
          <Badge tone="violet">🧠 Semantic search via OrgMemory</Badge>
        ) : (
          <Badge tone="slate">🔎 Keyword search · connect OrgMemory in Settings for semantic search</Badge>
        )}
      </div>
      <div className="mb-5 flex flex-wrap gap-2">
        <Link
          href={q ? `/kb?q=${encodeURIComponent(q)}` : "/kb"}
          className={clsx(
            "rounded-full border px-3 py-1 text-xs font-medium",
            !cat ? "border-blue-600 bg-blue-600 text-white" : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
          )}
        >
          All
        </Link>
        {CATEGORIES.map((c) => (
          <Link
            key={c.key}
            href={`/kb?cat=${c.key}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
            className={clsx(
              "rounded-full border px-3 py-1 text-xs font-medium",
              cat === c.key
                ? "border-blue-600 bg-blue-600 text-white"
                : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
            )}
          >
            {c.emoji} {c.label}
          </Link>
        ))}
      </div>

      {articles.length === 0 ? (
        <EmptyState
          title={q ? `No articles match “${q}”` : "No articles yet"}
          hint={q ? "Try different keywords or clear the category filter." : "Admins and office staff can publish articles below."}
        />
      ) : grouped ? (
        <div className="space-y-8">
          {CATEGORIES.filter((c) => (cat ? c.key === cat : true)).map((c) => {
            const inCat = articles.filter((a) => a.category === c.key);
            if (inCat.length === 0) return null;
            return (
              <section key={c.key}>
                <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
                  {c.emoji} {c.label} <span className="font-normal text-slate-400">({inCat.length})</span>
                </h2>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {inCat.map((a) => (
                    <ArticleCard key={a.id} article={a} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <div>
          <p className="mb-3 text-xs text-slate-500">
            {articles.length} result{articles.length === 1 ? "" : "s"} for “{q}”
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {articles.map((a) => (
              <ArticleCard key={a.id} article={a} />
            ))}
          </div>
        </div>
      )}

      {/* Authoring / suggestion */}
      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        {isAuthor ? (
          <Card>
            <CardHeader title="✍️ New article" subtitle="Published immediately — mark verified when reviewed" />
            <CardBody>
              <form action={createKbArticle} className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Title">
                    <Input name="title" required placeholder="SOP: Water Softener Installation" />
                  </Field>
                  <Field label="Category">
                    <Select name="category" defaultValue="SOP">
                      {CATEGORIES.map((c) => (
                        <option key={c.key} value={c.key}>
                          {c.emoji} {c.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <Field label="Tags (comma separated)">
                  <Input name="tags" placeholder="water heater, gas, install" />
                </Field>
                <Field label="Body (markdown: ## headings, **bold**, - lists)">
                  <Textarea name="body" rows={6} required placeholder="## Purpose&#10;Step-by-step procedure…" />
                </Field>
                <Button type="submit">Publish article</Button>
              </form>
            </CardBody>
          </Card>
        ) : null}
        <Card>
          <CardHeader
            title="💡 Suggest an article"
            subtitle="See something missing? Admins get notified and can draft it up."
          />
          <CardBody>
            <form action={suggestKbArticle} className="space-y-3">
              <Field label="What should we document?">
                <Input name="title" required placeholder="e.g. Descaling procedure for Rinnai tankless" />
              </Field>
              <Field label="Anything you already know (optional)">
                <Textarea name="body" rows={3} placeholder="Notes, steps, gotchas from the field…" />
              </Field>
              <Button type="submit" variant="secondary">
                Send suggestion
              </Button>
            </form>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
