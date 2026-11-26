// Public reads of content (stage 28, ADRs 0442 and 0443): what the public reads of a publishable
// object, by its address, and a preview of a working copy for whoever holds a link to it.
//
//   content.get          anyone   one published record by slug, or where an old slug now points
//   content.list         anyone   a page of the published records (an object with no slug: only
//                                 this, ADR 0810)
//   content.search       anyone   published records whose words match, best first (ADR 0700);
//                                 staff also on an object that declares `staffRead` (ADR 0701)
//   content.staffGet     staff    one published record of a `staffRead` object, by id or slug
//   content.staffList    staff    a page of them (ADR 0701)
//   content.preview      anyone   one record's working copy, with a preview link's token
//   content.previewLink  staff    make that link: one record, until it expires
//
// The three public reads read as the public whoever calls them, staff included: what they answer
// is what the public is given, never a working copy (a preview aside). The staff reads (and a
// staff search of a `staffRead` object) read the published version too, never the working copy,
// with its content fields and slug: every staff account, pack roles included (pack-roles.ts), so a
// cleaner reads a procedure as it was published and no draft reaches anyone but its editors. Rows and fields are the
// seam's decision (visibility/public.ts): only records with a current version, only the fields the
// object's `public.read` lists, with the version's values. A draft, an unpublished record, a
// deleted one, an unknown slug and an object that is not public content give one answer, the
// same not-found, word for word.
//
// They are `hostInternal` because they read three bookkeeping tables beside the records (old
// slugs, preview links and the cache's generation); every record they return is read through
// the public's seam.
import { SLUG_MAX, SLUG_RE } from "@composable-os/sdk";
import { CompiledQuery, sql } from "kysely";
import { z } from "zod";
import { cachedContent, sha256Hex } from "../content/cache.ts";
import { reindexStep, searchedFields } from "../content/published-text.ts";
import { OperationError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import type { ObjectDefinition, PublishableDefinition } from "../fields/types.ts";
import { filterSchema } from "../filter.ts";
import { LIST_MAX_LIMIT, sortSchema } from "../list.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { loadStaffRights, staffRightsReach } from "../pack-roles.ts";
import type { PublicPrincipal } from "../principals.ts";
import { jsonList } from "../records/common.ts";
import { type Reader, visibleSource } from "../visibility/index.ts";
import { getVisible, listVisible, previewVisible } from "../visibility/records.ts";
import {
  getPublished,
  listPublished,
  type StaffReadObject,
  staffReadObject,
  staffReadSource,
} from "../visibility/staff-read.ts";
import { mediaServe } from "./media.ts";
import { loadRecord } from "./record.ts";
import {
  ftsQuery,
  highlight,
  SNIPPET_CLOSE,
  SNIPPET_OPEN,
  searchTerms,
  snippetSegments,
} from "./search.ts";

const objectName = z
  .string()
  .min(1)
  .max(80)
  .describe("A publishable object the public reads, e.g. `content.post`");
const slug = z.string().min(1).max(200).describe("The record's address, e.g. `summer-launch`");

const PUBLIC: PublicPrincipal = { kind: "public" };

/** The public's reader: what every public content read reads with, whoever calls. */
const publicReader = (ctx: HandlerContext): Reader => ({ db: ctx.db, principal: PUBLIC });

type ListedObject = ObjectDefinition & { publishable: PublishableDefinition };
type ContentObject = ListedObject & {
  publishable: PublishableDefinition & { slug: string };
};

/** A publishable object the public reads, listed or by address; anything else: null. */
function listedObject(name: string): ListedObject | null {
  const object = getObject(name);
  if (!object?.publishable || !object.public) return null;
  return object as ListedObject;
}

/**
 * A publishable object the public reads by its address; anything else: null. One without a slug
 * (a review, ADR 0810) is listed only: read by address it is not found, as anything else is.
 */
function contentObject(name: string): ContentObject | null {
  const object = listedObject(name);
  if (!object?.publishable.slug) return null;
  return object as ContentObject;
}

/**
 * The one answer for what the public cannot read (criterion 4): the same code, words and details
 * for a draft, an unpublished or deleted record, an unknown slug, an expired or foreign preview
 * link, and an object that is not public content. Only the object the caller named comes back.
 */
export function contentNotFound(object: string): OperationError {
  return new OperationError("not_found", "Not found", { object });
}

const recordOut = z.object({
  object: z.string(),
  id: z.string(),
  /** The fields the object lets the public read, by field name. */
  values: z.record(z.string(), z.unknown()),
});

const getOutput = z.discriminatedUnion("kind", [
  recordOut.extend({ kind: z.literal("record") }),
  z.object({
    kind: z.literal("redirect"),
    object: z.string(),
    slug: z.string().describe("Where the record is now: read it by this slug"),
  }),
]);

/** The published record with `value` as its slug, through the public's seam. */
async function bySlug(reader: Reader, object: ContentObject, value: string) {
  const page = await listVisible(reader, object, {
    filter: { field: object.publishable.slug, op: "eq", value },
    limit: 1,
  });
  return page.items[0] ?? null;
}

export const contentGet = defineOperation({
  name: "content.get",
  description:
    "Read one published record of a content object (a blog post) by its slug, as the public " +
    "reads it: its published version, with only the fields the object lets the public read. " +
    "An old slug of a record whose slug changed answers `redirect` with the slug it has now. A " +
    "draft, an unpublished record and an unknown slug are all not found. Read-only.",
  input: z.object({ object: objectName, slug }),
  output: getOutput,
  permission: "records:read",
  risk: "read",
  audiences: ["staff", "customer", "public"],
  hostInternal: true,
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const object = contentObject(input.object);
    if (!object || input.slug.length > SLUG_MAX || !SLUG_RE.test(input.slug)) {
      throw contentNotFound(input.object);
    }
    const reader = publicReader(ctx);
    return cachedContent(ctx.db, object.name, ["get", input.slug], async () => {
      const found = await bySlug(reader, object, input.slug);
      if (found) return { kind: "record" as const, ...found };
      // An old address: the record it points to, if the public reads it now (ADR 0442).
      const redirect = await ctx.db
        .selectFrom("core_slug_redirect")
        .select("record_id")
        .where("object_type", "=", object.name)
        .where("slug", "=", input.slug)
        .executeTakeFirst();
      if (redirect) {
        const target = await getVisible(reader, object, redirect.record_id).catch(() => null);
        const now = target?.values[object.publishable.slug];
        if (typeof now === "string" && now && now !== input.slug) {
          return { kind: "redirect" as const, object: object.name, slug: now };
        }
      }
      throw contentNotFound(input.object);
    });
  },
});

