/* Tiny dependency-free markdown → React renderer.
   Supports: ## / ### headings, **bold**, *italic*, `inline code`,
   "- " bullet lists, "1. " numbered lists, paragraphs and line breaks.
   Builds React elements — no dangerouslySetInnerHTML. */
import type { ReactNode } from "react";

function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (tok.startsWith("`")) {
      nodes.push(
        <code key={key} className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[13px] text-slate-800">
          {tok.slice(1, -1)}
        </code>
      );
    } else if (tok.startsWith("**")) {
      nodes.push(
        <strong key={key} className="font-semibold text-slate-900">
          {tok.slice(2, -2)}
        </strong>
      );
    } else {
      nodes.push(<em key={key}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function renderParagraph(lines: string[], key: string): ReactNode {
  return (
    <p key={key} className="my-3 text-[15px] leading-7 text-slate-700">
      {lines.map((line, i) => (
        <span key={i}>
          {i > 0 ? <br /> : null}
          {renderInline(line, `${key}-l${i}`)}
        </span>
      ))}
    </p>
  );
}

export function Markdown({ text }: { text: string }): JSX.Element {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let k = 0;

  const flushPara = () => {
    if (para.length) {
      blocks.push(renderParagraph(para, `p${k++}`));
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      const key = `list${k++}`;
      const items = list.items.map((item, i) => (
        <li key={i} className="leading-6">
          {renderInline(item, `${key}-i${i}`)}
        </li>
      ));
      blocks.push(
        list.ordered ? (
          <ol key={key} className="my-3 list-decimal space-y-1.5 pl-6 text-[15px] text-slate-700">
            {items}
          </ol>
        ) : (
          <ul key={key} className="my-3 list-disc space-y-1.5 pl-6 text-[15px] text-slate-700">
            {items}
          </ul>
        )
      );
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();

    if (!trimmed) {
      flushPara();
      flushList();
      continue;
    }

    const h3 = /^###\s+(.*)$/.exec(trimmed);
    const h2 = /^##\s+(.*)$/.exec(trimmed);
    const h1 = /^#\s+(.*)$/.exec(trimmed);
    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);

    if (h3) {
      flushPara();
      flushList();
      blocks.push(
        <h3 key={`h${k++}`} className="mb-1.5 mt-5 text-base font-semibold text-slate-900">
          {renderInline(h3[1], `h${k}`)}
        </h3>
      );
    } else if (h2) {
      flushPara();
      flushList();
      blocks.push(
        <h2 key={`h${k++}`} className="mb-2 mt-6 text-lg font-semibold text-slate-900">
          {renderInline(h2[1], `h${k}`)}
        </h2>
      );
    } else if (h1) {
      flushPara();
      flushList();
      blocks.push(
        <h2 key={`h${k++}`} className="mb-2 mt-6 text-xl font-semibold text-slate-900">
          {renderInline(h1[1], `h${k}`)}
        </h2>
      );
    } else if (bullet) {
      flushPara();
      if (list && list.ordered) flushList();
      if (!list) list = { ordered: false, items: [] };
      list.items.push(bullet[1]);
    } else if (numbered) {
      flushPara();
      if (list && !list.ordered) flushList();
      if (!list) list = { ordered: true, items: [] };
      list.items.push(numbered[1]);
    } else {
      flushList();
      para.push(trimmed);
    }
  }
  flushPara();
  flushList();

  return <div>{blocks}</div>;
}

/** Strip markdown syntax for snippets/search previews. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,3}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^[-*]\s+/gm, "")
    .replace(/^\d+[.)]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** First ~n chars of a markdown body, stripped, ellipsized. */
export function snippet(text: string, n = 150): string {
  const s = stripMarkdown(text);
  return s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + "…" : s;
}
