// The published-text index (stage 38 step 1, ADR 0700): the words of each record's current
// published version, split into sections at its headings, for `content.search`. The one module
// that writes core_published_text (migration 0970).
//
// What is indexed is decided by the object's declaration, never by the caller: a publishable
// object the public reads, and of it only the content fields the public reads (its title, text
// and rich text fields); and an object staff read (`staffRead`, ADR 0701), every text content
// field. A field nobody's search may match is never indexed, so no snippet can show it; a public
// search matches only rows of the fields the public reads, so on an object both public and
// staff-read a staff-only field's rows are never the public's. The index is written in the batch of every publish and unpublish (records/publish.ts),
// so it is the current version or nothing; a declaration that changes (a field opened to the
// public, the object made public or private) is caught up by the minute cron (`reindexStep`),
// which also fills it for what was published before the index existed.
//
// One statement writes a record's rows whatever its length: the sections go in as one JSON
// parameter, so a document of a thousand headings costs what a short one does (D1 runs at most
// 1,000 statements per invocation and binds at most 100 variables per statement).
import { richTextSections } from "@composable-os/sdk";
import { CompiledQuery, sql } from "kysely";
import { getObject, listObjects } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import { generationWrite } from "./cache.ts";

/** Bumped when what a row holds changes: every object's index is made again by the cron. */
const INDEX_VERSION = 1;

/** The field types whose words are indexed. */
const TEXT_TYPES: ReadonlySet<string> = new Set(["text", "longText", "richText"]);

/** Who a search is for: the public (what it reads), or staff (on a staff-read object, ADR 0701). */
export type SearchReader = "public" | "staff";

/**
 * The content fields of `object` a search by `reader` matches, title first; null when it
 * matches none. The public: the text content fields `public.read` lists, of a public object.
 * Staff: on an object that declares `staffRead`, every text content field (staff read the whole
 * published version); on any other object, what the public reads.
 */
export function searchedFields(object: ObjectDefinition, reader: SearchReader): string[] | null {
  const publishable = object.publishable;
  if (!publishable?.slug) return null;
  const staff = reader === "staff" && publishable.staffRead === true;
  if (!staff && !object.public) return null;
  const read = new Set(staff ? publishable.content : (object.public?.read ?? []));
  const fields = publishable.content.filter((name) => {
    const field = object.fields.find((f) => f.name === name);
    return field?.fieldType !== undefined && TEXT_TYPES.has(field.fieldType) && read.has(name);
  });
  if (!fields.length) return null;
  const title = object.titleField;
  return title && fields.includes(title) ? [title, ...fields.filter((f) => f !== title)] : fields;
}

/**
 * The content fields of `object` the index holds, title first; null when it holds none: what
 * any reader's search matches (on a staff-read object, what staff do, which includes what the
 * public does). A search matches only its reader's fields of these (`searchedFields`).
 */
export function indexedFields(object: ObjectDefinition): string[] | null {
  return searchedFields(object, "staff");
}

/** One row of the index, as the insert's JSON parameter carries it. */
interface SectionRow {
  /** The content field. */
  f: string;
  /** The section: 0 before the first heading, then one per heading. */
  s: number;
  /** The heading's anchor (null for section 0). */
  a: string | null;
  /** The heading's words (the title, for the title field's section 0). */
  h: string;
  /** The section's words. */
  b: string;
}

/** The sections of a version's content, for the fields the index holds. */
export function sectionsOf(object: ObjectDefinition, content: Record<string, unknown>) {
  const rows: SectionRow[] = [];
  for (const name of indexedFields(object) ?? []) {
    const value = content[name];
    const type = object.fields.find((f) => f.name === name)?.fieldType;
    if (type === "richText") {
      let heading = 0;
      for (const section of richTextSections(value as { blocks?: unknown[] } | null)) {
        if (section.anchor !== null) heading += 1;
        rows.push({
          f: name,
          s: section.anchor === null ? 0 : heading,
          a: section.anchor,
          h: section.heading,
          b: section.text,
        });
      }
      continue;
    }
    if (typeof value !== "string" || !value.trim()) continue;
    const title = name === object.titleField;
    rows.push({ f: name, s: 0, a: null, h: title ? value : "", b: title ? "" : value });
  }
  return rows;
}

/** Drops the record's rows: no version of it is current. */
export function clearPublishedTextWrite(object: string, id: string): CompiledQuery {
  return CompiledQuery.raw(
    "DELETE FROM core_published_text WHERE object_type = ? AND record_id = ?",
    [object, id],
  );
}

/**
 * The statements that make the record's rows the sections of `content`, its version `version`:
 * at most two, whatever the content's length. An object the index does not hold has none, and
 * whatever it had goes.
 */