export const contentList = defineOperation({
  name: "content.list",
  description:
    "A page of the published records of a content object (blog posts), as the public reads " +
    "them: published versions only, with only the fields the object lets the public read. " +
    "Newest first by default (the object's date, else when each was published). Filter and sort " +
    "on those fields; pass nextCursor back as cursor. Read-only.",
  input: z.object({
    object: objectName,
    filter: filterSchema.optional(),
    sort: sortSchema.optional(),
    cursor: z.string().max(1000).optional(),
    limit: z.number().int().min(1).max(LIST_MAX_LIMIT).default(20),
  }),
  output: z.object({ items: z.array(recordOut), nextCursor: z.string().nullable() }),
  permission: "records:read",
  risk: "read",
  audiences: ["staff", "customer", "public"],
  hostInternal: true,
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const object = listedObject(input.object);
    if (!object) throw contentNotFound(input.object);
    const readable = new Set(object.public?.read ?? []);
    const newest = [object.publishable.date, "publishedAt"].find(
      (f): f is string => f !== undefined && readable.has(f),
    );
    const sort = input.sort ?? (newest ? { field: newest, direction: "desc" as const } : undefined);
    const { object: _object, ...page } = input;
    return cachedContent(ctx.db, object.name, ["list", { ...page, sort }], async () => {
      const result = await listVisible(publicReader(ctx), object, {
        ...page,
        ...(sort ? { sort } : {}),
      });
      return { items: result.items, nextCursor: result.nextCursor };
    });
  },
});

