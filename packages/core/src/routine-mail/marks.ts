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
import { sha256Hex } from "../digest.ts";

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
  let out: Standing = standings[0] ?? "person";
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
  return sha256Hex(normalForm(value));
}

type Db = Kysely<CoreDatabase>;

/** Bytes of JSON per marks statement (D1 caps one bound value at 2 MB). */
const MARKS_CHUNK_BYTES = 500_000;

type Pending = Map<string, { h: string; s: Standing }>;
const keyOf = (o: string, r: string, f: string) => `${o}\u0000${r}\u0000${f}`;

/** The mark of one of a Person's addresses, and of which address is their primary one. */
export const addressField = (address: string) => `emails:${address.trim().toLowerCase()}`;
export const PRIMARY_ADDRESS = "emails:$primary";

/**
 * The mark of one of a Person's phone numbers (ADR 0673), by its digits (and a leading +, as
 * `core_person_phones.number_normalised`), and of which number is their primary one.
 */
export const phoneField = (number: string) => `phones:${phoneDigits(number)}`;
export const PRIMARY_PHONE = "phones:$primary";

/** A number as the host matches it: a leading + kept, every other character but digits dropped. */
export function phoneDigits(number: string): string {
  const trimmed = number.trim();
  return (trimmed.startsWith("+") ? "+" : "") + trimmed.replace(/\D/g, "");
}

/** The numbers of a Person's phone list (`[{ number, primary }]`), as digits, and the primary. */
function phonesOf(list: unknown): { all: string[]; primary: string | null } {
  if (!Array.isArray(list)) return { all: [], primary: null };
  const rows = list
    .map((v) =>
      typeof v === "string"
        ? { number: v, primary: false }
        : typeof v === "object" && v
          ? {
              number: (v as { number?: unknown }).number,
              primary: (v as { primary?: unknown }).primary === true,
            }
          : null,
    )
    .filter((v): v is { number: string; primary: boolean } => typeof v?.number === "string")
    .map((v) => ({ number: phoneDigits(v.number), primary: v.primary }))
    .filter((v) => v.number.replace("+", "") !== "");
  const primary = rows.find((r) => r.primary)?.number ?? rows[0]?.number ?? null;
  return { all: [...new Set(rows.map((r) => r.number))], primary };
}

/** The addresses of a Person's address list (`[{ email, primary }]`), folded, and the primary. */
function addressesOf(list: unknown): { all: string[]; primary: string | null } {
  if (!Array.isArray(list)) return { all: [], primary: null };
  const rows = list
    .map((v) =>
      typeof v === "string"
        ? { email: v, primary: false }
        : typeof v === "object" && v
          ? {
              email: (v as { email?: unknown }).email,
              primary: (v as { primary?: unknown }).primary === true,
            }
          : null,
    )
    .filter((v): v is { email: string; primary: boolean } => typeof v?.email === "string")
    .map((v) => ({ email: v.email.trim().toLowerCase(), primary: v.primary }));
  const primary = rows.find((r) => r.primary)?.email ?? rows[0]?.email ?? null;
  return { all: [...new Set(rows.map((r) => r.email))], primary };
}

/**
 * Sources' standings, read once per batch: a source's mark, when the mark is for the value it had;
 * else the host's. A mark this same batch writes (a series changed with the classes it moves) is
 * the one that counts. Memoised per (object, record, field, value), so a series' hundreds of
 * classes read each series field once.
 */
class SourceMarks {
  readonly #db: Db;
  readonly #seen = new Map<string, Promise<Standing>>();
  constructor(
    db: Db,
    readonly pending: Pending,
  ) {
    this.#db = db;
  }

  async of(source: MarkSource): Promise<Standing> {
    const hash = await valueHash(source.value);
    const key = keyOf(source.object, source.id, source.field);
    const queued = this.pending.get(key);
    if (queued) return queued.h === hash ? queued.s : "host";
    const memo = `${key}\u0000${hash}`;
    let found = this.#seen.get(memo);
    if (!found) {
      found = this.#read(source, hash);
      this.#seen.set(memo, found);
    }
    return found;
  }

  async #read(source: MarkSource, hash: string): Promise<Standing> {
    const mark = await this.#db
      .selectFrom("core_value_mark")
      .select(["standing", "value_hash"])
      .where("object_type", "=", source.object)
      .where("record_id", "=", source.id)
      .where("field", "=", source.field)
      .executeTakeFirst();
    if (!mark || mark.value_hash !== hash) return "host";
    return mark.standing;
  }
}

