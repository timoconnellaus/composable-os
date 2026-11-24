// The `richText` field type (stage 28, ADR 0440): a document field (ADR 0445) with one fixed
// schema the platform owns. A post's body is one; a client renders it with its own components,
// block by block, and never as HTML.
//
//   body: { type: "richText", label: "Body" }
//
// The value is `{ blocks: [...] }`. A block is one of paragraph, heading, list, quote, image,
// divider, embed, callout and button, told apart by `type`. Text sits in inline runs: a run of
// text with its marks (bold, italic, code, a link) or a line break. Every text is `noMarkup` and
// every link is checked by scheme, so no HTML, script or `javascript:` address can be stored, by
// any actor. A block type, mark or key the schema does not name is refused like any other fault.
//
// The schema is data like any declared document schema: the host, `cos ext check`, the SDK's test
// host and both renderers read this one declaration. Changing it changes what every product
// stores; a block type added here must be added to both renderers (stage 28, step 6).
import type { DocumentNode, DocumentObjectNode, DocumentSchema } from "./document.ts";

/** The block types, in the order a renderer lists them. */
export const RICH_TEXT_BLOCKS = [
  "paragraph",
  "heading",
  "list",
  "quote",
  "image",
  "divider",
  "embed",
  "callout",
  "button",
] as const;
export type RichTextBlockType = (typeof RICH_TEXT_BLOCKS)[number];

/** The marks a run of text may carry. A link is `href`. */
export const RICH_TEXT_MARKS = ["bold", "italic", "code", "href"] as const;

/** A richText field that declares no `maxBytes`. At most DOCUMENT_MAX_BYTES. */
export const RICH_TEXT_DEFAULT_BYTES = 131_072;

/** The object a picture's `media` names: the media library's (stage 28, step 4). */
export const RICH_TEXT_MEDIA_OBJECT = "media";

const prose = (max: number, extra: Partial<DocumentNode> = {}): DocumentNode =>
  ({ type: "text", max, noMarkup: true, ...extra }) as DocumentNode;
const optional = (node: DocumentNode): DocumentNode => ({ ...node, optional: true });
const inlines: DocumentNode = { type: "use", def: "inlines" };
const object = (fields: Record<string, DocumentNode>): DocumentObjectNode => ({
  type: "object",
  fields,
});

const listShape = (): DocumentObjectNode =>
  object({
    style: { type: "choice", options: ["bullet", "ordered"] },
    items: { type: "array", min: 1, max: 200, of: { type: "use", def: "listItem" } },
  });

const blocks: Record<RichTextBlockType, DocumentObjectNode> = {
  paragraph: object({ content: inlines }),
  heading: object({
    level: { type: "number", integer: true, min: 1, max: 6 },
    content: inlines,
  }),
  list: listShape(),
  quote: object({ content: inlines, attribution: optional(prose(300)) }),
  image: object({
    media: {
      type: "ref",
      to: RICH_TEXT_MEDIA_OBJECT,
      media: "image",
      description: "The picture, from media",
    },
    alt: prose(500, { description: "What the picture shows, for people who cannot see it" }),
    caption: optional(inlines),
  }),
  divider: object({}),
  embed: object({
    url: {
      type: "text",
      max: 2000,
      href: "web",
      description: "A video or post to show (YouTube, Vimeo): the client decides how",
    },
    caption: optional(prose(500)),
  }),
  callout: object({
    tone: { type: "choice", options: ["info", "note", "success", "warning"] },
    content: inlines,
  }),
  button: object({
    label: prose(80, { min: 1 }),
    href: { type: "text", max: 2000, href: "link" },
  }),
};

/** The one schema of every richText field. */
export const RICH_TEXT_SCHEMA: DocumentSchema = {
  root: object({
    blocks: {
      type: "array",
      max: 1000,
      of: {
        type: "union",
        tag: "type",
        variants: blocks,
      },
    },
  }),
  defs: {
    inlines: {
      type: "array",
      max: 500,
      of: {
        type: "union",
        tag: "type",
        variants: {
          text: object({
            text: prose(5000, { min: 1 }),
            bold: optional({ type: "boolean" }),
            italic: optional({ type: "boolean" }),
            code: optional({ type: "boolean" }),
            href: optional({ type: "text", max: 2000, href: "link" }),
          }),
          break: object({}),
        },
      },
    },
    listItem: object({ content: inlines, list: optional({ type: "use", def: "list" }) }),
    list: listShape(),
  },
};

/**
 * The `image` field type (stage 28, ADR 0444): a picture from the media library, with its alt
 * text and the point to keep in view when a client crops it (0 to 1 from the left and the top).
 */
export const IMAGE_SCHEMA: DocumentSchema = {
  root: object({
    media: {
      type: "ref",
      to: RICH_TEXT_MEDIA_OBJECT,
      media: "image",
      description: "The picture, from media",
    },
    alt: prose(500, { description: "What the picture shows, for people who cannot see it" }),
    focal: optional(
      object({
        x: { type: "number", min: 0, max: 1 },
        y: { type: "number", min: 0, max: 1 },
      }),
    ),
  }),
};

/** The most an image field's value may be, in bytes of its JSON. */
export const IMAGE_MAX_BYTES = 2048;

/**
 * A video from the media library (stage 42, ADR 0475), as a node a declared document may use: the
 * video (a ready one, checked on write) and, optionally, a picture to show before it plays.
 */
export const VIDEO_NODE: DocumentObjectNode = object({
  media: {
    type: "ref",
    to: RICH_TEXT_MEDIA_OBJECT,
    media: "video",
    description: "The video, from media (a ready one)",
  },
  poster: optional({
    type: "ref",
    to: RICH_TEXT_MEDIA_OBJECT,
    media: "image",
    description: "A picture shown before it plays",
  }),
});

