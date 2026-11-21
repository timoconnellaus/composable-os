// The editor's edge (stage 28, ADR 0440): the rich text editor (Tiptap, a ProseMirror editor)
// keeps its own document; only the platform's rich text schema is ever stored. These two pure
// functions turn one into the other.
//
// `toRichText` is the only way out of the editor. It keeps what the schema names and drops the
// rest: a node or mark the schema has no block for (pasted tables, code blocks, colours) loses its
// wrapper and keeps its words, or is dropped when it has none; a link whose address the host
// would refuse loses the link; text loses anything that reads as markup (a tag, a comment, a
// character reference), so a pasted `<b>` is never stored, whatever the paste said. The host
// checks the result again on save, for every actor.
import { hasMarkup, isDocumentHref, RICH_TEXT_SCHEMA, validateDocument } from "@composable-os/sdk";

/** A ProseMirror node as Tiptap's `getJSON()` gives it. */
export interface PmNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PmNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

type Json = Record<string, unknown>;
type Inline = Json;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Text as the schema takes it: entities decoded, then anything that reads as markup removed. */
export function cleanText(text: string): string {
  const decoded = text.replace(
    /&(#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/g,
    (all, ref) => {
      const name = String(ref);
      if (name.startsWith("#x") || name.startsWith("#X")) {
        const code = Number.parseInt(name.slice(2), 16);
        return Number.isFinite(code) && code > 0 && code < 0x110000
          ? String.fromCodePoint(code)
          : "";
      }
      if (name.startsWith("#")) {
        const code = Number.parseInt(name.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000
          ? String.fromCodePoint(code)
          : "";
      }
      return ENTITIES[name] ?? all;
    },
  );
  let out = decoded
    // Control characters other than tab and newline go (the schema refuses them).
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/<[A-Za-z!/?][^>]*>?/g, "");
  // What still reads as markup (a reference nobody decodes) loses its ampersand or bracket.
  for (let i = 0; i < 5 && hasMarkup(out); i++) {
    out = out.replace(/<([A-Za-z!/?])/g, "$1").replace(/&([A-Za-z#][A-Za-z0-9]*;)/g, "$1");
  }
  return out;
}

const oneLine = (text: string) => text.replace(/[\r\n]+/g, " ");

function inlines(nodes: readonly PmNode[] | undefined): Inline[] {
  const out: Inline[] = [];
  for (const node of nodes ?? []) {
    if (node.type === "hardBreak") {
      out.push({ type: "break" });
      continue;
    }
    if (node.type !== "text" || typeof node.text !== "string") {
      // An inline node the schema has no place for keeps its words, if it has any.
      if (node.content) out.push(...inlines(node.content));
      continue;
    }
    const text = oneLine(cleanText(node.text)).slice(0, 5000);
    if (!text) continue;
    const run: Inline = { type: "text", text };
    for (const mark of node.marks ?? []) {
      if (mark.type === "bold") run.bold = true;
      else if (mark.type === "italic") run.italic = true;
      else if (mark.type === "code") run.code = true;
      else if (mark.type === "link") {
        const href = typeof mark.attrs?.href === "string" ? mark.attrs.href.trim() : "";
        if (href && href.length <= 2000 && isDocumentHref(href, "link")) run.href = href;
      }
    }
    out.push(run);
  }
  return out;
}

/** The inline runs of every paragraph inside `node`, joined with line breaks. */
function flattened(node: PmNode): Inline[] {
  const out: Inline[] = [];
  for (const child of node.content ?? []) {
    const runs =
      child.type === "paragraph" || child.type === "heading"
        ? inlines(child.content)
        : child.content
          ? flattened(child)
          : [];
    if (!runs.length) continue;
    if (out.length) out.push({ type: "break" });
    out.push(...runs);
  }
  return out;
}

const text = (value: unknown, max: number) =>
  typeof value === "string" ? oneLine(cleanText(value)).trim().slice(0, max) : "";

function listOf(node: PmNode, depth = 0): Json | null {
  const style = node.type === "orderedList" ? "ordered" : "bullet";
  const items: Json[] = [];
  for (const item of node.content ?? []) {
    if (item.type !== "listItem") continue;
    const own = (item.content ?? []).filter(
      (c) => c.type !== "bulletList" && c.type !== "orderedList",
    );
    const nested = (item.content ?? []).find(
      (c) => c.type === "bulletList" || c.type === "orderedList",
    );
    const entry: Json = { content: flattened({ type: "item", content: own }) };
    const sub = nested && depth < 4 ? listOf(nested, depth + 1) : null;
    if (sub) entry.list = sub;
    items.push(entry);
  }
  return items.length ? { style, items: items.slice(0, 200) } : null;
}

const TONES = new Set(["info", "note", "success", "warning"]);

function block(node: PmNode): Json[] {
  const a = node.attrs ?? {};
  switch (node.type) {
    case "paragraph":
      return [{ type: "paragraph", content: inlines(node.content) }];
    case "heading": {
      const level = Number(a.level);
      return [
        {
          type: "heading",
          level: Number.isInteger(level) && level >= 1 && level <= 6 ? level : 2,
          content: inlines(node.content),
        },
      ];
    }
    case "bulletList":
    case "orderedList": {
      const list = listOf(node);
      return list ? [{ type: "list", ...list }] : [];
    }
    case "blockquote": {
      const quote: Json = { type: "quote", content: flattened(node) };
      const attribution = text(a.attribution, 300);
      if (attribution) quote.attribution = attribution;
      return [quote];
    }
    case "horizontalRule":
      return [{ type: "divider" }];
    case "richImage": {
      if (typeof a.media !== "string" || !a.media) return [];
      const image: Json = { type: "image", media: a.media, alt: text(a.alt, 500) };
      const caption = text(a.caption, 500);
      if (caption) image.caption = [{ type: "text", text: caption }];
      return [image];
    }
    case "embed": {
      const url = typeof a.url === "string" ? a.url.trim() : "";
      if (!url || url.length > 2000 || !isDocumentHref(url, "web")) return [];
      const embed: Json = { type: "embed", url };
      const caption = text(a.caption, 500);
      if (caption) embed.caption = caption;
      return [embed];
    }
    case "callout":
      return [
        {
          type: "callout",
          tone: TONES.has(String(a.tone)) ? String(a.tone) : "note",
          content: inlines(node.content),
        },
      ];
    case "ctaButton": {
      const label = text(a.label, 80);
      const href = typeof a.href === "string" ? a.href.trim() : "";
      if (!label || !href || href.length > 2000 || !isDocumentHref(href, "link")) return [];
      return [{ type: "button", label, href }];
    }
    default:
      // A block the schema has no type for (a pasted table, a code block): its words, as
      // paragraphs; nothing when it has none.
      return (node.content ?? []).flatMap((child) =>
        child.type === "text" || child.type === "hardBreak"
          ? [{ type: "paragraph", content: inlines([child]) }]
          : block(child),
      );
  }
}

/** The editor's document as the platform's rich text: what is saved. */
export function toRichText(doc: PmNode): { blocks: Json[] } {
  const blocks = (doc.content ?? []).flatMap(block);
  // An editor's empty last paragraph is not content.
  while (blocks.length) {
    const last = blocks[blocks.length - 1] as Json;
    if (last.type === "paragraph" && !(last.content as unknown[]).length) blocks.pop();
    else break;
  }
  return { blocks: blocks.slice(0, 1000) };
}

/** Whether `value` is what the host will store, and if not, the first reason. */
export function richTextProblem(value: unknown): string | null {
  const result = validateDocument(RICH_TEXT_SCHEMA, value, { maxBytes: 524_288 });
  if (result.ok) return null;
  const first = result.issues[0];
  return first ? `${first.path.join(".") || "document"}: ${first.message}` : "Not rich text";
}

// --- Into the editor ---------------------------------------------------------------------------

function pmInlines(content: unknown): PmNode[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((run: Json): PmNode[] => {
    if (run.type === "break") return [{ type: "hardBreak" }];
    if (run.type !== "text" || typeof run.text !== "string" || !run.text) return [];
    const marks: NonNullable<PmNode["marks"]> = [];
    if (run.bold) marks.push({ type: "bold" });
    if (run.italic) marks.push({ type: "italic" });
    if (run.code) marks.push({ type: "code" });
    if (typeof run.href === "string") marks.push({ type: "link", attrs: { href: run.href } });
    return [{ type: "text", text: run.text, ...(marks.length ? { marks } : {}) }];
  });
}

const paragraph = (content: unknown): PmNode => {
  const runs = pmInlines(content);
  return { type: "paragraph", ...(runs.length ? { content: runs } : {}) };
};

function pmList(list: Json): PmNode {
  const items = Array.isArray(list.items) ? (list.items as Json[]) : [];
  return {
    type: list.style === "ordered" ? "orderedList" : "bulletList",
    content: items.map((item) => ({
      type: "listItem",
      content: [
        paragraph(item.content),
        ...(item.list && typeof item.list === "object" ? [pmList(item.list as Json)] : []),
      ],
    })),
  };
}

function pmBlock(b: Json): PmNode[] {
  switch (b.type) {
    case "paragraph":
      return [paragraph(b.content)];
    case "heading": {
      const runs = pmInlines(b.content);
      return [
        { type: "heading", attrs: { level: b.level }, ...(runs.length ? { content: runs } : {}) },
      ];
    }
    case "list":
      return [pmList(b)];
    case "quote":
      return [
        {
          type: "blockquote",
          attrs: { attribution: b.attribution ?? null },
          content: [paragraph(b.content)],
        },
      ];
    case "image":
      return [
        {
          type: "richImage",
          attrs: {
            media: b.media,
            alt: b.alt ?? "",
            caption: Array.isArray(b.caption)
              ? (b.caption as Json[]).map((r) => (r.type === "text" ? r.text : " ")).join("")
              : "",
          },
        },
      ];
    case "divider":
      return [{ type: "horizontalRule" }];
    case "embed":
      return [{ type: "embed", attrs: { url: b.url, caption: b.caption ?? "" } }];
    case "callout": {
      const runs = pmInlines(b.content);
      return [
        { type: "callout", attrs: { tone: b.tone }, ...(runs.length ? { content: runs } : {}) },
      ];
    }
    case "button":
      return [{ type: "ctaButton", attrs: { label: b.label, href: b.href } }];
    default:
      return [];
  }
}

/** A stored rich text value as the editor's document. */
export function fromRichText(value: unknown): PmNode {
  const blocks =
    value && typeof value === "object" && Array.isArray((value as Json).blocks)
      ? ((value as Json).blocks as Json[])
      : [];
  const content = blocks.flatMap(pmBlock);
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

/** A stored rich text value's words, for a list cell or a card: no markup, no structure. */
export function richTextSummary(value: unknown): string {
  const words: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!node || typeof node !== "object") return;
    const n = node as Json;
    if (n.type === "text" && typeof n.text === "string") words.push(n.text);
    else if (n.type === "break") words.push(" ");
    else if (n.type === "button" && typeof n.label === "string") words.push(` ${n.label} `);
    for (const key of ["blocks", "content", "items", "list", "caption"]) {
      if (key in n) {
        walk(n[key]);
        if (key === "content" || key === "caption") words.push(" ");
      }
    }
  };
  walk(value);
  return words.join("").replace(/\s+/g, " ").trim().slice(0, 300);
}