/** The most sections one search reads from the index before it keeps one per record. */
export const SEARCH_SCAN = 200;
/** The shortest word content.search looks for: shorter ones are left out of the query. */
export const SEARCH_MIN_TERM = 2;
/** The most results one page of content.search gives. */
export const SEARCH_MAX_LIMIT = 50;
/** A snippet's length in words around the match (FTS5 `snippet`), and a plain one's in characters. */
const SNIPPET_WORDS = 14;
const PLAIN_SNIPPET_CHARS = 160;

const segment = z.object({ text: z.string(), match: z.boolean() });

const searchHit = z.object({
  object: z.string(),
  id: z.string(),
  slug: z.string().describe("Read the record with content.get by this slug"),
  title: z.string().nullable().describe("The record's title, when the public reads it"),
  titleHighlight: z.array(segment).describe("The title in parts, matching words marked"),
  version: z.number().int().describe("The published version the words are from"),
  section: z
    .object({
      field: z.string().describe("The content field the match is in"),
      anchor: z
        .string()
        .nullable()
        .describe("The heading's anchor: link to `#<anchor>`. Null: the top of the record"),
      heading: z.string().describe("The heading's words; empty before the first heading"),
      headingHighlight: z.array(segment),
    })
    .describe("Where in the record the best match is"),
  snippet: z
    .array(segment)
    .nullable()
    .describe("A short excerpt of the matching words, as plain and matching parts (no HTML)"),
});

interface IndexMatch {
  record_id: string;
  version: number;
  field: string;
  anchor: string | null;
  heading: string;
  body: string;
  snip: string | null;
}

const cursorSchema = z
  .string()
  .regex(/^\d{1,3}$/)
  .describe("nextCursor from the previous page");

