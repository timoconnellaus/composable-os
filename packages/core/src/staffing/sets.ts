// Set-based reads for the roster's screens and the import's dry run (stage 45 step 7, ADR 0629): the
// same facts as the per-person checks in index.ts (claims, unavailability, qualifications, profiles,
// titles), read once for every person and the whole range an answer covers, then checked in memory.
// A D1 invocation may run at most 1,000 queries (ADRs 0240, 0435 and 0448), so an answer over many
// people or dates must never read per person or per date.
//
// The rules are the same functions as the writes': a clash is a claim that overlaps (half-open
// ranges), away is a one-off range or a regular rule (`regularOverlaps`), qualified is a row for the
// kind, or no row at all for the kind's object when not strict (ADR 0622).
import { sql } from "kysely";
import { ValidationError } from "../errors.ts";
import { objectTableOf } from "../extensions/schema.ts";
import { getObject } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import { jsonList } from "../records/common.ts";
import { orgReader, visibleSource } from "../visibility/index.ts";
import { regularOverlaps } from "./index.ts";

// biome-ignore lint/suspicious/noExplicitAny: x_* tables are not in CoreDatabase; names come from the registry.
type AnyDb = import("kysely").Kysely<any>;

/** Accounts per `IN (…)` list. */
const CHUNK = 100;
/** The most rows one set-based read takes before the answer is refused as too large. */
export const SET_ROWS_MAX = 20_000;

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const secondsOf = (value: unknown): number | null => {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

function tooLarge(): ValidationError {
  return new ValidationError(
    "There is too much on the roster in this range to check at once: ask for fewer people or dates.",
    { rule: "too_large" },
  );
}

export interface HeldClaim {
  object: string;
  id: string;
  /** The claim, margins included (ADR 0760). */
  starts: number;
  ends: number;
  /** The shift's own time, without them. */
  own: { starts: number; ends: number };
}

/** Every claim of `accounts` overlapping `lo`..`hi` (unix seconds), by account. */
export async function claimsOf(
  ctx: HandlerContext,
  accounts: readonly string[],
  lo: number,
  hi: number,
): Promise<Map<string, HeldClaim[]>> {
  const out = new Map<string, HeldClaim[]>();
  let rows = 0;
  for (const part of chunks([...new Set(accounts)])) {
    const found = await ctx.db
      .selectFrom("core_staff_time")
      .select([
        "account_id",
        "object_type",
        "record_id",
        "starts",
        "ends",
        "margin_before",
        "margin_after",
      ])
      .where("account_id", "in", jsonList(part))
      .where("starts", "<", hi)
      .where("ends", ">", lo)
      .limit(SET_ROWS_MAX + 1)
      .execute();
    rows += found.length;
    if (rows > SET_ROWS_MAX) throw tooLarge();
    for (const r of found) {
      const list = out.get(r.account_id) ?? [];
      list.push({
        object: r.object_type,
        id: r.record_id,
        starts: r.starts,
        ends: r.ends,
        own: { starts: r.starts + r.margin_before, ends: r.ends - r.margin_after },
      });
      out.set(r.account_id, list);
    }
  }
  return out;
}

/** The claim in `held` overlapping `starts`..`ends`, other than the record `self`, or null. */
export function clashIn(
  held: readonly HeldClaim[] | undefined,
  starts: number,
  ends: number,
  self?: { object: string; id: string },
): HeldClaim | null {
  for (const c of held ?? []) {
    if (self && c.object === self.object && c.id === self.id) continue;
    if (c.starts < ends && c.ends > starts) return c;
  }
  return null;
}

type AwayRow = {
  id: string;
  account_id: string;
  kind: string;
  starts_at: string | null;
  ends_at: string | null;
  weekdays: string | null;
  start_time: string | null;
  end_time: string | null;
  from_date: string | null;
  until_date: string | null;
  zone: string;
};

/** Every unavailability of `accounts` that can overlap `lo`..`hi`, by account. */
export async function awayRowsOf(
  ctx: HandlerContext,
  accounts: readonly string[],
  lo: number,
  hi: number,
): Promise<Map<string, AwayRow[]>> {
  const out = new Map<string, AwayRow[]>();
  // Regular rules not ended before the range's first local date (two days early, for any zone).
  const firstDate = iso(lo - 2 * 86_400).slice(0, 10);
  let rows = 0;
  for (const part of chunks([...new Set(accounts)])) {
    const found = (await ctx.db
      .selectFrom("core_staff_away")
      .select([
        "id",
        "account_id",
        "kind",
        "starts_at",
        "ends_at",
        "weekdays",
        "start_time",
        "end_time",
        "from_date",
        "until_date",
        "zone",
      ])
      .where("account_id", "in", jsonList(part))
      .where((eb) =>
        eb.or([
          eb.and([
            eb("kind", "!=", "regular"),
            eb("ends_at", ">", iso(lo)),
            eb("starts_at", "<", iso(hi)),
          ]),
          eb.and([
            eb("kind", "=", "regular"),
            eb.or([eb("until_date", "is", null), eb("until_date", ">=", firstDate)]),
          ]),
        ]),
      )
      .limit(SET_ROWS_MAX + 1)
      .execute()) as AwayRow[];
    rows += found.length;
    if (rows > SET_ROWS_MAX) throw tooLarge();
    for (const r of found) {
      const list = out.get(r.account_id) ?? [];
      list.push(r);
      out.set(r.account_id, list);
    }
  }
  return out;
}

/** Whether one of `rows` overlaps `starts`..`ends` (as `awayOver` decides it). */
export function awayIn(
  rows: readonly AwayRow[] | undefined,
  starts: number,
  ends: number,
): boolean {
  for (const row of rows ?? []) {
    if (row.kind !== "regular") {
      const from = secondsOf(row.starts_at);
      const until = secondsOf(row.ends_at);
      if (from !== null && until !== null && from < ends && until > starts) return true;
      continue;
    }
    if (regularOverlaps(row, starts, ends)) return true;
  }
  return false;
}

/**
 * Who of `accounts` is qualified for the kind `kind` of `kindObject`: `strict` (a take's rule: a
 * row), and `warned` (a write's rule: a row, or no row at all for the kind's object). A kind in
 * the Trash or gone qualifies nobody. Three reads, however many accounts.
 */
export async function qualifiedOf(
  ctx: HandlerContext,
  kindObject: string,
  kind: string,
  accounts: readonly string[],
): Promise<{ strict: Set<string>; notWarned: (account: string) => boolean }> {
  const target = getObject(kindObject);
  const live = target
    ? Boolean(
        await ctx.db
          .selectFrom(visibleSource(orgReader(ctx.db), target))
          .select("id")
          .where("id", "=", kind)
          .executeTakeFirst(),
      )
    : false;
  const marked = new Set<string>();
  for (const part of chunks([...new Set(accounts)])) {
    const rows = await ctx.db
      .selectFrom("core_staff_qualification")
      .select("account_id")
      .where("kind_object", "=", kindObject)
      .where("kind_record", "=", kind)
      .where("account_id", "in", jsonList(part))
      .execute();
    for (const r of rows) marked.add(r.account_id);
  }
  const any = await ctx.db
    .selectFrom("core_staff_qualification")
    .select("kind_record")
    .where("kind_object", "=", kindObject)
    .limit(1)
    .executeTakeFirst();
  const strict = live ? marked : new Set<string>();
  // Not warned (as `qualified` decides it): marked for a live kind, or nobody is marked for this
  // kind's object at all (ADR 0622).
  return { strict, notWarned: (account) => (marked.has(account) ? live : !any) };
}

/**
 * Whether each account is warned as not qualified for each kind (as `qualified` decides it, not
 * strict), for many accounts and kinds at once: their marks in one read per hundred accounts,
 * which kinds' objects have any mark at all in one, and which kinds are live in one per kind
 * object.
 */
export async function notQualifiedOf(
  ctx: HandlerContext,
  accounts: readonly string[],
  kinds: readonly { object: string; id: string }[],
): Promise<(account: string, kind: { object: string; id: string }) => boolean> {
  const key = (a: string, o: string, k: string) => `${a}\u0000${o}\u0000${k}`;
  const marked = new Set<string>();
  for (const part of chunks([...new Set(accounts)])) {
    const rows = await ctx.db
      .selectFrom("core_staff_qualification")
      .select(["account_id", "kind_object", "kind_record"])
      .where("account_id", "in", jsonList(part))
      .limit(SET_ROWS_MAX + 1)
      .execute();
    if (rows.length > SET_ROWS_MAX) throw tooLarge();
    for (const r of rows) marked.add(key(r.account_id, r.kind_object, r.kind_record));
  }
  const objects = [...new Set(kinds.map((k) => k.object))];
  const withAny = new Set(
    objects.length
      ? (
          await ctx.db
            .selectFrom("core_staff_qualification")
            .select("kind_object")
            .distinct()
            .where("kind_object", "in", jsonList(objects))
            .execute()
        ).map((r) => r.kind_object)
      : [],
  );
  const live = new Set<string>();
  for (const object of objects) {
    const target = getObject(object);
    if (!target) continue;
    const ids = [...new Set(kinds.filter((k) => k.object === object).map((k) => k.id))];
    for (const part of chunks(ids)) {
      const rows = (await ctx.db
        .selectFrom(visibleSource(orgReader(ctx.db), target))
        .select("id")
        .where("id", "in", jsonList(part))
        .execute()) as { id: string }[];
      for (const r of rows) live.add(`${object}\u0000${r.id}`);
    }
  }
  return (account, kind) =>
    marked.has(key(account, kind.object, kind.id))
      ? !live.has(`${kind.object}\u0000${kind.id}`)
      : withAny.has(kind.object);
}

/**
 * The value of `object`'s person field naming each of `accounts` (a coach profile; the account
 * itself for a user field), in one read per hundred accounts.
 */
export async function profilesOf(
  ctx: HandlerContext,
  object: ObjectDefinition,
  accounts: readonly string[],
): Promise<Map<string, string>> {
  const def = object.staffed;
  const out = new Map<string, string>();
  if (!def) return out;
  if (!def.who.account) {
    for (const a of accounts) out.set(a, a);
    return out;
  }
  const holder = def.who.object ? getObject(def.who.object) : undefined;
  const table = holder ? objectTableOf(holder.name) : undefined;
  const column = holder?.fields.find((f) => f.name === def.who.account)?.column;
  if (!table || !column) return out;
  for (const part of chunks([...new Set(accounts)])) {
    const rows = await sql<{ id: string; account: string }>`SELECT id, ${sql.ref(
      column,
    )} AS account FROM ${sql.table(table)} WHERE ${sql.ref(column)} IN ${jsonList(
      part,
    )} AND deleted_at IS NULL ORDER BY id`.execute(ctx.db);
    for (const r of rows.rows) if (!out.has(r.account)) out.set(r.account, r.id);
  }
  return out;
}

/** Each `object`'s record's title by id, one read per object, for every reference given. */
export async function titlesOf(
  ctx: HandlerContext,
  refs: readonly { object: string; id: string }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const byObject = new Map<string, Set<string>>();
  for (const r of refs) byObject.set(r.object, (byObject.get(r.object) ?? new Set()).add(r.id));
  for (const [name, ids] of byObject) {
    const object = getObject(name);
    const table = objectTableOf(name);
    const column = object?.fields.find((f) => f.name === object.titleField)?.column;
    if (!object || !table || !column) continue;
    for (const part of chunks([...ids])) {
      const rows = await (ctx.db as AnyDb)
        .selectFrom(table)
        .select(["id", `${column} as title`])
        .where("id", "in", jsonList(part))
        .execute();
      for (const r of rows as { id: string; title: unknown }[]) {
        out.set(
          `${name}\u0000${r.id}`,
          typeof r.title === "string" && r.title ? r.title : object.label,
        );
      }
    }
  }
  return out;
}

/** Each account's display name, one read per hundred. */
export async function namesOf(
  ctx: HandlerContext,
  accounts: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const part of chunks([...new Set(accounts)])) {
    const rows = await ctx.db
      .selectFrom("core_user")
      .select(["id", "name", "email"])
      .where("id", "in", jsonList(part))
      .execute();
    for (const r of rows) out.set(r.id, r.name || r.email);
  }
  return out;
}

