// The stores an erase reaches beyond the records, audit log, activities and AI (ADR 0320, amending
// ADR 0019): sync's suggestions, signatures and job-change signals and the erased-address list;
// extension data (side tables, relations to the subject, free text, key-value state, run logs);
// automation run history, notifications and their deliveries; integration events and the
// automation outbox. Everything is queued in the erase's own batch, so it commits with the erase
// or not at all, and every step is safe to repeat.
//
// Matching follows ADR 0019: the subject's ids and identifying terms (6+ characters, any case)
// anywhere; their names as whole words only where the row is known to be about them.
import { type CompiledQuery as Compiled, CompiledQuery, type SqlBool, sql } from "kysely";
import { mentions } from "../assistant/scrub.ts";
import { releaseAllClaimsOfStatements } from "../capacity/claimants.ts";
import { erasedWaiter, handOnAfterRelease } from "../capacity/waitlist.ts";
import { generationWrite } from "../content/cache.ts";
import { clearPublishedTextWrite, publishedTextWrites } from "../content/published-text.ts";
import { getObject } from "../fields/index.ts";
import type { HandlerContext } from "../operation.ts";
import { changeOrder } from "../orders/orders.ts";
import { chunk, jsonList } from "./common.ts";
import {
  aboutPattern,
  ERASED,
  erasedAddressHash,
  type SubjectMatcher,
  scrubJson,
  scrubJsonText,
  subjectMatcher,
  mentionsSql as termsMentioned,
} from "./erase-subject.ts";
import { queueEraseRestricted } from "./restricted.ts";

export interface StoreSubject {
  object: "person" | "organisation";
  /** The record the erase was asked for: redaction markers name it. */
  recordId?: string | undefined;
  recordIds: readonly string[];
  /** Ids plus identifying terms, lower-cased, 6+ characters. */
  terms: readonly string[];
  names: readonly string[];
  /** Email addresses for the erased-address list (people). */
  addresses: readonly string[];
}

export interface StoreCounts {
  suggestions: number;
  extensionRows: number;
  runs: number;
  notifications: number;
}

/** Does `text` (an SQL expression) contain one of the terms, case-insensitively? */
function mentionsSql(termsJson: string, text: ReturnType<typeof sql>) {
  return termsMentioned(JSON.parse(termsJson) as string[], text);
}

const DROP = Symbol("drop");

/**
 * Redacts a stored JSON value wholesale: array items and properties whose value identifies the
 * subject (or objects holding one) are dropped, and any other string that mentions them becomes
 * "[erased]" whole (a log line, an error message), as audit inputs are.
 */
export function redactJson(value: unknown, m: SubjectMatcher, pattern: RegExp | null): unknown {
  const walk = (v: unknown, nested: boolean): unknown => {
    if (typeof v === "string") {
      if (m.identifies(v)) return DROP;
      return mentions(v, pattern) ? ERASED : v;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, true)).filter((x) => x !== DROP);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(v)) {
        const r = walk(child, true);
        if (r === DROP) {
          // An entry holding their address is about them (an attendee, a recipient): it goes
          // whole. The top-level value itself is kept without that property.
          if (typeof child === "string" && nested) return DROP;
          continue;
        }
        out[key] = r;
      }
      return out;
    }
    return v;
  };
  const r = walk(value, false);
  return r === DROP ? ERASED : r;
}

function redactJsonText(text: string | null, m: SubjectMatcher, pattern: RegExp | null) {
  if (text === null) return null;
  try {
    return JSON.stringify(redactJson(JSON.parse(text), m, pattern));
  } catch {
    return mentions(text, pattern) ? JSON.stringify(ERASED) : text;
  }
}

// --- Sync --------------------------------------------------------------------------------------

/**
 * Suggested contacts, signatures and job-change suggestions for a person go; their addresses
 * join the erased-address list (hashed) so sync does not collect them again. An organisation
 * loses the suggested contacts at its domains.
 */
export async function queueEraseSync(ctx: HandlerContext, s: StoreSubject): Promise<number> {
  const termsJson = JSON.stringify(s.terms);
  const ids = jsonList(s.recordIds);
  let suggestions = 0;
  if (s.object === "person") {
    const addresses = jsonList(s.addresses.length ? s.addresses : [""]);
    const contacts = await ctx.db
      .selectFrom("core_suggested_contact")
      .select("email")
      .where((eb) => eb.or([eb("email", "in", addresses), eb("person_id", "in", ids)]))
      .execute();
    suggestions = contacts.length;
    for (const part of chunk(contacts.map((c) => c.email))) {
      ctx.write(ctx.db.deleteFrom("core_suggested_contact").where("email", "in", part));
    }
    ctx.write(
      ctx.db
        .deleteFrom("core_person_signature")
        .where((eb) => eb.or([eb("person_id", "in", ids), eb("email", "in", addresses)])),
      ctx.db.deleteFrom("core_job_change_suggestion").where("person_id", "in", ids),
    );
    // The list itself: only hashes. Kept until an admin removes an entry (erasure.allowAddress).
    const hashes = await Promise.all(s.addresses.map(erasedAddressHash));
    // Four values a row: 20 rows keeps a statement under D1's 100 bound variables, however many
    // addresses a person had (stage 44 step 8: nobody is un-erasable).
    for (const part of chunk(hashes, 20)) {
      ctx.write(
        ctx.db
          .insertInto("core_erased_address")
          .values(
            part.map((hash) => ({
              hash,
              object_type: "person" as const,
              erased_at: ctx.now,
              erased_by: ctx.user.id,
            })),
          )
          .onConflict((oc) => oc.doNothing()),
      );
    }
  } else if (s.terms.length) {
    // An organisation: suggested contacts at its domains (current and former) are its data.
    const contacts = await ctx.db
      .selectFrom("core_suggested_contact")
      .select("email")
      .where("domain", "in", jsonList(s.terms))
      .execute();
    suggestions = contacts.length;
    for (const part of chunk(contacts.map((c) => c.email))) {
      ctx.write(ctx.db.deleteFrom("core_suggested_contact").where("email", "in", part));
    }
  }
  // Other people's job-change evidence can quote the subject (a shared signature, an address).
  const m = subjectMatcher(s.terms);
  const others = await ctx.db
    .selectFrom("core_job_change_suggestion")
    .select(["id", "evidence", "proposal"])
    .where("person_id", "not in", ids)
    .where(mentionsSql(termsJson, sql`evidence || ' ' || proposal`))
    .execute();
  for (const row of others) {
    ctx.write(
      ctx.db
        .updateTable("core_job_change_suggestion")
        .set({ evidence: scrubJsonText(row.evidence, m), proposal: scrubJsonText(row.proposal, m) })
        .where("id", "=", row.id),
    );
  }
  return suggestions;
}

