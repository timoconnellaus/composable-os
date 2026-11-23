// Who stands behind a value (ADR 0590, after the second security review): default deny with
// positive proof kept by the host. Every write the pipeline records writes, in its own batch, one
// mark per field it set: who stands behind that value, with a SHA-256 of the value, so a mark never
// applies to a different value. Routine mail reads marks only; a value or recipient with no mark,
// a mark for another value, or a mark of the host or an AI is not routine (held for a person).
//
// A copy carries its sources' marks, never a fresh one: the host names, for each field it filled
// from another record (a series' class, a title taken from a class type, a moved booking's fields,
// a merged person's addresses), the fields it came from, and the copy's mark is the weakest of
// theirs. A field the host filled with no source named is the host's (not routine), except a
// declared default (`default`).
import type { CoreDatabase } from "@composable-os/db";
import { type Compilable, CompiledQuery, type Kysely } from "kysely";

export type Standing = "person" | "customer" | "public" | "default" | "host" | "ai";

/** Where a copied value came from: a field of a record, with the value it had. */
export interface MarkSource {
  object: string;
  id: string;
  field: string;
  value: unknown;
}

/** What the host says about a change's fields, for their marks (RecordChange.marks). */
export interface ChangeMarks {
  /** Fields the host filled from other records' fields. */
  copied?: Record<string, MarkSource[]>;
  /** Fields the host filled itself with no source (its own write: not routine). */
  hostFilled?: readonly string[];
  /** Fields filled with their declared default. */
  defaulted?: readonly string[];
}

/** The field a record's creation is marked under. */
export const CREATED = "$created";

const ORDER: Record<Standing, number> = {
  person: 0,
  default: 0,
  customer: 1,
  public: 2,
  host: 3,
  ai: 4,
};

/** The weakest of several standings (an AI's beats the host's beats a buyer's beats a person's). */
export function weakest(standings: readonly Standing[]): Standing {
  let out: Standing = "person";
  for (const s of standings) if (ORDER[s] > ORDER[out]) out = s;
  return out;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/** A value in one form whichever way it was written or read (an address list, an instant). */
export function normalForm(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "string") {
    const t = value.trim();
    if (ISO.test(t)) {
      const ms = Date.parse(t);
      if (Number.isFinite(ms)) return new Date(ms).toISOString();
    }
    return t;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    // An address list ([{ email }] or [string]): the addresses, folded and sorted.
    const emails = value.map((v) =>
      typeof v === "string"
        ? v
        : typeof v === "object" && v
          ? (v as { email?: unknown }).email
          : null,
    );
    if (emails.every((e) => typeof e === "string")) {
      return JSON.stringify((emails as string[]).map((e) => e.trim().toLowerCase()).sort());
    }
  }
  return JSON.stringify(value);
}

