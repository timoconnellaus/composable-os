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
    media: { type: "ref", to: RICH_TEXT_MEDIA_OBJECT, description: "The picture, from media" },
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

/** The field types whose value is a document (ADR 0445): `document`, and `richText`. */
export function isDocumentType(type: string | undefined): boolean {
  return type === "document" || type === "richText";
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
  if (field.type === "document") return field.schema as DocumentSchema | undefined;
  return undefined;
}

/** The size limit of a document-valued field: its declared one, or its type's default. */
export function documentMaxBytesOf(field: {
  type?: string | undefined;
  maxBytes?: number | undefined;
}): number | undefined {
  if (field.maxBytes !== undefined) return field.maxBytes;
  return field.type === "richText" ? RICH_TEXT_DEFAULT_BYTES : undefined;
}