// --- Extensions --------------------------------------------------------------------------------

// A document (ADR 0445) is scrubbed inside: its strings, never its shape (scrubDocument).
const TEXT_TYPES = new Set([
  "text",
  "longText",
  "email",
  "phone",
  "url",
  "document",
  "richText",
  "image",
  "video",
  "slug",
]);
const IDENT = /^[a-z][a-z0-9_]*$/;
const q = (name: string) => {
  if (!IDENT.test(name)) throw new Error(`Unexpected identifier ${JSON.stringify(name)}`);
  return `"${name}"`;
};

interface FieldRow {
  object: string;
  table_name: string;
  column_name: string | null;
  type: string;
  definition: string;
}

/**
 * Extension data about the subject (ADR 0320), found through the schema's own metadata so it
 * works for every extension, not just Deals:
 * - side-table rows holding extensions' fields on the erased records (`x_<ext>_person`);
 * - rows whose relation field points at the subject: a row whose required single relation is
 *   the subject exists only to relate to it (a deal participant) and is deleted; otherwise the
 *   relation is cleared (or the id removed from a many-relation) and the row's text fields lose
 *   the subject's terms and names;
 * - any other text field that mentions a term (an email field holding their address is cleared);
 * - extension key-value state and extension run logs, operations and errors that mention them.
 */
