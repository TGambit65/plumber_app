import "server-only";
import { db, t, withTenant } from "@/db";
import { desc, ilike, or, eq, and } from "drizzle-orm";

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

/** Reported by the store so the UI can surface a DEGRADED state loudly. */
export type StoreHealth = {
  backend: "local" | "orgmemory";
  semantic: boolean;
  degraded: boolean; // true = OrgMemory configured but unreachable → serving local
  message?: string;
};

/**
 * A pluggable knowledge backend. The default is the local Postgres store
 * (keyword search over kb_articles). When OrgMemory is connected it becomes
 * the semantic-search + document-memory backend.
 *
 * Constraint 2 (standalone-first): local is ALWAYS the default and works with
 * zero platform dependency. OrgMemory is an additive upgrade that degrades
 * gracefully — but per constraint 5 we must LOG LOUDLY / surface a degraded
 * status on gateway failure, never silently pretend it worked.
 *
 * Constraint 6 (human-gated memory): everything we push is a STAGED CANDIDATE
 * via store_document; we never auto-write canon and never rely on STM→LTM
 * auto-promotion.
 */
export interface KnowledgeStore {
  search(query: string, opts?: { limit?: number; category?: string }): Promise<KbHit[]>;
  /** Stage a document as a candidate in OrgMemory (human governance writes canon). */
  stageDocument(doc: KbDoc): Promise<{ staged: boolean; degraded: boolean; message?: string }>;
  health(): Promise<StoreHealth>;
  readonly name: "local" | "orgmemory";
  readonly semantic: boolean;
}

// ── Local store (always available, zero platform dependency) ─────────────────
export class LocalKnowledgeStore implements KnowledgeStore {
  readonly name = "local" as const;
  readonly semantic = false;

  // organizationId scopes the local search under RLS.
  constructor(private organizationId: string) {}

  async search(query: string, opts?: { limit?: number; category?: string }): Promise<KbHit[]> {
    const q = query.trim();
    const rows = await withTenant(this.organizationId, (tx) =>
      tx.query.kbArticles.findMany({
        where: q ? or(ilike(t.kbArticles.title, `%${q}%`), ilike(t.kbArticles.body, `%${q}%`)) : undefined,
        orderBy: [desc(t.kbArticles.updatedAt)],
        limit: opts?.limit ?? 50,
      })
    );
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

  async stageDocument(): Promise<{ staged: boolean; degraded: boolean }> {
    // Local store IS canon for standalone deployments; nothing to stage.
    return { staged: false, degraded: false };
  }

  async health(): Promise<StoreHealth> {
    return { backend: "local", semantic: false, degraded: false };
  }
}

// ── OrgMemory store (MCP-over-HTTP, real orgmemory-contracts tools) ───────────
// Constraint 5: use the REAL tool names — search_memories, store_document,
// recall_memories, store_memory (staged). NOT memory.search / document.ingest.
// Every call carries a consistent identity: org/tenant + department +
// classification. Fail-open to local is allowed, but the failure is surfaced
// (degraded=true) and logged loudly — never silently swallowed.
export type OrgMemoryConfig = {
  gatewayUrl: string;
  token: string;
  organizationId: string; // tenant identity — REQUIRED on every call
  department?: string; // e.g. "field-ops"
  classification?: string; // e.g. "internal"
};

export class OrgMemoryStore implements KnowledgeStore {
  readonly name = "orgmemory" as const;
  readonly semantic = true;
  private local: LocalKnowledgeStore;
  private lastError?: string;

  constructor(private cfg: OrgMemoryConfig) {
    this.local = new LocalKnowledgeStore(cfg.organizationId);
  }

  private identity() {
    return {
      organization_id: this.cfg.organizationId,
      department: this.cfg.department ?? "field-ops",
      classification: this.cfg.classification ?? "internal",
    };
  }

  private async callTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${this.cfg.gatewayUrl.replace(/\/$/, "")}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        // Identity travels in every call's arguments per constraint 5.
        params: { name: tool, arguments: { ...this.identity(), ...args } },
      }),
      signal: AbortSignal.timeout(4000),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`OrgMemory ${tool} → HTTP ${res.status}`);
    const json = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (json.error) throw new Error(`OrgMemory ${tool}: ${json.error.message}`);
    return json.result;
  }

  private degrade(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    this.lastError = msg;
    // Loud log — this is the "never silently pretend it worked" requirement.
    console.error(`[OrgMemory DEGRADED] gateway unreachable, serving LOCAL fallback: ${msg}`);
    return msg;
  }

  async search(query: string, opts?: { limit?: number; category?: string }): Promise<KbHit[]> {
    try {
      const result = (await this.callTool("search_memories", {
        query,
        limit: opts?.limit ?? 20,
        filter: opts?.category ? { category: opts.category } : undefined,
      })) as { memories?: Array<{ id: string; slug?: string; title: string; category?: string; text?: string; score?: number }> };

      const hits = result?.memories ?? [];
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
    } catch (err) {
      this.degrade(err);
      return this.local.search(query, opts);
    }
  }

  async stageDocument(doc: KbDoc): Promise<{ staged: boolean; degraded: boolean; message?: string }> {
    try {
      // store_document stages a candidate; a human governance reviewer promotes to canon.
      await this.callTool("store_document", {
        external_id: doc.slug,
        title: doc.title,
        text: doc.body,
        metadata: { category: doc.category, tags: doc.tags, source: "trade-ops", staged: true },
        staged: true, // never auto-promote (constraint 6)
      });
      return { staged: true, degraded: false };
    } catch (err) {
      const message = this.degrade(err);
      return { staged: false, degraded: true, message };
    }
  }

  async health(): Promise<StoreHealth> {
    try {
      await this.callTool("recall_memories", { query: "healthcheck", limit: 1 });
      return { backend: "orgmemory", semantic: true, degraded: false };
    } catch (err) {
      const message = this.degrade(err);
      return { backend: "orgmemory", semantic: true, degraded: true, message };
    }
  }
}

// ── Resolver ─────────────────────────────────────────────────────────────────
/**
 * Returns the active knowledge store based on the ORGMEMORY integration row.
 * organizationId is REQUIRED for OrgMemory (tenant identity on every call);
 * without it we stay on the local store.
 */
export async function getKnowledgeStore(organizationId: string): Promise<KnowledgeStore> {
  const [conn] = await db
    .select()
    .from(t.integrationConnections)
    .where(
      and(
        eq(t.integrationConnections.provider, "ORGMEMORY"),
        eq(t.integrationConnections.organizationId, organizationId)
      )
    );
  const cfg = (conn?.config ?? {}) as Partial<OrgMemoryConfig>;
  if (conn?.status === "CONNECTED" && cfg.gatewayUrl && cfg.token) {
    return new OrgMemoryStore({
      gatewayUrl: cfg.gatewayUrl,
      token: cfg.token,
      organizationId, // tenant identity on every OrgMemory call
      department: cfg.department,
      classification: cfg.classification,
    });
  }
  return new LocalKnowledgeStore(organizationId);
}

function snippet(body: string, q: string): string {
  const text = body.replace(/[#*`>\-]/g, " ").replace(/\s+/g, " ").trim();
  if (!q) return text.slice(0, 160);
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text.slice(0, 160);
  const start = Math.max(0, i - 60);
  return (start > 0 ? "…" : "") + text.slice(start, start + 160) + "…";
}