export const contentSearch = defineOperation({
  name: "content.search",
  description:
    "Search the published records of a content object (help pages, blog posts) by the words " +
    "the public reads in them: their published versions only, never a draft or a working copy. " +
    "Staff searching an object they read as published (procedures) search all its published " +
    "words. " +
    "Every word of two letters or more must match the start of a word, so partial input works. " +
    "Best matches first, " +
    "one result per record, each with its slug, title, the section the best match is in (its " +
    "heading and anchor, to link to) and a highlighted snippet as plain and matching parts. " +
    "Pass nextCursor back as cursor. Read-only.",
  input: z.object({
    object: objectName,
    q: z.string().max(200).describe("What the reader typed"),
    cursor: cursorSchema.optional(),
    limit: z.number().int().min(1).max(SEARCH_MAX_LIMIT).default(10),
  }),
  output: z.object({ items: z.array(searchHit), nextCursor: z.string().nullable() }),
  permission: "records:read",
  risk: "read",
  audiences: ["staff", "customer", "public"],
  hostInternal: true,
  mcp: { idempotent: true },
  async handler(input, ctx) {
    // Staff searching an object they read the published version of (ADR 0701) search all its
    // published words; anyone else, and staff on any other object, what the public reads.
    const staffRead = staffSearch(ctx, input.object);
    const object = staffRead ?? contentObject(input.object);
    const fields = object ? searchedFields(object, staffRead ? "staff" : "public") : null;
    if (!object?.publishable.slug || !fields) throw contentNotFound(input.object);
    // Words of at least two characters: a one-letter prefix matches nearly everything. Sorted,
    // so the same words in another order are one cached answer.
    const terms = searchTerms(input.q)
      .filter((t) => t.length >= SEARCH_MIN_TERM)
      .sort();
    if (!terms.length) return { items: [], nextCursor: null };
    const offset = Number(input.cursor ?? 0);
    // A staff search is not cached: the generation follows what the public reads only.
    const cached = staffRead
      ? <T>(_db: unknown, _object: string, _key: unknown, read: () => Promise<T>) => read()
      : cachedContent;
    return cached(ctx.db, object.name, ["search", terms, offset, input.limit], async () => {
      const reader = staffRead ? staffReader(ctx) : publicReader(ctx);
      const matches = await sql<IndexMatch>`
          SELECT t.record_id, t.version, t.field, t.anchor, t.heading, t.body,
            snippet(core_published_text_fts, 1, ${SNIPPET_OPEN}, ${SNIPPET_CLOSE}, '…', ${SNIPPET_WORDS}) AS snip
          FROM core_published_text_fts
          JOIN core_published_text t ON t.id = core_published_text_fts.rowid
          WHERE core_published_text_fts MATCH ${ftsQuery(terms)} AND t.object_type = ${object.name}
            AND t.field IN ${jsonList(fields)}
          ORDER BY bm25(core_published_text_fts, 5.0, 1.0), t.id
          LIMIT ${SEARCH_SCAN}
        `.execute(ctx.db);
      // The best section of each record, in the order of the best.
      const best = new Map<string, IndexMatch>();
      for (const m of matches.rows) if (!best.has(m.record_id)) best.set(m.record_id, m);
      if (!best.size) return { items: [], nextCursor: null };
      // Only what the reader reads now: the seam's source (published, live, and for the public
      // `when`).
      const readable = new Set(
        staffRead ? staffRead.publishable.content : (object.public?.read ?? []),
      );
      const column = (name: string) => object.fields.find((f) => f.name === name)?.column;
      const slugColumn = column(object.publishable.slug as string);
      const titleColumn =
        object.titleField && readable.has(object.titleField) ? column(object.titleField) : null;
      if (!slugColumn) throw contentNotFound(input.object);
      const source = staffRead ? staffReadSource(reader, staffRead) : visibleSource(reader, object);
      const visible = await sql<{ id: string; slug: string | null; title: string | null }>`
          SELECT id, ${sql.ref(slugColumn)} AS slug,
            ${titleColumn ? sql.ref(titleColumn) : sql`NULL`} AS title
          FROM ${source}
          WHERE id IN ${jsonList([...best.keys()])}
        `.execute(ctx.db);
      const shown = new Map(visible.rows.map((r) => [r.id, r]));
      const hits = [...best.values()].filter((m) => shown.get(m.record_id)?.slug);
      const page = hits.slice(offset, offset + input.limit);
      return {
        items: page.map((m) => {
          const record = shown.get(m.record_id);
          const title = record?.title ?? null;
          const plain = m.body.trim()
            ? [
                {
                  text:
                    m.body.length > PLAIN_SNIPPET_CHARS
                      ? `${m.body.slice(0, PLAIN_SNIPPET_CHARS).trimEnd()}…`
                      : m.body,
                  match: false,
                },
              ]
            : null;
          return {
            object: object.name,
            id: m.record_id,
            slug: String(record?.slug),
            title,
            titleHighlight: title ? highlight(title, terms) : [],
            version: Number(m.version),
            section: {
              field: m.field,
              anchor: m.anchor,
              heading: m.anchor ? m.heading : "",
              headingHighlight: m.anchor ? highlight(m.heading, terms) : [],
            },
            snippet: snippetSegments(m.snip) ?? plain,
          };
        }),
        nextCursor:
          offset + input.limit < hits.length && offset + input.limit < 1000
            ? String(offset + input.limit)
            : null,
      };
    });
  },
});

/** Whoever the call is for: a tool run's host writes carry it in `onBehalfOf`. */
const callerOf = (ctx: HandlerContext) => ctx.onBehalfOf ?? ctx.principal;

/** A staff caller's reader: the staff read source checks it is staff. */
const staffReader = (ctx: HandlerContext): Reader => ({ db: ctx.db, principal: callerOf(ctx) });

/** The staff-read object a staff caller searches (ADR 0701); null for anyone else or any other. */
function staffSearch(ctx: HandlerContext, name: string): StaffReadObject | null {
  return callerOf(ctx).kind === "staff" ? staffReadObject(name) : null;
}