export async function queueEraseExtensions(ctx: HandlerContext, s: StoreSubject): Promise<number> {
  const tables = new Set(
    (
      await ctx.db
        .selectFrom("sqlite_master" as never)
        .select(sql<string>`name`.as("name"))
        .where(sql<SqlBool>`type = 'table' AND name GLOB 'x_*'`)
        .execute()
    ).map((r) => (r as { name: string }).name),
  );
  const fields = (await ctx.db
    .selectFrom("core_extension_fields")
    .select(["object", "table_name", "column_name", "type", "definition"])
    .execute()) as FieldRow[];
  const live = fields.filter((f) => tables.has(f.table_name));
  const objects = await ctx.db
    .selectFrom("core_extension_objects")
    .select(["name", "table_name"])
    .execute();
  const objectOfTable = new Map(objects.map((o) => [o.table_name, o.name]));
  const idsJson = JSON.stringify(s.recordIds);
  const termsJson = JSON.stringify(s.terms);
  const m = subjectMatcher(s.terms);
  const about = aboutPattern(s.terms, s.names);
  const termOnly = aboutPattern(s.terms, []);
  let rows = 0;

  const textColumns = (table: string) =>
    live
      .filter((f) => f.table_name === table && f.column_name && TEXT_TYPES.has(f.type))
      .map((f) => ({ column: f.column_name as string, type: f.type }));
  const exec = (query: Compiled) => ctx.db.executeQuery<Record<string, unknown>>(query);
  const handled = new Set<string>();

  // 0. Restricted values (ADR 0811) of the records a Person wrote as their customer: read before
  // step 2 clears or deletes those records, and gone whatever becomes of them.
  if (s.object === "person") rows += await queueEraseRestricted(ctx, s.recordIds);

  // 1. Side tables: extensions' fields on the erased records themselves.
  const sideTables = [
    ...new Set(
      live.filter((f) => f.object === s.object && objectOfTable.get(f.table_name) === undefined),
    ),
  ]
    .map((f) => f.table_name)
    .filter((t, i, all) => all.indexOf(t) === i);
  for (const table of sideTables) {
    const found = await exec(
      CompiledQuery.raw(
        `SELECT count(*) AS n FROM ${q(table)} WHERE id IN (SELECT value FROM json_each(?))`,
        [idsJson],
      ),
    );
    rows += Number(found.rows[0]?.n ?? 0);
    ctx.write(
      CompiledQuery.raw(`DELETE FROM ${q(table)} WHERE id IN (SELECT value FROM json_each(?))`, [
        idsJson,
      ]),
    );
  }

  // 2. Relation fields pointing at the subject.
  const relations = live.filter((f) => {
    if (f.type !== "relation" || !f.column_name) return false;
    try {
      return (JSON.parse(f.definition) as { to?: string }).to === s.object;
    } catch {
      return false;
    }
  });
  const deleted: { object: string; id: string }[] = [];
  // A row may point at the subject through two relations (a booking's Person and who made it,
  // ADR 0540): its places are given back, and it is deleted, once.
  const gone = new Set<string>();
  const released = new Set<string>();
  for (const field of relations) {
    const def = JSON.parse(field.definition) as { required?: boolean; many?: boolean };
    const table = field.table_name;
    const column = field.column_name as string;
    const texts = textColumns(table);
    const found = await exec(
      CompiledQuery.raw(
        `SELECT id, ${q(column)} AS rel${texts.map((t) => `, ${q(t.column)}`).join("")}
         FROM ${q(table)}
         WHERE ${q(column)} IN (SELECT value FROM json_each(?1))
            OR (${q(column)} GLOB '[[]*' AND json_valid(${q(column)}) AND EXISTS (
              SELECT 1 FROM json_each(${q(column)}) j
              WHERE j.value IN (SELECT value FROM json_each(?1))))`,
        [idsJson],
      ),
    );
    const object = objectOfTable.get(table);
    for (const row of found.rows) {
      const id = String(row.id);
      const key = `${table}|${id}`;
      if (gone.has(key)) continue;
      rows += 1;
      handled.add(key);
      // A capacity claimant (ADR 0501) gives back every place it holds or takes, in this batch,
      // whether the row is deleted or kept with its reference cleared: a place is never held for
      // nobody. A kept row stays in its state, holding nothing; moving it later releases nothing.
      const claimant = object ? getObject(object) : undefined;
      // A waiter leaves the queue with its Person (ADR 0520): deleted, whether or not its relation
      // is required, so nobody is promoted into a place for no one and those behind move up; the
      // waitlist's holds go back if nobody else waits. (It holds and spends nothing.)
      // Only through the record's own Person: a parent erased (who made a child's booking,
      // ADR 0540) clears their name from it, and never touches the child's place or queue.
      const ownColumn = claimant?.customer
        ? claimant.fields.find((f) => f.name === claimant.customer?.field)?.column
        : undefined;
      const own = !claimant?.customer || ownColumn === column;
      const waiter =
        object && own && claimant?.claims ? await erasedWaiter(ctx, claimant, id) : null;
      if (object && waiter) {
        gone.add(key);
        deleted.push({ object, id });
        ctx.write(CompiledQuery.raw(`DELETE FROM ${q(table)} WHERE id = ?`, [id]), ...waiter);
        continue;
      }
      if (object && own && claimant?.claims && !released.has(key)) {
        released.add(key);
        ctx.write(...releaseAllClaimsOfStatements(object, id, ctx.now));
        // A place given back before its cut-off is the waitlist's, as a cancel's is (ADR 0520).
        await handOnAfterRelease(ctx, claimant, id);
      }
      // A Person optional only because a guest's unpaid drop-in may be held for no one
      // (`sellable.moves.guest`, ADR 0560) is required for erasure, as it was before: the erased
      // Person's records go with them.
      const guestOwner =
        claimant?.sellable?.moves?.guest === true &&
        claimant.fields.find((f) => f.name === claimant.customer?.field)?.column === column;
      if ((def.required || guestOwner) && !def.many && object) {
        gone.add(key);
        deleted.push({ object, id });
        ctx.write(CompiledQuery.raw(`DELETE FROM ${q(table)} WHERE id = ?`, [id]));
        continue;
      }
      let rel: string | null = null;
      if (def.many && typeof row.rel === "string") {
        try {
          const kept = (JSON.parse(row.rel) as string[]).filter((v) => !s.recordIds.includes(v));
          rel = kept.length ? JSON.stringify(kept) : null;
        } catch {
          rel = null;
        }
      }
      const sets = [`${q(column)} = ?`];
      const params: unknown[] = [rel];
      for (const t of texts) {
        const value = row[t.column];
        if (typeof value !== "string") continue;
        sets.push(`${q(t.column)} = ?`);
        params.push(scrubField(value, t.type, m, about));
      }
      ctx.write(
        CompiledQuery.raw(`UPDATE ${q(table)} SET ${sets.join(", ")} WHERE id = ?`, [
          ...params,
          id,
        ]),
      );
    }
  }
  for (const record of deleted) {
    ctx.write(
      ctx.db
        .deleteFrom("core_activity_links")
        .where("object_type", "=", record.object)
        .where("record_id", "=", record.id),
      ctx.db
        .deleteFrom("core_task_links")
        .where("object_type", "=", record.object)
        .where("record_id", "=", record.id),
      ctx.db
        .deleteFrom("core_record_tags")
        .where("object_type", "=", record.object)
        .where("record_id", "=", record.id),
      ctx.db
        .deleteFrom("core_search_docs")
        .where("object_type", "=", record.object)
        .where("record_id", "=", record.id),
      // Its published words (ADR 0700).
      clearPublishedTextWrite(record.object, record.id),
      // Who stood behind its values (ADR 0590): hashes of what it said.
      ctx.db
        .deleteFrom("core_value_mark")
        .where("object_type", "=", record.object)
        .where("record_id", "=", record.id),
    );
  }
  // A deleted record's restricted values (ADR 0811), whoever wrote them: one statement per object.
  const deletedIds = new Map<string, string[]>();
  for (const record of deleted) {
    deletedIds.set(record.object, [...(deletedIds.get(record.object) ?? []), record.id]);
  }
  for (const [object, ids] of deletedIds) {
    ctx.write(
      CompiledQuery.raw(
        "DELETE FROM core_restricted_value WHERE object_type = ? AND record_id IN (SELECT value FROM json_each(?))",
        [object, JSON.stringify(ids)],
      ),
    );
  }

  // 3. Free text in any extension table that mentions a term (not names: not known to be about
  // them). Linear in the extension tables' size; erase is rare and admin-run.
  if (s.terms.length) {
    for (const table of [...new Set(live.map((f) => f.table_name))]) {
      if (sideTables.includes(table)) continue;
      const texts = textColumns(table);
      if (!texts.length) continue;
      const found = await exec(
        CompiledQuery.raw(
          `SELECT id${texts.map((t) => `, ${q(t.column)}`).join("")} FROM ${q(table)}
           WHERE EXISTS (SELECT 1 FROM json_each(?) t WHERE ${texts
             .map((t) => `instr(lower(coalesce(${q(t.column)}, '')), t.value) > 0`)
             .join(" OR ")})`,
          [termsJson],
        ),
      );
      for (const row of found.rows) {
        const id = String(row.id);
        if (handled.has(`${table}|${id}`)) continue;
        rows += 1;
        const sets: string[] = [];
        const params: unknown[] = [];
        for (const t of texts) {
          const value = row[t.column];
          if (typeof value !== "string") continue;
          const next = scrubField(value, t.type, m, termOnly);
          if (next === value) continue;
          sets.push(`${q(t.column)} = ?`);
          params.push(next);
        }
        if (sets.length) {
          ctx.write(
            CompiledQuery.raw(`UPDATE ${q(table)} SET ${sets.join(", ")} WHERE id = ?`, [
              ...params,
              id,
            ]),
          );
        }
      }
    }
    // Restricted values (ADR 0811) that mention a term, as free text is: someone else's words
    // about the subject lose them, and one that is their address or id alone goes.
    const restricted = await ctx.db
      .selectFrom("core_restricted_value")
      .select(["object_type", "record_id", "field", "value"])
      .where(mentionsSql(termsJson, sql`value`))
      .execute();
    for (const row of restricted) {
      const next = scrubField(row.value, "text", m, termOnly);
      if (next === row.value) continue;
      rows += 1;
      if (next === null) {
        ctx.write(
          ctx.db
            .deleteFrom("core_restricted_value")
            .where("object_type", "=", row.object_type)
            .where("record_id", "=", row.record_id)
            .where("field", "=", row.field),
        );
      } else {
        ctx.write(
          ctx.db
            .updateTable("core_restricted_value")
            .set({ value: next })
            .where("object_type", "=", row.object_type)
            .where("record_id", "=", row.record_id)
            .where("field", "=", row.field),
        );
      }
    }
    // Published versions (ADR 0446) are snapshots of records' content: one that mentions a term
    // loses it as the record's own fields do, keeping its shape and its number.
    const versions = await ctx.db
      .selectFrom("core_publish_version")
      .select(["object_type", "record_id", "version", "content", "current"])
      .where(mentionsSql(termsJson, sql`content`))
      .execute();
    for (const version of versions) {
      const content = scrubDocument(version.content, m, termOnly);
      if (content === version.content) continue;
      rows += 1;
      ctx.write(
        ctx.db
          .updateTable("core_publish_version")
          .set({ content, bytes: new TextEncoder().encode(content).length })
          .where("object_type", "=", version.object_type)
          .where("record_id", "=", version.record_id)
          .where("version", "=", version.version),
      );
      // The published-text index (ADR 0700) holds the current version's words: made again from
      // the scrubbed content, so a search never finds them.
      // A record this erase deletes keeps none (its rows went above); a cached search of the
      // object is not read again (ADR 0442's generation), so the old snippet is never served.
      const definition = getObject(version.object_type);
      const erased = deleted.some(
        (d) => d.object === version.object_type && d.id === version.record_id,
      );
      if (Number(version.current) === 1 && definition && !erased) {
        ctx.write(
          ...publishedTextWrites(
            definition,
            version.record_id,
            Number(version.version),
            JSON.parse(content) as Record<string, unknown>,
          ),
        );
      }
      if (Number(version.current) === 1) ctx.write(generationWrite(version.object_type, ctx.now));
    }
    // A scheduled publish (stage 28, ADR 0441) holds a snapshot too, until the cron takes it.
    const scheduled = await ctx.db
      .selectFrom("core_publish_schedule")
      .select(["object_type", "record_id", "content"])
      .where(mentionsSql(termsJson, sql`content`))
      .execute();
    for (const row of scheduled) {
      const content = scrubDocument(row.content, m, termOnly);
      if (content === row.content) continue;
      rows += 1;
      ctx.write(
        ctx.db
          .updateTable("core_publish_schedule")
          .set({ content, bytes: new TextEncoder().encode(content).length })
          .where("object_type", "=", row.object_type)
          .where("record_id", "=", row.record_id),
      );
    }
    // Extension records' search entries (titles) follow their scrubbed text.
    // Looked up per extension object (the index's leading column), not across core records.
    const docs = objects.length
      ? await ctx.db
          .selectFrom("core_search_docs")
          .select(["object_type", "record_id", "title", "body"])
          .where("object_type", "in", jsonList(objects.map((o) => o.name)))
          .where(mentionsSql(termsJson, sql`title || ' ' || body`))
          .execute()
      : [];
    for (const doc of docs) {
      ctx.write(
        ctx.db
          .updateTable("core_search_docs")
          .set({ title: m.text(doc.title) ?? "", body: m.text(doc.body) ?? "" })
          .where("object_type", "=", doc.object_type)
          .where("record_id", "=", doc.record_id),
      );
    }

    // 4. Key-value state: an entry whose key names the subject goes; values are redacted.
    const kv = await ctx.db
      .selectFrom("core_extension_kv")
      .select(["extension_id", "key", "value"])
      .where(mentionsSql(termsJson, sql`key || ' ' || value`))
      .execute();
    for (const entry of kv) {
      const keyed = mentions(entry.key, termOnly);
      const where = (q2: ReturnType<typeof ctx.db.deleteFrom<"core_extension_kv">>) =>
        q2.where("extension_id", "=", entry.extension_id).where("key", "=", entry.key);
      if (keyed) {
        ctx.write(where(ctx.db.deleteFrom("core_extension_kv")));
      } else {
        ctx.write(
          ctx.db
            .updateTable("core_extension_kv")
            .set({ value: redactJsonText(entry.value, m, termOnly) ?? "null", updated_at: ctx.now })
            .where("extension_id", "=", entry.extension_id)
            .where("key", "=", entry.key),
        );
      }
    }

    // 5. Extension run logs (tool calls, manifests, automations): logs, operations and errors.
    const runs = await ctx.db
      .selectFrom("core_extension_runs")
      .select(["id", "logs", "operations", "error"])
      .where(
        mentionsSql(
          termsJson,
          sql`logs || ' ' || operations || ' ' || coalesce(error, '') || ' ' || coalesce(name, '')`,
        ),
      )
      .execute();
    for (const run of runs) {
      ctx.write(
        ctx.db
          .updateTable("core_extension_runs")
          .set({
            logs: redactJsonText(run.logs, m, termOnly) ?? "[]",
            operations: redactJsonText(run.operations, m, termOnly) ?? "[]",
            error: run.error === null ? null : erasedError(run.error, termOnly),
          })
          .where("id", "=", run.id),
      );
    }
  }
  return rows;
}

