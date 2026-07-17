import "server-only";
import { db, t } from "@/db";
import { desc, ilike, or, eq } from "drizzle-orm";

export type KbHit = {
  id: string;
  slug: string;
  title: string;
  category: string;
  snippet: string;
  score?: number;
  source: "local" | "orgmemory";
};

export type KbDoc = {
  id: string;
  slug: string;
  title: string;
  category: string;
  body: string;
  tags: string[];
};

/**
 * A pluggable knowledge backend. The default is the local Postgres store
 * (keyword search over kb_articles). When OrgMemory is connected it becomes
 * the semantic-search + document-memory backend, with local kept in sync
 * (mirror-both-ways).
 */
export interface KnowledgeStore {
  search(query: string, opts?: { limit?: number; category?: string }): Promise<KbHit[]>;
  ingest(doc: KbDoc): Promise<void>;
  readonly name: "local" | "orgmemory";
  readonly semantic: boolean;
}

// ── Local store (always available) ───────────────────────────────────────────
export class LocalKnowledgeStore implements KnowledgeStore {
  readonly name = "local" as const;
  readonly semantic = false;

  async search(query: string, opts?: { limit?: number; category?: string }): Promise<KbHit[]> {
    const q = query.trim();
    const rows = await db.query.kbArticles.findMany({
      where: q
        ? or(ilike(t.kbArticles.title, `%${q}%`), ilike(t.kbArticles.body, `%${q}%`))
        : undefined,
      orderBy: [desc(t.kbArticles.updatedAt)],
      limit: opts?.limit ?? 50,
    });
    return rows
      .filter((r) => !opts?.category || r.category === opts.category)
      .map((r) => ({
        id: r.id,
        slug: r.slug,
        title: r.title,
        category: r.category,
        snippet: snippet(r.body, q),
        source: "local" as const,
      }));
  }

  // Local ingest is a no-op — articles already live in kb_articles.
  async ingest(): Promise<void> {}
}

// ── OrgMemory store (MCP-over-HTTP) ──────────────────────────────────────────
// OrgMemory exposes memory + grounded-document tools over an MCP-over-HTTP
// gateway with JWT auth (see the orgmemory repo project-context). We call the
// standard MCP `tools/call` shape. When the gateway is unreachable we fall back
// to local so the KB never hard-fails.
type OrgMemoryConfig = { gatewayUrl: string; token: string; namespace?: string };

export class OrgMemoryStore implements KnowledgeStore {
  readonly name = "orgmemory" as const;
  readonly semantic = true;
  private local = new LocalKnowledgeStore();

  constructor(private cfg: OrgMemoryConfig) {}

  private async callTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${this.cfg.gatewayUrl.replace(/\/$/, "")}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.cfg.token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: tool, arguments: { namespace: this.cfg.namespace ?? "plumber_app", ...args } },
      }),
      // Don't hang the KB on a slow/absent gateway.
      signal: AbortSignal.timeout(4000),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`OrgMemory ${tool} → ${res.status}`);
    const json = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (json.error) throw new Error(json.error.message);
    return json.result;
  }

  async search(query: string, opts?: { limit?: number; category?: string }): Promise<KbHit[]> {
    try {
      const result = (await this.callTool("memory.search", {
        query,
        limit: opts?.limit ?? 20,
        filter: opts?.category ? { category: opts.category } : undefined,
      })) as { hits?: Array<{ id: string; slug?: string; title: string; category?: string; text?: string; score?: number }> };

      const hits = result?.hits ?? [];
      if (hits.length === 0) return this.local.search(query, opts);
      return hits.map((h) => ({
        id: h.id,
        slug: h.slug ?? h.id,
        title: h.title,
        category: h.category ?? "SOP",
        snippet: h.text ?? "",
        score: h.score,
        source: "orgmemory" as const,
      }));
    } catch {
      // Gateway down / pre-MVP: degrade to local keyword search.
      return this.local.search(query, opts);
    }
  }

  async ingest(doc: KbDoc): Promise<void> {
    try {
      await this.callTool("document.ingest", {
        external_id: doc.slug,
        title: doc.title,
        text: doc.body,
        metadata: { category: doc.category, tags: doc.tags, source: "plumber_app" },
      });
    } catch {
      // Best-effort mirror; local write already succeeded upstream.
    }
  }
}

// ── Resolver ─────────────────────────────────────────────────────────────────
/**
 * Returns the active knowledge store based on the ORGMEMORY integration row.
 * If connected with a gateway URL + token, uses OrgMemory; otherwise local.
 */
export async function getKnowledgeStore(): Promise<KnowledgeStore> {
  const [conn] = await db
    .select()
    .from(t.integrationConnections)
    .where(eq(t.integrationConnections.provider, "ORGMEMORY"));
  const cfg = (conn?.config ?? {}) as Partial<OrgMemoryConfig>;
  if (conn?.status === "CONNECTED" && cfg.gatewayUrl && cfg.token) {
    return new OrgMemoryStore({ gatewayUrl: cfg.gatewayUrl, token: cfg.token, namespace: cfg.namespace });
  }
  return new LocalKnowledgeStore();
}

function snippet(body: string, q: string): string {
  const text = body.replace(/[#*`>\-]/g, " ").replace(/\s+/g, " ").trim();
  if (!q) return text.slice(0, 160);
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text.slice(0, 160);
  const start = Math.max(0, i - 60);
  return (start > 0 ? "…" : "") + text.slice(start, start + 160) + "…";
}