/**
 * The pay basis rows (from a local date, in order) of every account counted by time on some date
 * up to `until` (stage 58, ADR 0851: they are the people a shift with nothing recorded is flagged
 * for), or of `only` when given. One read, whatever the number of people.
 */
export async function timeBasesOf(
  ctx: HandlerContext,
  until: string,
  only?: string,
): Promise<Map<string, { from: string; basis: "by_time" | "by_class" | "not_counted" }[]>> {
  const out = new Map<string, { from: string; basis: "by_time" | "by_class" | "not_counted" }[]>();
  let query = ctx.db
    .selectFrom("core_staff_pay_basis")
    .select(["account_id", "from_date", "basis"])
    .where("from_date", "<=", until)
    .where("account_id", "in", (eb) =>
      eb
        .selectFrom("core_staff_pay_basis")
        .select("account_id")
        .where("basis", "=", "by_time")
        .where("from_date", "<=", until),
    );
  if (only) query = query.where("account_id", "=", only);
  const rows = await query
    .orderBy("account_id")
    .orderBy("from_date")
    .limit(SET_ROWS_MAX + 1)
    .execute();
  if (rows.length > SET_ROWS_MAX) throw tooLarge();
  for (const r of rows) {
    const list = out.get(r.account_id) ?? [];
    list.push({ from: r.from_date, basis: r.basis });
    out.set(r.account_id, list);
  }
  return out;
}

/** Which of the shifts `refs` are marked not worked (ADR 0627), as `object\u0000id`. */
export async function notWorkedOf(
  ctx: HandlerContext,
  refs: readonly { object: string; id: string }[],
): Promise<Set<string>> {
  const out = new Set<string>();
  const byObject = new Map<string, Set<string>>();
  for (const r of refs) byObject.set(r.object, (byObject.get(r.object) ?? new Set()).add(r.id));
  for (const [object, ids] of byObject) {
    const rows = await ctx.db
      .selectFrom("core_staff_not_worked")
      .select("record_id")
      .where("object_type", "=", object)
      .where("record_id", "in", jsonList([...ids]))
      .execute();
    for (const r of rows) out.add(`${object}\u0000${r.record_id}`);
  }
  return out;
}

export { iso as isoOfSeconds };