/** A text field's value without the subject: cleared if it is their email or phone, else blanked. */
function scrubField(
  value: string,
  type: string,
  m: SubjectMatcher,
  pattern: RegExp | null,
): string | null {
  if (type === "document" || type === "richText" || type === "image" || type === "video") {
    return scrubDocument(value, m, pattern);
  }
  if (m.identifies(value)) return null;
  if (!mentions(value, pattern)) return value;
  // A typed value (an address, a URL) that mentions them cannot keep a valid partial form.
  if (type === "email" || type === "phone" || type === "url" || type === "slug") return null;
  return pattern ? value.replace(pattern, ERASED) : value;
}

/**
 * A stored document (ADR 0445, or a published version's content, ADR 0446) without the subject:
 * every string in it that is their address, phone or id becomes "[erased]", and every other
 * string loses their terms and names (`pattern`). Keys, lists, numbers and the document's shape
 * are kept, so it still reads as the schema it was written to (a text node's `chars` aside).
 */
export function scrubDocument(text: string, m: SubjectMatcher, pattern: RegExp | null): string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return mentions(text, pattern) ? JSON.stringify(ERASED) : text;
  }
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (m.identifies(v)) return ERASED;
      return mentions(v, pattern) && pattern ? v.replace(pattern, ERASED) : v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([key, child]) => [key, walk(child)]));
    }
    return v;
  };
  const next = JSON.stringify(walk(value));
  return next === JSON.stringify(value) ? text : next;
}