/** A downloadable file from the media library (a PDF), as a node a declared document may use. */
export const FILE_NODE: DocumentNode = {
  type: "ref",
  to: RICH_TEXT_MEDIA_OBJECT,
  media: "file",
  description: "The file, from media",
};

/** The `video` field type (stage 42, ADR 0475): `{ media, poster? }`. */
export const VIDEO_SCHEMA: DocumentSchema = { root: VIDEO_NODE };

/** The most a video field's value may be, in bytes of its JSON. */
export const VIDEO_MAX_BYTES = 1024;

/**
 * The field types whose value is a document (ADR 0445): `document`, `richText`, `image` and
 * `video`.
 */
export function isDocumentType(type: string | undefined): boolean {
  return type === "document" || type === "richText" || type === "image" || type === "video";
}

/**
 * The schema a document-valued field is checked against: its declared one, or richText's. Not a
 * document type: undefined.
 */
export function documentSchemaOf(field: {
  type?: string | undefined;
  schema?: unknown;
}): DocumentSchema | undefined {
  if (field.type === "richText") return RICH_TEXT_SCHEMA;
  if (field.type === "image") return IMAGE_SCHEMA;
  if (field.type === "video") return VIDEO_SCHEMA;
  if (field.type === "document") return field.schema as DocumentSchema | undefined;
  return undefined;
}

/** The size limit of a document-valued field: its declared one, or its type's default. */
export function documentMaxBytesOf(field: {
  type?: string | undefined;
  maxBytes?: number | undefined;
}): number | undefined {
  if (field.type === "image") return IMAGE_MAX_BYTES;
  if (field.type === "video") return VIDEO_MAX_BYTES;
  if (field.maxBytes !== undefined) return field.maxBytes;
  return field.type === "richText" ? RICH_TEXT_DEFAULT_BYTES : undefined;
}

// --- Sections and anchors (stage 38, ADR 0700) ---------------------------------------------------
//
// A heading starts a section. Its anchor is made from its text and its place among the document's
// headings, never stored: the host's published-text index, `content.search`'s results and both
// renderers (a heading's `id` on the web, its `nativeID` in the app) all call `headingAnchors`, so
// a link to `#<anchor>` lands on the heading the search found. Two headings with the same words
// are told apart by their order (`-2`, `-3`); a heading with no letters or digits is `section`.

/** The longest a heading's anchor is, before a `-<n>` that tells two apart. */
export const ANCHOR_MAX = 60;

interface RichTextLike {
  blocks?: readonly unknown[] | null;
}

type Runs = readonly { type?: unknown; text?: unknown }[] | undefined;

/** The words of inline runs, without marks. A line break is a space. */
function runsText(content: Runs): string {
  return (content ?? [])
    .map((run) => (run?.type === "text" && typeof run.text === "string" ? run.text : " "))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function anchorBase(text: string): string {
  const plain = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return plain.slice(0, ANCHOR_MAX).replace(/-+$/g, "") || "section";
}

/** Each heading block's anchor, in the order the headings come in the document. */
export function headingAnchors(value: RichTextLike | null | undefined): string[] {
  const taken = new Set<string>();
  const out: string[] = [];
  for (const block of value?.blocks ?? []) {
    const b = block as { type?: unknown; content?: Runs };
    if (b?.type !== "heading") continue;
    const base = anchorBase(runsText(b.content));
    let anchor = base;
    for (let n = 2; taken.has(anchor); n += 1) anchor = `${base}-${n}`;
    taken.add(anchor);
    out.push(anchor);
  }
  return out;
}

/** One section of a document: what comes before the first heading, or a heading and its blocks. */
export interface RichTextSection {
  /** The heading's anchor; null for what comes before the first heading. */
  anchor: string | null;
  /** The heading's words; empty before the first heading. */
  heading: string;
  /** The words of the section's blocks, the heading's own left out. */
  text: string;
}

/** A block's words (a list's items, a picture's caption, a button's label). */
function blockText(block: unknown): string {
  const b = block as Record<string, unknown> & { type?: unknown };
  const list = (body: unknown): string[] =>
    ((body as { items?: unknown[] } | undefined)?.items ?? []).flatMap((item) => {
      const i = item as { content?: Runs; list?: unknown };
      return [runsText(i.content), ...(i.list ? list(i.list) : [])];
    });
  switch (b?.type) {
    case "paragraph":
    case "heading":
    case "quote":
    case "callout":
      return runsText(b.content as Runs);
    case "list":
      return list(b).filter(Boolean).join(" ");
    case "image":
      return runsText(b.caption as Runs);
    case "embed":
      return typeof b.caption === "string" ? b.caption : "";
    case "button":
      return typeof b.label === "string" ? b.label : "";
    default:
      return "";
  }
}

/**
 * A document split at its headings: the blocks before the first heading (only when they hold
 * words), then one section per heading, with the anchor `headingAnchors` gives it.
 */
export function richTextSections(value: RichTextLike | null | undefined): RichTextSection[] {
  const anchors = headingAnchors(value);
  const sections: { anchor: string | null; heading: string; parts: string[] }[] = [
    { anchor: null, heading: "", parts: [] },
  ];
  let heading = 0;
  for (const block of value?.blocks ?? []) {
    if ((block as { type?: unknown })?.type === "heading") {
      sections.push({
        anchor: anchors[heading] ?? null,
        heading: blockText(block),
        parts: [],
      });
      heading += 1;
      continue;
    }
    const text = blockText(block);
    if (text) sections.at(-1)?.parts.push(text);
  }
  return sections
    .map((s) => ({ anchor: s.anchor, heading: s.heading, text: s.parts.join("\n") }))
    .filter((s) => s.anchor !== null || s.text);
}
