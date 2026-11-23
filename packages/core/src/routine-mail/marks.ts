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
import type { Compilable, Kysely } from "kysely";

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

/** A source's standing: its mark, when the mark is for the value it had; else the host's. */
async function sourceStanding(db: Db, source: MarkSource): Promise<Standing> {
  const mark = await db
    .selectFrom("core_value_mark")
    .select(["standing", "value_hash"])
    .where("object_type", "=", source.object)
    .where("record_id", "=", source.id)
    .where("field", "=", source.field)
    .executeTakeFirst();
  if (!mark || mark.value_hash !== (await valueHash(source.value))) return "host";
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
    const rows: { field: string; value: unknown; standing: Standing }[] = [];
    for (const [field, value] of Object.entries(change.after)) {
      const copied = change.marks?.copied?.[field];
      let s: Standing = standing;
      if (copied?.length) {
        const of = await Promise.all(copied.map((c) => sourceStanding(db, c)));
        s = weakest([...of, ...(standing === "ai" ? (["ai"] as const) : [])]);
      } else if (defaulted.has(field))
        s = weakest(["default", standing === "ai" ? "ai" : "default"]);
      else if (host.has(field)) s = weakest(["host", standing]);
      rows.push({ field, value, standing: s });
    }
    if (change.action === "create" || change.action === "restore") {
      rows.push({ field: CREATED, value: "", standing });
    }
    for (const row of rows) {
      const value_hash = await valueHash(row.value);
      out.push(
        db
          .insertInto("core_value_mark")
          .values({
            object_type: change.object,
            record_id: change.id,
            field: row.field,
            value_hash,
            standing: row.standing,
            by_id: byId,
            at: now,
          })
          .onConflict((oc) =>
            oc
              .columns(["object_type", "record_id", "field"])
              .doUpdateSet({ value_hash, standing: row.standing, by_id: byId, at: now }),
          ),
      );
    }
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