/**
 * The one answer for what a staff reader cannot read: the same for a draft, an unpublished or
 * deleted record, an unknown id or slug, and an object that does not declare staff read.
 */
function staffNotFound(object: string): OperationError {
  return new OperationError("not_found", "Not found: nothing published here", { object });
}

const staffObjectName = z
  .string()
  .min(1)
  .max(80)
  .describe("A publishable object staff read the published version of, e.g. `knowledge.procedure`");

const publishedOut = recordOut.extend({
  /** The content fields and the slug of the current published version, by field name. */
  values: z.record(z.string(), z.unknown()),
  version: z.number().int().describe("The published version these values are"),
  publishedAt: z.string().describe("When that version was published"),
  names: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "For an object that declares staffNames: the title of each related record those fields " +
        "name, by field (a procedure's section's name)",
    ),
});

export const contentStaffGet = defineOperation({
  name: "content.staffGet",
  description:
    "Read one published record (a procedure) of an object staff read as published, by id or by " +
    "slug: its current published version, never the working copy being edited, with its content " +
    "fields, its slug, the version number and when it was published. A draft, an unpublished " +
    "record and an unknown id or slug are all not found. Every staff account may read it, " +
    "pack roles included. Read-only.",
  input: z
    .object({
      object: staffObjectName,
      id: z.string().min(1).max(64).optional().describe("Record id"),
      slug: slug.optional(),
    })
    .refine((v) => (v.id === undefined) !== (v.slug === undefined), {
      message: "Give id or slug, not both",
    }),
  output: publishedOut.extend({
    redirect: z
      .string()
      .nullable()
      .describe("Read by an old slug: the slug the record has now; else null"),
    pictures: z
      .boolean()
      .describe(
        "Whether the caller is served the record's pictures (media.serve): false for an account " +
          "with a pack role, which a reader then does not ask for (ADR 0708)",
      ),
  }),
  permission: "records:read",
  risk: "read",
  audiences: ["staff"],
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const object = staffReadObject(input.object);
    if (!object) throw staffNotFound(input.object);
    const reader = staffReader(ctx);
    // Whether this account reaches media.serve at all (a pack role does not, ADR 0701): a reader
    // that knows a picture will be refused does not ask for it, so no refusal is audited for it.
    const pictures = staffRightsReach(await loadStaffRights(ctx.db, ctx.user.id), mediaServe);
    if (input.id !== undefined) {
      const found = await getPublished(reader, object, { id: input.id });
      if (!found) throw staffNotFound(input.object);
      return { ...found, redirect: null, pictures };
    }
    const value = input.slug ?? "";
    if (!object.publishable.slug || value.length > SLUG_MAX || !SLUG_RE.test(value)) {
      throw staffNotFound(input.object);
    }
    const found = await getPublished(reader, object, { slug: value });
    if (found) return { ...found, redirect: null, pictures };
    // An old address: the record it points to, while it is published.
    const old = await ctx.db
      .selectFrom("core_slug_redirect")
      .select("record_id")
      .where("object_type", "=", object.name)
      .where("slug", "=", value)
      .executeTakeFirst();
    const target = old ? await getPublished(reader, object, { id: old.record_id }) : null;
    const now = target?.values[object.publishable.slug];
    if (!target || typeof now !== "string" || now === value) throw staffNotFound(input.object);
    return { ...target, redirect: now, pictures };
  },
});

export const contentStaffList = defineOperation({
  name: "content.staffList",
  description:
    "A page of the published records (procedures) of an object staff read as published: current " +
    "published versions only, never a working copy, each with its content fields, its slug, its " +
    "version number and when it was published. Filter and sort on those fields (and " +
    "publishedVersion, publishedAt); pass nextCursor back as cursor. Every staff account may " +
    "read it, pack roles included. Read-only.",
  input: z.object({
    object: staffObjectName,
    filter: filterSchema.optional(),
    sort: sortSchema.optional(),
    cursor: z.string().max(1000).optional(),
    limit: z.number().int().min(1).max(LIST_MAX_LIMIT).default(50),
  }),
  output: z.object({ items: z.array(publishedOut), nextCursor: z.string().nullable() }),
  permission: "records:read",
  risk: "read",
  audiences: ["staff"],
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const object = staffReadObject(input.object);
    if (!object) throw staffNotFound(input.object);
    const { object: _object, ...page } = input;
    return listPublished(staffReader(ctx), object, page);
  },
});