/** An error JSON (`{ code, message }`) that mentions the subject keeps its code only. */
function erasedError(error: string, pattern: RegExp | null): string {
  if (!mentions(error, pattern)) return error;
  try {
    const code = (JSON.parse(error) as { code?: unknown }).code ?? "internal";
    return JSON.stringify({ code, message: ERASED });
  } catch {
    return JSON.stringify({ code: "internal", message: ERASED });
  }
}

// --- Automation runs, notifications, events ----------------------------------------------------

/**
 * Automation run history (kept 30–90 days), notifications and their delivery records,
 * integration events and the automation outbox.
 * - A run whose record was the subject is about them: its trigger keeps only its type, its steps
 *   keep their names, kinds and statuses (logs, values, operations and errors go), its report is
 *   dropped, its error keeps only its code and its reason loses their terms and names. It can no
 *   longer be retried or replayed. Its run-record rows for the subject are deleted.
 * - Any other run that mentions a term is redacted in place (entries naming them dropped, strings
 *   mentioning them erased whole).
 * - A notification that mentions the subject (links to them, names their id, email or phone) or
 *   came from a run about them is deleted; delivery records that mention them lose their detail.
 * - Integration events lose payload entries naming them; queued automation events that mention
 *   them are dropped.
 */
export async function queueEraseRuns(
  ctx: HandlerContext,
  s: StoreSubject,
): Promise<{ runs: number; notifications: number }> {
  const termsJson = JSON.stringify(s.terms);
  const ids = jsonList(s.recordIds);
  const m = subjectMatcher(s.terms);
  const about = aboutPattern(s.terms, s.names);
  const termOnly = aboutPattern(s.terms, []);

  const [byRecord, byIndex] = await Promise.all([
    ctx.db
      .selectFrom("core_automation_runs")
      .select("id")
      .where("record_object", "=", s.object)
      .where("record_id", "in", ids)
      .execute(),
    ctx.db
      .selectFrom("core_automation_run_records")
      .select("run_id as id")
      .where("object_type", "=", s.object)
      .where("record_id", "in", ids)
      .execute(),
  ]);
  const aboutIds = [...new Set([...byRecord, ...byIndex].map((r) => r.id))];
  const runs = await ctx.db
    .selectFrom("core_automation_runs")
    .select(["id", "trigger", "steps", "report", "error", "status_reason", "status"])
    .where((eb) =>
      eb.or([
        eb("id", "in", jsonList(aboutIds.length ? aboutIds : [""])),
        mentionsSql(
          termsJson,
          sql`trigger || ' ' || steps || ' ' || coalesce(report, '') || ' ' || coalesce(error, '')
            || ' ' || coalesce(status_reason, '')`,
        ),
      ]),
    )
    .execute();
  const aboutSet = new Set(aboutIds);
  for (const run of runs) {
    if (aboutSet.has(run.id)) {
      let type: unknown = null;
      try {
        type = (JSON.parse(run.trigger) as { type?: unknown }).type ?? null;
      } catch {}
      let steps: unknown[] = [];
      try {
        steps = (JSON.parse(run.steps) as Record<string, unknown>[]).map((step) => ({
          name: step.name,
          kind: step.kind,
          status: step.status,
          startedAt: step.startedAt,
          operations: [],
          logs: [],
          ...(step.error ? { error: { code: "erased", message: ERASED } } : {}),
        }));
      } catch {}
      // A run still waiting its turn (ADR 0573) is about a record that no longer exists: it never
      // starts, rather than start with no record.
      const deferred =
        run.status === "queued" && Boolean(run.status_reason?.startsWith("deferred:"));
      ctx.write(
        ctx.db
          .updateTable("core_automation_runs")
          .set({
            ...(deferred ? { status: "cancelled", finished_at: ctx.now, wait_until: null } : {}),
            trigger: JSON.stringify({ type, erased: true }),
            steps: JSON.stringify(steps),
            report: null,
            error: run.error === null ? null : erasedError(run.error, /[\s\S]/),
            status_reason: deferred
              ? ERASED
              : run.status_reason === null
                ? null
                : mentions(run.status_reason, about)
                  ? ERASED
                  : run.status_reason,
            record_object: null,
            record_id: null,
          })
          .where("id", "=", run.id),
      );
    } else {
      ctx.write(
        ctx.db
          .updateTable("core_automation_runs")
          .set({
            trigger: redactJsonText(run.trigger, m, termOnly) ?? "{}",
            steps: redactJsonText(run.steps, m, termOnly) ?? "[]",
            report: redactJsonText(run.report, m, termOnly),
            error: run.error === null ? null : erasedError(run.error, termOnly),
            status_reason:
              run.status_reason !== null && mentions(run.status_reason, termOnly)
                ? ERASED
                : run.status_reason,
          })
          .where("id", "=", run.id),
      );
    }
  }
  ctx.write(
    ctx.db
      .deleteFrom("core_automation_run_records")
      .where("object_type", "=", s.object)
      .where("record_id", "in", ids),
  );

  // Notifications: delete what mentions them or came from a run about them.
  const notifications = await ctx.db
    .selectFrom("core_notifications")
    .select("id")
    .where((eb) =>
      eb.or([
        mentionsSql(
          termsJson,
          sql`title || ' ' || coalesce(body, '') || ' ' || coalesce(link, '') || ' ' || source`,
        ),
        ...(aboutIds.length
          ? [
              sql<SqlBool>`json_extract(source, '$.runId') IN (SELECT value FROM json_each(${JSON.stringify(
                aboutIds,
              )}))`,
            ]
          : []),
      ]),
    )
    .execute();
  for (const part of chunk(notifications.map((n) => n.id))) {
    ctx.write(ctx.db.deleteFrom("core_notifications").where("id", "in", part));
  }
  const deliveries = await ctx.db
    .selectFrom("core_notification_delivery")
    .select("key")
    .where(mentionsSql(termsJson, sql`coalesce(detail, '') || ' ' || key`))
    .execute();
  for (const part of chunk(deliveries.map((d) => d.key))) {
    ctx.write(
      ctx.db
        .updateTable("core_notification_delivery")
        .set({ detail: ERASED })
        .where("key", "in", part),
    );
  }

  // Integration events (webhook and sync payloads).
  const events = await ctx.db
    .selectFrom("core_integration_event")
    .select(["id", "payload"])
    .where(mentionsSql(termsJson, sql`payload`))
    .execute();
  for (const event of events) {
    ctx.write(
      ctx.db
        .updateTable("core_integration_event")
        .set({ payload: JSON.stringify(scrubJson(JSON.parse(event.payload), m).value ?? {}) })
        .where("id", "=", event.id),
    );
  }

  // Automation events waiting in the outbox: drop the messages that mention them.
  const outbox = await ctx.db
    .selectFrom("core_automation_outbox")
    .select(["id", "messages"])
    .where(mentionsSql(termsJson, sql`messages`))
    .execute();
  for (const row of outbox) {
    let messages: unknown[] = [];
    try {
      messages = JSON.parse(row.messages) as unknown[];
    } catch {}
    const kept = messages.filter((msg) => !mentions(msg, termOnly));
    ctx.write(
      kept.length
        ? ctx.db
            .updateTable("core_automation_outbox")
            .set({ messages: JSON.stringify(kept) })
            .where("id", "=", row.id)
        : ctx.db.deleteFrom("core_automation_outbox").where("id", "=", row.id),
    );
  }
  return { runs: runs.length, notifications: notifications.length };
}