export async function valueHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(normalForm(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type Db = Kysely<CoreDatabase>;

/** Bytes of JSON per marks statement (D1 caps one bound value at 2 MB). */
const MARKS_CHUNK_BYTES = 500_000;

type Pending = Map<string, { h: string; s: Standing }>;
const keyOf = (o: string, r: string, f: string) => `${o}\u0000${r}\u0000${f}`;

/**
 * A source's standing: its mark, when the mark is for the value it had; else the host's. A mark
 * this same batch writes (a series changed with the classes it moves) is the one that counts.
 */
async function sourceStanding(db: Db, source: MarkSource, pending: Pending): Promise<Standing> {
  const hash = await valueHash(source.value);
  const queued = pending.get(keyOf(source.object, source.id, source.field));
  if (queued) return queued.h === hash ? queued.s : "host";
  const mark = await db
    .selectFrom("core_value_mark")
    .select(["standing", "value_hash"])
    .where("object_type", "=", source.object)
    .where("record_id", "=", source.id)
    .where("field", "=", source.field)
    .executeTakeFirst();
  if (!mark || mark.value_hash !== hash) return "host";
  return mark.standing;
}

/** One change as the pipeline records it, for its marks. */
export interface MarkedChange {
  object: string;
  id: string;
  action: string;
  /** Field → value after the change. */
  after: Record<string, unknown>;
  marks?: ChangeMarks | undefined;
}

/**
 * The marks of a batch of changes, to commit with them: each field's value, who stands behind it
 * (the caller's standing, its sources' for a copy, the host's for what the host filled), and a
 * creation's `$created`.
 */
export async function markStatements(
  db: Db,
  changes: readonly MarkedChange[],
  standing: Standing,
  byId: string | null,
  now: string,
): Promise<Compilable[]> {
  const out: Compilable[] = [];
  type Row = { o: string; r: string; f: string; h: string; s: Standing };
  const all: Row[] = [];
  const pending: Pending = new Map();
  const copies: { row: Row; sources: MarkSource[] }[] = [];
  // Own values first, then copies: a copy may name a value this batch writes, in any order.
  for (const change of changes) {
    if (change.action === "erase") {
      out.push(
        db
          .deleteFrom("core_value_mark")
          .where("object_type", "=", change.object)
          .where("record_id", "=", change.id),
      );
      continue;
    }
    const host = new Set(change.marks?.hostFilled ?? []);
    const defaulted = new Set(change.marks?.defaulted ?? []);
    const fields = Object.entries(change.after);
    if (change.action === "create" || change.action === "restore") fields.push([CREATED, ""]);
    for (const [field, value] of fields) {
      const copied = change.marks?.copied?.[field];
      let s: Standing = standing;
      if (defaulted.has(field) && !copied?.length) {
        s = weakest(["default", standing === "ai" ? "ai" : "default"]);
      } else if (host.has(field) && !copied?.length) {
        s = weakest(["host", standing]);
      }
      const row: Row = { o: change.object, r: change.id, f: field, h: await valueHash(value), s };
      all.push(row);
      if (copied?.length) copies.push({ row, sources: copied });
      else pending.set(keyOf(row.o, row.r, row.f), { h: row.h, s: row.s });
    }
  }
  for (const { row, sources } of copies) {
    const of = await Promise.all(sources.map((c) => sourceStanding(db, c, pending)));
    row.s = weakest([...of, ...(standing === "ai" ? (["ai"] as const) : [])]);
    pending.set(keyOf(row.o, row.r, row.f), { h: row.h, s: row.s });
  }
  // One statement for the batch's marks (chunked by bytes, as the audit's changes are written:
  // D1 caps one bound value at 2 MB), so a bulk write adds one statement, not one per record.
  const chunks: string[] = [];
  let chunk: typeof all = [];
  let bytes = 0;
  for (const row of all) {
    const size = JSON.stringify(row).length + 1;
    if (chunk.length && bytes + size > MARKS_CHUNK_BYTES) {
      chunks.push(JSON.stringify(chunk));
      chunk = [];
      bytes = 0;
    }
    chunk.push(row);
    bytes += size;
  }
  if (chunk.length) chunks.push(JSON.stringify(chunk));
  for (const json of chunks) {
    out.push(
      CompiledQuery.raw(
        `INSERT INTO core_value_mark (object_type, record_id, field, value_hash, standing, by_id, at)
         SELECT json_extract(j.value, '$.o'), json_extract(j.value, '$.r'),
           json_extract(j.value, '$.f'), json_extract(j.value, '$.h'),
           json_extract(j.value, '$.s'), ?, ? FROM json_each(?) j WHERE true
         ON CONFLICT (object_type, record_id, field) DO UPDATE SET value_hash = excluded.value_hash,
           standing = excluded.standing, by_id = excluded.by_id, at = excluded.at`,
        [byId, now, json],
      ) as unknown as Compilable,
    );
  }
  return out;
}

/**
 * A person's approval of a held routine email (approval.approve): the values it showed, as they
 * were when it was prepared, are a person's from now on. A value changed since keeps its own mark:
 * its hash is not the one the email showed, so the approval cannot reach it.
 */
export async function approvalMarkStatements(
  db: Db,
  shown: readonly { o: string; r: string; f: string; h: string }[],
  approverId: string,
  now: string,
): Promise<Compilable[]> {
  const out: Compilable[] = [];
  for (const s of shown) {
    const current = await db
      .selectFrom("core_value_mark")
      .select("value_hash")
      .where("object_type", "=", s.o)
      .where("record_id", "=", s.r)
      .where("field", "=", s.f)
      .executeTakeFirst();
    // Only the value as shown: a newer write (another hash) is left as it is.
    if (current && current.value_hash !== s.h) continue;
    out.push(
      db
        .insertInto("core_value_mark")
        .values({
          object_type: s.o,
          record_id: s.r,
          field: s.f,
          value_hash: s.h,
          standing: "person",
          by_id: approverId,
          at: now,
        })
        .onConflict((oc) =>
          oc
            .columns(["object_type", "record_id", "field"])
            .doUpdateSet({ standing: "person", by_id: approverId, at: now })
            .where("core_value_mark.value_hash", "=", s.h),
        ),
    );
  }
  return out;
}