/** One change as the pipeline records it, for its marks. */
export interface MarkedChange {
  object: string;
  id: string;
  action: string;
  /** Field → value after the change. */
  after: Record<string, unknown>;
  /** Field → value before it (an update's changed fields). */
  before?: Record<string, unknown> | undefined;
  marks?: ChangeMarks | undefined;
}

/**
 * The marks of a batch of changes, to commit with them: each field's value, who stands behind it
 * (the caller's standing, its sources' for a copy, the host's for what the host filled), and a
 * creation's `$created`. A Person's addresses are marked one by one (`emails:<address>`, and
 * which is primary): an address keeps the mark of whoever added it, whoever rewrites the list
 * later. `given` (a tool a person ran, ADR 0590): values that equal what the person gave the
 * tool are the person's, though the run writes as the host.
 */
export async function markStatements(
  db: Db,
  changes: readonly MarkedChange[],
  standing: Standing,
  byId: string | null,
  now: string,
  given?: ReadonlySet<string>,
): Promise<Compilable[]> {
  const out: Compilable[] = [];
  type Row = { o: string; r: string; f: string; h: string; s: Standing };
  const all: Row[] = [];
  const pending: Pending = new Map();
  const sources = new SourceMarks(db, pending);
  const copies: { row: Row; sources: MarkSource[] }[] = [];
  const own = (value: unknown, s: Standing): Standing => {
    // A person's own given values are theirs only in a run that writes as the host (a shipped
    // pack's tool): never in an AI's run (the fifth review).
    if (s !== "host" || standing !== "host" || !given?.size) return s;
    const form = normalForm(value);
    return form && given.has(form) ? "person" : s;
  };
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
      } else if (!copied?.length) {
        s = own(value, s);
      }
      const row: Row = { o: change.object, r: change.id, f: field, h: await valueHash(value), s };
      all.push(row);
      if (copied?.length) copies.push({ row, sources: copied });
      else pending.set(keyOf(row.o, row.r, row.f), { h: row.h, s: row.s });
      if (change.object === "person" && field === "phones") {
        // Each number its own mark, as each address (ADR 0673): an added one is marked as the
        // list's value would be; one already there keeps its mark; a removed one loses it. A
        // number is textable only when its mark is a person's or a default's (or the member
        // checked it by code): never an AI's.
        const before = phonesOf(change.before?.phones);
        const after = phonesOf(value);
        for (const gone of before.all.filter((n) => !after.all.includes(n))) {
          out.push(
            db
              .deleteFrom("core_value_mark")
              .where("object_type", "=", "person")
              .where("record_id", "=", change.id)
              .where("field", "=", phoneField(gone)),
          );
        }
        const marked = [...after.all.filter((n) => !before.all.includes(n))].map(
          (n) => [phoneField(n), n] as const,
        );
        if (after.primary && (after.primary !== before.primary || change.action !== "update")) {
          marked.push([PRIMARY_PHONE, after.primary]);
        }
        for (const [f, n] of marked) {
          const r: Row = {
            o: "person",
            r: change.id,
            f,
            h: await valueHash(n),
            s: copied?.length ? s : own(n, s),
          };
          all.push(r);
          const from = (copied ?? [])
            .filter((c) =>
              f === PRIMARY_PHONE
                ? phonesOf(c.value).primary === n
                : phonesOf(c.value).all.includes(n),
            )
            .map((c) => ({ ...c, field: f, value: n }));
          if (copied?.length) copies.push({ row: r, sources: from.length ? from : copied });
          else pending.set(keyOf(r.o, r.r, r.f), { h: r.h, s: r.s });
        }
        continue;
      }
      if (change.object !== "person" || field !== "emails") continue;
      // Each address its own mark: an added one is marked as the list's value would be (a merge's
      // from the Person it came from); one already there keeps its mark; a removed one loses it.
      const before = addressesOf(change.before?.emails);
      const after = addressesOf(value);
      for (const gone of before.all.filter((a) => !after.all.includes(a))) {
        out.push(
          db
            .deleteFrom("core_value_mark")
            .where("object_type", "=", "person")
            .where("record_id", "=", change.id)
            .where("field", "=", addressField(gone)),
        );
      }
      const added = after.all.filter((a) => !before.all.includes(a));
      for (const address of added) {
        const r: Row = {
          o: "person",
          r: change.id,
          f: addressField(address),
          h: await valueHash(address),
          s: copied?.length ? s : own(address, s),
        };
        all.push(r);
        const from = (copied ?? [])
          .filter((c) => addressesOf(c.value).all.includes(address))
          .map((c) => ({ ...c, field: addressField(address), value: address }));
        if (copied?.length) copies.push({ row: r, sources: from.length ? from : copied });
        else pending.set(keyOf(r.o, r.r, r.f), { h: r.h, s: r.s });
      }
      if (after.primary && (after.primary !== before.primary || change.action !== "update")) {
        const r: Row = {
          o: "person",
          r: change.id,
          f: PRIMARY_ADDRESS,
          h: await valueHash(after.primary),
          s: copied?.length ? s : own(after.primary, s),
        };
        all.push(r);
        const from = (copied ?? [])
          .filter((c) => addressesOf(c.value).primary === after.primary)
          .map((c) => ({ ...c, field: PRIMARY_ADDRESS, value: after.primary }));
        if (copied?.length) copies.push({ row: r, sources: from.length ? from : copied });
        else pending.set(keyOf(r.o, r.r, r.f), { h: r.h, s: r.s });
      }
    }
  }
  for (const { row, sources: from } of copies) {
    const of = await Promise.all(from.map((c) => sources.of(c)));
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

/** The normal forms of the leaf values a person gave a tool, for `markStatements`' `given`. */
export function givenValues(input: unknown): Set<string> {
  const out = new Set<string>();
  const visit = (v: unknown, depth: number) => {
    if (depth > 8 || out.size > 500) return;
    if (Array.isArray(v)) {
      const form = normalForm(v);
      if (form) out.add(form);
      for (const item of v) visit(item, depth + 1);
    } else if (v && typeof v === "object") {
      for (const item of Object.values(v)) visit(item, depth + 1);
    } else {
      const form = normalForm(v);
      if (form) out.add(form);
      if (typeof v === "string") out.add(v.trim().toLowerCase());
    }
  };
  visit(input, 0);
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

/**
 * What a tool called from a run carries in its caller (ADR 0590, the fourth review): the calling
 * run's standing and its person's given values, so the called tool writes no better than it.
 */
export function callerMarks(ctx: {
  actor: string;
  markStanding?: Standing | undefined;
  markGiven?: ReadonlySet<string> | undefined;
}): { markStanding?: "host" | "ai"; markGiven?: string[] } {
  if (ctx.actor !== "extension" && ctx.actor !== "automation") return {};
  const ai = ctx.markStanding === "ai";
  return {
    markStanding: ai ? "ai" : "host",
    ...(ctx.markGiven && !ai ? { markGiven: [...ctx.markGiven] } : {}),
  };
}

/**
 * Who stands behind what a tool run writes (ADR 0590, the third and fourth reviews): an AI's
 * call, a runtime extension's tool (its code was authored in the app, perhaps by an AI), or a
 * tool called by an AI's run, write as an AI; a shipped pack's tool as the host. Either way the
 * values the person who ran it gave it (or who approved an AI's call, never the adjudicator) are
 * theirs; a tool called by another run takes that run's person's values, never its own input.
 */
export function toolRunStanding(
  caller: {
    actor: string;
    principal?: unknown;
    approvedBy?: string | undefined;
    markStanding?: "host" | "ai" | undefined;
    markGiven?: readonly string[] | undefined;
  },
  source: string,
  input: unknown,
): { standing: "host" | "ai"; given?: Set<string> } {
  const approved = Boolean(caller.approvedBy && caller.approvedBy !== "adjudicator");
  const ai =
    caller.markStanding === "ai" ||
    source !== "shipped" ||
    (!caller.principal && (caller.actor === "assistant" || caller.actor === "mcp") && !approved);
  const fromRun = caller.actor === "extension" || caller.actor === "automation";
  const given = fromRun
    ? caller.markGiven
      ? new Set(caller.markGiven)
      : undefined
    : !caller.principal && (caller.actor === "human" || approved)
      ? givenValues(input)
      : undefined;
  // A run that writes as an AI keeps no given values (the fifth review): a runtime extension's
  // code could copy what the person typed into any field of any record.
  return { standing: ai ? "ai" : "host", ...(given && !ai ? { given } : {}) };
}