export const contentReindex = defineOperation({
  name: "content.reindex",
  description:
    "Platform use only: catch the published-text index up with the objects' declarations (the " +
    "minute cron): an object whose searchable fields changed has its records' rows made again " +
    "from their current versions, a batch a call; an object no longer searched loses its rows. " +
    "Returns how many records were written and whether more is due.",
  input: z.object({}),
  output: z.object({ records: z.number().int(), more: z.boolean() }),
  permission: "records:write",
  risk: "write",
  // Nothing in the input names a record or its words: it writes what was published.
  actors: ["automation"],
  mcp: { expose: false },
  async handler(_input, ctx) {
    return reindexStep(ctx);
  },
});

/** How a preview link's token looks: `pv_` and 43 characters of base64url (32 random bytes). */
const TOKEN_RE = /^pv_[A-Za-z0-9_-]{43}$/;
/** How long a preview link works by default, and at most, in hours. */
export const PREVIEW_DEFAULT_HOURS = 24;
export const PREVIEW_MAX_HOURS = 168;

function newPreviewToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `pv_${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

export const contentPreview = defineOperation({
  name: "content.preview",
  description:
    "Read the working copy of one record of a content object with a preview link's token: what " +
    "staff are editing, before it is published, with only the fields the public would read. " +
    "The token names one record and works until it expires; for any other record, or after, " +
    "it is not found. Read-only.",
  input: z.object({
    object: objectName,
    slug,
    token: z.string().min(1).max(100).describe("The token of a preview link"),
  }),
  output: recordOut.extend({ kind: z.literal("preview") }),
  permission: "records:read",
  risk: "read",
  audiences: ["staff", "customer", "public"],
  hostInternal: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    const object = contentObject(input.object);
    if (!object || !TOKEN_RE.test(input.token)) throw contentNotFound(input.object);
    const link = await ctx.db
      .selectFrom("core_preview_link")
      .select("record_id")
      .where("token_hash", "=", await sha256Hex(input.token))
      .where("object_type", "=", object.name)
      .where("expires_at", ">", ctx.now)
      .executeTakeFirst();
    if (!link) throw contentNotFound(input.object);
    const record = await previewVisible(publicReader(ctx), object, link.record_id);
    // The link names one record: asked for another's address, it is not found.
    if (!record || record.values[object.publishable.slug] !== input.slug) {
      throw contentNotFound(input.object);
    }
    return { kind: "preview" as const, ...record };
  },
});

export const contentPreviewLink = defineOperation({
  name: "content.previewLink",
  description:
    "Make a preview link for one record of a content object: a token that lets anyone holding " +
    "it read the record's working copy (the fields the public would read) with content.preview, " +
    `for ${PREVIEW_DEFAULT_HOURS} hours by default and at most ${PREVIEW_MAX_HOURS}. Share it ` +
    "only with people who may see the draft. Returns the token and when it stops working.",
  input: z.object({
    object: objectName,
    id: z.string().min(1).max(64).describe("Record id"),
    hours: z
      .number()
      .int()
      .min(1)
      .max(PREVIEW_MAX_HOURS)
      .default(PREVIEW_DEFAULT_HOURS)
      .describe("How long it works"),
  }),
  output: z.object({ token: z.string(), expiresAt: z.string() }),
  permission: "records:write",
  risk: "write",
  // The token is a credential: the audit log keeps when it ends, never the token.
  auditSummary: (output, input) => ({
    object: input.object,
    id: input.id,
    expiresAt: output.expiresAt,
  }),
  async handler(input, ctx) {
    const object = contentObject(input.object);
    if (!object) {
      throw new ValidationError(
        `${input.object} is not content the public reads: it has no preview`,
        {
          object: input.object,
        },
      );
    }
    const record = await loadRecord(ctx, object, input.id);
    if (!record)
      throw new OperationError("not_found", `No ${object.name} with id ${input.id}`, {
        object: object.name,
        id: input.id,
      });
    const token = newPreviewToken();
    const expiresAt = new Date(new Date(ctx.now).getTime() + input.hours * 3_600_000).toISOString();
    ctx.write(
      // Links that have stopped working go as new ones are made.
      CompiledQuery.raw("DELETE FROM core_preview_link WHERE expires_at <= ?", [ctx.now]),
      CompiledQuery.raw(
        "INSERT INTO core_preview_link (token_hash, object_type, record_id, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [await sha256Hex(token), object.name, input.id, expiresAt, ctx.user.id, ctx.now],
      ),
    );
    return { token, expiresAt };
  },
});

/** A preview link's id: the start of its token's hash. Never the token. */
const LINK_ID_LENGTH = 16;

const linkOut = z.object({
  id: z.string().describe("The link's id (not its token): what contentRevokePreview takes"),
  expiresAt: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
});

export const contentPreviewLinks = defineOperation({
  name: "content.previewLinks",
  description:
    "The preview links of one record of a content object that still work: when each was made, " +
    "by whom and when it stops. Never their tokens, which are shown once when a link is made. " +
    "Read-only.",
  input: z.object({ object: objectName, id: z.string().min(1).max(64).describe("Record id") }),
  output: z.object({ items: z.array(linkOut) }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const rows = await ctx.db
      .selectFrom("core_preview_link")
      .select(["token_hash", "expires_at", "created_by", "created_at"])
      .where("object_type", "=", input.object)
      .where("record_id", "=", input.id)
      .where("expires_at", ">", ctx.now)
      .orderBy("created_at", "desc")
      .limit(100)
      .execute();
    return {
      items: rows.map((r) => ({
        id: r.token_hash.slice(0, LINK_ID_LENGTH),
        expiresAt: r.expires_at,
        createdBy: r.created_by,
        createdAt: r.created_at,
      })),
    };
  },
});

export const contentRevokePreview = defineOperation({
  name: "content.revokePreview",
  description:
    "Stop preview links of one record of a content object working now: one by its id (from " +
    "content.previewLinks), or every one with `all`. Returns how many stopped.",
  input: z.object({
    object: objectName,
    id: z.string().min(1).max(64).describe("Record id"),
    link: z
      .string()
      .regex(/^[0-9a-f]{16}$/)
      .optional()
      .describe("The link's id"),
    all: z.boolean().optional().describe("Every link of the record"),
  }),
  output: z.object({ revoked: z.number().int() }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    if (!input.link && !input.all) {
      throw new ValidationError("Name a link, or say all", { field: "link" });
    }
    const rows = await ctx.db
      .selectFrom("core_preview_link")
      .select("token_hash")
      .where("object_type", "=", input.object)
      .where("record_id", "=", input.id)
      .where("expires_at", ">", ctx.now)
      .execute();
    const doomed = rows
      .map((r) => r.token_hash)
      .filter((hash) => input.all || hash.startsWith(input.link ?? "\u0000"));
    if (input.link && !doomed.length) {
      throw new OperationError("not_found", "No such preview link", { link: input.link });
    }
    for (const hash of doomed) {
      ctx.write(CompiledQuery.raw("DELETE FROM core_preview_link WHERE token_hash = ?", [hash]));
    }
    return { revoked: doomed.length };
  },
});

export const contentOperations = [
  contentGet,
  contentList,
  contentSearch,
  contentStaffGet,
  contentStaffList,
  contentReindex,
  contentPreview,
  contentPreviewLink,
  contentPreviewLinks,
  contentRevokePreview,
] as const;