// --- Customer accounts -------------------------------------------------------------------------

/**
 * The sign-in addresses of the customer accounts linked to the people being erased. They join the
 * subject's addresses (and terms), so they go on the erased-address list: the person cannot sign
 * up again with them unless an admin allows the address back.
 */
export async function customerAddresses(
  ctx: HandlerContext,
  recordIds: readonly string[],
): Promise<string[]> {
  const rows = await ctx.db
    .selectFrom("core_customer")
    .select("email")
    .where("person_id", "in", jsonList(recordIds))
    .execute();
  return rows.map((r) => r.email);
}

/**
 * A person's customer account (stage 22, ADR 0402): the accounts linked to them or signed up with
 * one of their addresses (one waiting for a merge included; an address another identified Person
 * holds now is not theirs, #302), every session and address change of those accounts, their
 * calendar links, one-time sign-in codes sent to their addresses, invites for their addresses, and their erase
 * requests. All deleted, so nothing is left but the audit trail; an open request is closed as
 * `erased` in the audit first. Returns how many requests were closed.
 */
export async function queueEraseCustomers(ctx: HandlerContext, s: StoreSubject): Promise<number> {
  if (s.object !== "person") return 0;
  const ids = jsonList(s.recordIds);
  const addresses = jsonList(s.addresses.length ? s.addresses : [""]);
  const accounts = await ctx.db
    .selectFrom("core_customer")
    .select(["id", "email"])
    .where((eb) => eb.or([eb("person_id", "in", ids), eb("email", "in", addresses)]))
    .execute();
  const accountIds = accounts.map((a) => a.id);
  const requests = await ctx.db
    .selectFrom("core_erase_request")
    .select(["id", "status"])
    .where((eb) =>
      eb.or([
        eb("person_id", "in", ids),
        ...(accountIds.length ? [eb("customer_id", "in", jsonList(accountIds))] : []),
      ]),
    )
    .execute();
  const open = requests.filter((r) => r.status === "open");
  for (const request of open) {
    ctx.recordChange({
      object: "erase_request",
      id: request.id,
      action: "update",
      before: { status: "open" },
      after: { status: "erased" },
    });
  }
  for (const part of chunk(requests.map((r) => r.id))) {
    ctx.write(ctx.db.deleteFrom("core_erase_request").where("id", "in", part));
  }
  for (const part of chunk(accountIds)) {
    ctx.write(
      ctx.db.deleteFrom("core_customer_session").where("customer_id", "in", part),
      // Their sign-in address changes (stage 48): the subject already read their old addresses.
      ctx.db.deleteFrom("core_customer_email_change").where("customer_id", "in", part),
      // Their calendar link (ADR 0890), before the account (the cascade would too).
      ctx.db.deleteFrom("core_customer_feed").where("customer_id", "in", part),
      ctx.db.deleteFrom("core_customer").where("id", "in", part),
    );
  }
  // The HTTP surface's stored replies (stage 23, ADR 0416): every key of their account, and any
  // other caller's reply that names them (a staff write about them), go now, not in 24 hours.
  const scopes = accountIds.map((id) => `customer:${id}`);
  for (const part of chunk(scopes)) {
    ctx.write(
      ctx.db.deleteFrom("core_idempotency_key").where("scope", "in", part),
      ctx.db.deleteFrom("core_idempotency_claim").where("scope", "in", part),
    );
  }
  if (s.terms.length) {
    ctx.write(
      ctx.db
        .deleteFrom("core_idempotency_key")
        .where(mentionsSql(JSON.stringify(s.terms), sql`response`)),
    );
  }
  // Codes are stored as `<type>-otp-<address>` (Better Auth's email OTP plugin).
  const emails = jsonList([...new Set([...s.addresses, ...accounts.map((a) => a.email)])]);
  ctx.write(
    ctx.db.deleteFrom("core_customer_verification").where(
      sql<SqlBool>`instr(identifier, '-otp-') > 0
          AND lower(substr(identifier, instr(identifier, '-otp-') + 5)) IN ${emails}`,
    ),
    ctx.db.deleteFrom("core_customer_invite").where("email", "in", emails),
  );
  return open.length;
}