export function publishedTextWrites(
  object: ObjectDefinition,
  id: string,
  version: number,
  content: Record<string, unknown>,
): CompiledQuery[] {
  const rows = sectionsOf(object, content);
  const clear = clearPublishedTextWrite(object.name, id);
  if (!rows.length) return [clear];
  return [
    clear,
    CompiledQuery.raw(
      `INSERT INTO core_published_text (object_type, record_id, version, field, section, anchor, heading, body)
       SELECT ?, ?, ?, json_extract(j.value, '$.f'), json_extract(j.value, '$.s'),
         json_extract(j.value, '$.a'), json_extract(j.value, '$.h'), json_extract(j.value, '$.b')
       FROM json_each(?) j`,
      [object.name, id, version, JSON.stringify(rows)],
    ),
  ];
}

// --- Catching up (the minute cron) ---------------------------------------------------------------

/** core_settings key: what each object's index was made from, and how far a remake has got. */
export const PUBLISHED_TEXT_SETTING = "published_text_index";
/** Records whose rows one call writes: two statements each. */
export const REINDEX_BATCH = 50;

interface ObjectState {
  /** What the rows were made from: the fields and INDEX_VERSION. */
  fp: string;
  /** The last record id written while a remake runs; null once done. */
  after: string | null;
}
type IndexState = Record<string, ObjectState>;

const fingerprint = (fields: string[]) => JSON.stringify({ v: INDEX_VERSION, fields });

async function readState(ctx: Pick<HandlerContext, "db">): Promise<IndexState> {
  const row = await ctx.db
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", PUBLISHED_TEXT_SETTING)
    .executeTakeFirst();
  try {
    return row ? (JSON.parse(row.value) as IndexState) : {};
  } catch {
    return {};
  }
}

/** Each indexed object's fingerprint: what its rows should have been made from. */
function wantedIndex(): Map<string, string> {
  const wanted = new Map<string, string>();
  for (const object of listObjects()) {
    const fields = indexedFields(object);
    if (fields) wanted.set(object.name, fingerprint(fields));
  }
  return wanted;
}

/**
 * Whether a round of catching up has anything to do (an object to remake, or one to empty):
 * one settings read, outside any operation. The registry must be fresh (refreshSchemaRegistry).
 */
export async function reindexPending(db: HandlerContext["db"]): Promise<boolean> {
  const state = await readState({ db });
  const wanted = wantedIndex();
  if (Object.keys(state).some((name) => !wanted.has(name))) return true;
  for (const [name, fp] of wanted) {
    const was = state[name];
    if (getObject(name) && !(was && was.fp === fp && was.after === null)) return true;
  }
  return false;
}

/**
 * One round of catching up: for each object whose declaration no longer matches what its rows
 * were made from, the next records' rows made again from their current versions (at most
 * REINDEX_BATCH records), and an object the index no longer holds emptied. With nothing to do it
 * is one read. Returns how many records were written and whether more is due.
 */
export async function reindexStep(
  ctx: HandlerContext,
): Promise<{ records: number; more: boolean }> {
  const state = await readState(ctx);
  const next: IndexState = {};
  let room = REINDEX_BATCH;
  let records = 0;
  let more = false;
  let changed = false;
  const wanted = wantedIndex();
  // An object the index held and no longer holds: its rows go.
  for (const name of Object.keys(state)) {
    if (wanted.has(name)) continue;
    changed = true;
    ctx.write(
      CompiledQuery.raw("DELETE FROM core_published_text WHERE object_type = ?", [name]),
      generationWrite(name, ctx.now),
    );
  }
  for (const [name, fp] of wanted) {
    const object = getObject(name);
    const was = state[name];
    if (!object) continue;
    if (was && was.fp === fp && was.after === null) {
      next[name] = was;
      continue;
    }
    changed = true;
    const after = was && was.fp === fp ? (was.after ?? "") : "";
    if (room <= 0) {
      next[name] = { fp, after };
      more = true;
      continue;
    }
    const versions = await sql<{ record_id: string; version: number; content: string }>`
      SELECT record_id, version, content FROM core_publish_version
      WHERE object_type = ${name} AND current = 1 AND record_id > ${after}
      ORDER BY record_id LIMIT ${room + 1}
    `.execute(ctx.db);
    const batch = versions.rows.slice(0, room);
    for (const v of batch) {
      let content: Record<string, unknown> = {};
      try {
        content = JSON.parse(v.content) as Record<string, unknown>;
      } catch {}
      ctx.write(...publishedTextWrites(object, v.record_id, Number(v.version), content));
    }
    // A cached search of the object is not read again (ADR 0442's generation).
    if (batch.length) ctx.write(generationWrite(name, ctx.now));
    records += batch.length;
    room -= batch.length;
    const done = versions.rows.length <= batch.length;
    if (!done) more = true;
    next[name] = { fp, after: done ? null : (batch.at(-1)?.record_id ?? after) };
  }
  if (changed) {
    const value = JSON.stringify(next);
    ctx.write(
      CompiledQuery.raw(
        "INSERT INTO core_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, NULL) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        [PUBLISHED_TEXT_SETTING, value, ctx.now],
      ),
    );
  }
  return { records, more };
}