// --- Orders and lifecycle history (stage 25, ADR 0426) -------------------------------------------

/**
 * A lifecycle's history of the erased records themselves goes: `core_transition_history` rows
 * whose record is the subject (ADR 0425: the engine's history, for stages and states alike).
 *
 * A person's orders stay, as amounts with no one on them (an organisation's books must still add
 * up): the order loses its person, the address it was placed with and the guest's token, so it
 * can no longer be found by who bought it or opened by a link. Its lines, payments and history
 * name the order, never the person. Returns how many orders were stripped.
 */
export async function queueEraseOrders(ctx: HandlerContext, s: StoreSubject): Promise<number> {
  for (const part of chunk([...s.recordIds])) {
    ctx.write(
      ctx.db
        .deleteFrom("core_transition_history")
        .where("object_type", "=", s.object)
        .where("record_id", "in", part),
    );
  }
  if (s.object !== "person") return 0;
  const ids = jsonList(s.recordIds);
  const addresses = jsonList(s.addresses.length ? s.addresses.map((a) => a.toLowerCase()) : [""]);
  // Whose an order or a subscription is (stage 44 step 8, the second review of PR #288, ADR 0646
  // narrowing ADR 0320): the erased Person's, or nobody's and carrying one of their own
  // addresses. One that belongs to another identified Person (a guardian's purchase made with a
  // family address the child's record also holds) is never touched: not cancelled, not closed,
  // its address not cleared.
  const theirOrder = sql<SqlBool>`(person_id IN ${ids}
    OR (person_id IS NULL AND lower(email) IN ${addresses}))`;
  const theirSubscription = sql<SqlBool>`((payer_person_id IN ${ids} OR holder_person_id IN ${ids})
      AND (payer_person_id IS NULL OR payer_person_id IN ${ids})
      AND (holder_person_id IS NULL OR holder_person_id IN ${ids}))
    OR (payer_person_id IS NULL AND holder_person_id IS NULL AND lower(email) IN ${addresses})`;
  // Who stood behind their values (ADR 0590): hashes, but keyed by their ids or, for what is
  // keyed by an address (a customer invite), their addresses, and their orders' (an order's mark
  // holds an unsalted hash of the address that paid); deleted.
  ctx.write(
    ctx.db
      .deleteFrom("core_value_mark")
      .where((eb) =>
        eb.or([
          eb("record_id", "in", ids),
          eb("record_id", "in", addresses),
          eb.and([
            eb("object_type", "=", "order"),
            eb("record_id", "in", eb.selectFrom("core_order").select("id").where(theirOrder)),
          ]),
        ]),
      ),
  );
  // Their routine mail (ADR 0590): who was sent what about which record. Deleted, by Person or
  // by address (a guardian's, a paid visitor's), and every row about their records, those sent
  // to a guardian about an erased child included (D5).
  ctx.write(
    ctx.db
      .deleteFrom("core_routine_mail")
      .where((eb) =>
        eb.or([
          eb("recipient_person_id", "in", ids),
          eb("about_person_id", "in", ids),
          eb("recipient", "in", addresses),
        ]),
      ),
  );
  // The codes sent to their numbers (stage 30, ADR 0673): deleted. A number that replied STOP
  // stays a salted hash in core_text_stop, tied to nobody, so it is not texted if entered again.
  ctx.write(ctx.db.deleteFrom("core_phone_check").where("person_id", "in", ids));
  // Their continuation offers (stage 32a, ADR 0491): an address and a date, nothing the books
  // need. Deleted, by Person or by address.
  ctx.write(
    ctx.db
      .deleteFrom("core_subscription_offer")
      .where((eb) => eb.or([eb("person_id", "in", ids), eb("email", "in", addresses)])),
  );
  // The reasons written on their subscriptions' plan changes and pauses (stage 32b): free text
  // staff or the member typed (an injury, travel). The change itself stays, as the books' terms.
  ctx.write(
    ctx.db
      .updateTable("core_subscription_change")
      .set({ reason: "", call_error: null, end_error: null, updated_at: ctx.now })
      .where("subscription_id", "in", (eb) =>
        eb.selectFrom("core_subscription").select("id").where(theirSubscription),
      ),
  );
  const orders = await ctx.db.selectFrom("core_order").selectAll().where(theirOrder).execute();
  // Their orders' adjustments (stage 34, ADR 0690) keep their amounts, kinds and sources (the
  // order is a financial record); a staff reason, which may say something about them, is blanked,
  // and so is the audit log's copy of it: the input of each order.adjust and order.unadjust on
  // their orders is redacted through the sanctioned path (core_audit_redactions). Their input
  // names only the order, so the erase's own term match never finds them. The same holds for
  // payments taken another way (ADR 0694): a recorded payment's reference (a bank reference
  // naming the payer, say) and a reversal's reason are blanked, with the audit's copies of
  // order.recordPayment, order.reversePayment (which names the payment) and order.recordRefund.
  if (orders.length) {
    const orderIds = jsonList(orders.map((row) => row.id));
    ctx.write(
      ctx.db
        .updateTable("core_order_adjustment")
        .set({ reason: null })
        .where("reason", "is not", null)
        .where("order_id", "in", orderIds),
      ctx.db
        .insertInto("core_audit_redactions")
        .orIgnore()
        .columns([
          "audit_id",
          "change_id",
          "object_type",
          "record_id",
          "operation",
          "user_id",
          "at",
        ])
        .expression(
          ctx.db
            .selectFrom("core_audit as a")
            .select([
              "a.id as audit_id",
              sql<number | null>`NULL`.as("change_id"),
              sql<string>`${s.object}`.as("object_type"),
              sql<string>`${s.recordId ?? s.recordIds[0] ?? ""}`.as("record_id"),
              sql<string>`${ctx.operation}`.as("operation"),
              sql<string>`${ctx.user.id}`.as("user_id"),
              sql<string>`${ctx.now}`.as("at"),
            ])
            .where((eb) =>
              eb.or([
                eb.and([
                  eb("a.operation", "in", [
                    "order.adjust",
                    "order.unadjust",
                    "order.recordPayment",
                    "order.recordRefund",
                  ]),
                  sql<SqlBool>`json_extract(a.input, '$.id') IN ${orderIds}`,
                ]),
                eb.and([
                  eb("a.operation", "=", "order.reversePayment"),
                  sql<SqlBool>`json_extract(a.input, '$.paymentId') IN (SELECT event_id FROM core_order_payment WHERE provider = 'host' AND order_id IN ${orderIds})`,
                ]),
              ]),
            ),
        ),
    );
  }
  // Their purchases still open (stage 44 step 8, ADR 0646): an order nothing was paid on is
  // cancelled by the host, so a payment that comes after the erase never makes it paid (a
  // drop-in's is owed back automatically, `oweLateRefund`, ADR 0429; another's is on the paid-late
  // list for staff to refund, never to honour: orders/payments.ts, orders/late.ts). A part-paid
  // one is detached (it has no Person and no address after the erase): a balance paid later is
  // handled the same way. A subscription checkout the provider has not confirmed is closed, so a
  // later confirmation makes nothing (subscriptions/events.ts). Their guest acceptances go with
  // them (agreements/people.ts).
  for (const row of orders) {
    if (row.state === "pending" && row.paid === 0) {
      await changeOrder(ctx, row, "cancelled", { person_id: null }, "host");
    }
  }
  // An unconfirmed checkout is closed when it is theirs, or when they are its payer (who would be
  // charged), whoever the holder is (a guardian paying for a child). A holder-only erase with a
  // live payer leaves the payer's checkout open.
  ctx.write(
    ctx.db
      .updateTable("core_subscription_checkout")
      .set({ email: null, erased_at: ctx.now })
      .where("subscription_ref", "is", null)
      .where("erased_at", "is", null)
      .where(sql<SqlBool>`(${theirSubscription}) OR payer_person_id IN ${ids}`),
  );
  // On any checkout or subscription they are on (payer or holder), an address of their own goes;
  // nothing else of the other Person's is touched. A live subscription whose payer is erased
  // keeps billing as the provider runs it (ADR 0646: left for later).
  const onIt = sql<SqlBool>`(payer_person_id IN ${ids} OR holder_person_id IN ${ids})
    AND email IS NOT NULL AND lower(email) IN ${addresses}`;
  ctx.write(
    ctx.db.updateTable("core_subscription_checkout").set({ email: null }).where(onIt),
    ctx.db.updateTable("core_subscription").set({ email: null }).where(onIt),
  );
  for (const part of chunk(orders.map((o) => o.id))) {
    ctx.write(
      ctx.db
        .updateTable("core_order")
        .set({
          person_id: null,
          email: null,
          access_hash: null,
          email_link_hash: null,
          updated_at: ctx.now,
        })
        .where("id", "in", part),
      // Staff's words about a refund may name the person (migration 0422), and so may a
      // reference given with a payment or a refund taken another way (migration 0952).
      ctx.db
        .updateTable("core_order_refund")
        .set({ reason: null, reference: null })
        .where("order_id", "in", part),
      ctx.db
        .updateTable("core_order_payment")
        .set({ reference: null, reason: null })
        .where("order_id", "in", part)
        .where((eb) => eb.or([eb("reference", "is not", null), eb("reason", "is not", null)])),
    );
  }
  return orders.length;
}
