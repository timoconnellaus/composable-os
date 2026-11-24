// The roster read (stage 45 step 4, ADR 0626): every live shift of every object declaring
// `staffed`, in a range, with only what a roster shows: the kind's name, the title, the times and
// zone, the place, the person's name (and whether it is the reader), whether it has nobody on it,
// its open offer, and, for a rosterer only, its warnings. Never a class's bookings, places taken,
// its list or any Person: so a coach whose role reaches class lists only today sees the whole
// future roster through Rostering's grant, and nothing the role protects. A shift whose title may
// name a client (`staffed.private`, an appointment, ADR 0761) shows its kind's name (the service)
// as its title to anyone but its own person and those who roster.
//
// Read as the host, set-based: one read per staffed object for its shifts, then one each for the
// people, the kinds' names, the places and the open offers; the warnings from one read of the
// qualifications and one of the unavailabilities of the people on it. A range is at most 62 days.
import { type RawBuilder, sql } from "kysely";
import { declaredOf, recordFacts, templateCopies, usable } from "../checklists/index.ts";
import { objectTableOf } from "../extensions/schema.ts";
import { getObject, listObjects } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import { jsonList } from "../records/common.ts";
import { orgReader, visibleSource } from "../visibility/index.ts";
import type { StaffWarning } from "./index.ts";
import { regularOverlaps } from "./index.ts";
import { kindObjectOf } from "./kinds.ts";

/** One shift on the roster. */
export interface RosterShift {
  object: string;
  id: string;
  title: string;
  kind: { object: string; id: string; name: string } | null;
  startsAt: string;
  endsAt: string | null;
  zone: string | null;
  place: string | null;
  /** Nobody on it. */
  uncovered: boolean;
  /** Its person has no staff account (a visiting coach): covered for members, on nobody's roster. */
  noAccount: boolean;
  account: string | null;
  name: string | null;
  /** Its person is the reader. */
  mine: boolean;
  offer: { id: string; to: string | null; from: string | null } | null;
  /** A rosterer's read only (null otherwise). */
  warnings: StaffWarning[] | null;
  /**
   * Its checklist (stage 45 step 4b, ADR 0650), or null when it has none. Everyone sees that it
   * has one and its name; how it is going (`state`) only its person and those who roster, at the
   * screen (null for anyone else, and for any AI).
   */
  checklist: { name: string; state: ChecklistState | null } | null;
}

/** How a shift's checklist is going, as the roster shows it. */
export type ChecklistState = "not_started" | "in_progress" | "done" | "missed" | "cancelled";

/** The most shifts one object gives one read; more, and the answer says it was cut short. */
const PER_OBJECT = 1000;

// biome-ignore lint/suspicious/noExplicitAny: x_* tables are not in CoreDatabase; names come from the registry.
type AnyDb = import("kysely").Kysely<any>;

const column = (object: ObjectDefinition, field: string | undefined) =>
  (field && object.fields.find((f) => f.name === field)?.column) || null;
const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
const seconds = (value: unknown): number | null => {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};

/** Each record's title (its object's title field) by id, read once for all of `ids`. */
export async function titles(
  ctx: Pick<HandlerContext, "db">,
  objectName: string,
  ids: readonly string[],
  field?: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const object = getObject(objectName);
  const table = objectTableOf(objectName);
  const col = object ? column(object, field ?? object.titleField) : null;
  if (!object || !table || !col || !ids.length) return out;
  const rows = await sql<{ id: string; title: string | null }>`SELECT id, ${sql.ref(
    col,
  )} AS title FROM ${sql.table(table)} WHERE id IN ${jsonList([...new Set(ids)])}`.execute(ctx.db);
  for (const r of rows.rows) if (r.title !== null) out.set(r.id, String(r.title));
  return out;
}

/**
 * The roster from `from` to `to` (unix seconds, half-open by start), every staffed object's live
 * shifts in order of start; `account` keeps only that person's. `reader` is whose roster it is;
 * `warnings` gives each shift its warnings (a rosterer's read).
 */
export async function rosterRange(
  ctx: HandlerContext,
  range: { from: number; to: number; account?: string | undefined },
  reader: string,
  options: {
    warnings: boolean;
    uncoveredDays: number;
    /** Whose checklists' states the reader sees: everyone's (a rosterer), their own, or none. */
    checklists?: "all" | "own" | "none";
    /** The reader rosters, so sees a private shift's own title (ADR 0761); else only their own. */
    clients?: boolean;
  },
): Promise<{ shifts: RosterShift[]; truncated: boolean }> {
  const out: RosterShift[] = [];
  let truncated = false;
  const lo = new Date((range.from - 86_400) * 1000).toISOString();
  const hi = new Date((range.to + 86_400) * 1000).toISOString();
  const people = new Map<string, string>();
  for (const object of listObjects()) {
    const def = object.staffed;
    const table = def ? objectTableOf(object.name) : undefined;
    const who = def ? column(object, def.who.field) : null;
    const starts = def ? column(object, def.starts) : null;
    const ends = def ? column(object, def.ends) : null;
    const state = column(object, object.states?.field);
    if (!def || !table || !who || !starts || !ends || !state) continue;
    const kindCol = column(object, def.kind);
    const zoneCol = column(object, def.zone);
    const titleCol = column(object, object.titleField);
    const [placeField, placeOf] = (def.place ?? "").split(".") as [string, string | undefined];
    const placeCol = def.place ? column(object, placeField) : null;
    // Whose each shift is: the user field itself, or its holder's account (a coach profile's).
    const holder = def.who.account && def.who.object ? getObject(def.who.object) : undefined;
    const holderTable = holder ? objectTableOf(holder.name) : undefined;
    const holderCol = holder ? column(holder, def.who.account) : null;
    const holders = async (where: RawBuilder<unknown>) => {
      if (!holderTable || !holderCol) return new Map<string, string | null>();
      const found = await sql<{ id: string; account: string | null }>`SELECT id, ${sql.ref(
        holderCol,
      )} AS account FROM ${sql.table(holderTable)} WHERE ${where}`.execute(ctx.db);
      return new Map(found.rows.map((h) => [h.id, text(h.account)]));
    };
    // One person's roster is filtered here, before the limit, so their later shifts are not cut
    // off by everyone else's.
    let whose = sql`1 = 1`;
    let accountOf: Map<string, string | null> | null = null;
    if (range.account !== undefined) {
      if (!def.who.account) whose = sql`${sql.ref(who)} = ${range.account}`;
      else {
        if (!holderCol) continue;
        accountOf = await holders(sql`${sql.ref(holderCol)} = ${range.account}`);
        if (!accountOf.size) continue;
        whose = sql`${sql.ref(who)} IN ${jsonList([...accountOf.keys()])}`;
      }
    }
    const rows = await sql<{
      id: string;
      who: string | null;
      starts: string;
      ends: string | null;
      kind: string | null;
      zone: string | null;
      title: string | null;
      place: string | null;
    }>`SELECT id, ${sql.ref(who)} AS who, ${sql.ref(starts)} AS starts, ${sql.ref(ends)} AS ends,
      ${kindCol ? sql.ref(kindCol) : sql`NULL`} AS kind, ${zoneCol ? sql.ref(zoneCol) : sql`NULL`} AS zone,
      ${titleCol ? sql.ref(titleCol) : sql`NULL`} AS title, ${placeCol ? sql.ref(placeCol) : sql`NULL`} AS place
      FROM ${sql.table(table)}
      WHERE deleted_at IS NULL AND ${sql.ref(state)} IN (${sql.join(def.live.map((s) => sql`${s}`))})
        AND ${sql.ref(starts)} >= ${lo} AND ${sql.ref(starts)} < ${hi}
        AND CAST(strftime('%s', ${sql.ref(starts)}) AS INTEGER) >= ${range.from}
        AND CAST(strftime('%s', ${sql.ref(starts)}) AS INTEGER) < ${range.to}
        AND ${whose}
      ORDER BY ${sql.ref(starts)} LIMIT ${PER_OBJECT + 1}`.execute(ctx.db);
    if (!rows.rows.length) continue;
    // More than one read gives: the answer says it was cut short (ask for fewer days).
    if (rows.rows.length > PER_OBJECT) {
      truncated = true;
      rows.rows.length = PER_OBJECT;
    }
    if (!accountOf && def.who.account) {
      const ids = [...new Set(rows.rows.map((r) => r.who).filter((w): w is string => !!w))];
      accountOf = ids.length ? await holders(sql`id IN ${jsonList(ids)}`) : new Map();
    }
    const kindObject = kindObjectOf(object);
    const kindNames = kindObject
      ? await titles(
          ctx,
          kindObject,
          rows.rows.map((r) => r.kind).filter((k): k is string => !!k),
        )
      : new Map<string, string>();
    const placeTarget = placeOf
      ? object.fields.find((f) => f.name === placeField)?.options?.to
      : undefined;
    const placeNames =
      placeTarget && placeOf
        ? await titles(
            ctx,
            placeTarget,
            rows.rows.map((r) => r.place).filter((p): p is string => !!p),
            placeOf,
          )
        : new Map<string, string>();
    for (const r of rows.rows) {
      const covered = text(r.who) !== null;
      const account = !covered
        ? null
        : def.who.account
          ? (accountOf?.get(r.who as string) ?? null)
          : text(r.who);
      if (range.account !== undefined && account !== range.account) continue;
      if (account) people.set(account, "");
      const kindName = r.kind ? kindNames.get(r.kind) || null : null;
      // A private shift's title may name its client: its kind's name instead (ADR 0761).
      const hidden = def.private === true && !options.clients && !(account && account === reader);
      out.push({
        object: object.name,
        id: r.id,
        title: (hidden ? kindName : text(r.title)) ?? object.label,
        kind:
          kindObject && r.kind
            ? { object: kindObject, id: r.kind, name: kindNames.get(r.kind) ?? "" }
            : null,
        startsAt: new Date(r.starts).toISOString(),
        endsAt: r.ends ? new Date(r.ends).toISOString() : null,
        zone: text(r.zone),
        place: placeOf ? (r.place ? (placeNames.get(r.place) ?? null) : null) : text(r.place),
        uncovered: !covered,
        noAccount: covered && account === null,
        account,
        name: null,
        mine: account !== null && account === reader,
        offer: null,
        warnings: null,
        checklist: null,
      });
    }
  }
  // The people's names, once.
  if (people.size) {
    const users = await ctx.db
      .selectFrom("core_user")
      .select(["id", "name", "email"])
      .where("id", "in", jsonList([...people.keys()]))
      .execute();
    for (const u of users) people.set(u.id, u.name || u.email);
  }
  for (const s of out) if (s.account) s.name = people.get(s.account) || null;
  // Open offers, once per object.
  for (const objectName of new Set(out.map((s) => s.object))) {
    const ids = out.filter((s) => s.object === objectName).map((s) => s.id);
    const offers = await ctx.db
      .selectFrom("core_staff_offer")
      .select(["id", "record_id", "to_account", "from_account"])
      .where("state", "=", "open")
      .where("object_type", "=", objectName)
      .where("record_id", "in", jsonList(ids))
      .execute();
    const byRecord = new Map(offers.map((o) => [o.record_id, o]));
    for (const s of out) {
      if (s.object !== objectName) continue;
      const o = byRecord.get(s.id);
      if (o) s.offer = { id: o.id, to: o.to_account, from: o.from_account };
    }
  }
  if (options.warnings) await addWarnings(ctx, out, options.uncoveredDays);
  await addChecklists(ctx, out, reader, options.checklists ?? "none");
  return {
    shifts: out.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id)),
    truncated,
  };
}

/**
 * Each shift's checklist (ADR 0650), set-based: per object that declares `checklists`, one read of
 * its shifts' templates, one of their runs (with how many steps are ticked), and one of the
 * templates' names. The state only for whom `who` lets see it.
 */
async function addChecklists(
  ctx: HandlerContext,
  shifts: RosterShift[],
  reader: string,
  who: "all" | "own" | "none",
): Promise<void> {
  for (const objectName of new Set(shifts.map((s) => s.object))) {
    const d = declaredOf(objectName);
    if (!d) continue;
    const mine = shifts.filter((s) => s.object === objectName);
    const ids = mine.map((s) => s.id);
    const facts = await recordFacts(ctx.db, d, ids);
    const runs = await ctx.db
      .selectFrom("core_checklist_run as r")
      .select([
        "r.record_id",
        "r.name",
        "r.state",
        "r.account_id",
        sql<number>`(SELECT count(*) FROM core_checklist_tick t WHERE t.run_id = r.id)`.as(
          "ticked",
        ),
      ])
      .where("r.object_type", "=", objectName)
      .where("r.record_id", "in", jsonList(ids))
      .execute();
    const runOf = new Map(runs.map((r) => [r.record_id, r]));
    const templates = await templateCopies(
      ctx.db,
      [...facts.values()]
        .filter((f) => f.template && !runOf.has(f.id))
        .map((f) => f.template as string),
    );
    for (const s of mine) {
      const run = runOf.get(s.id);
      const template = templates.get(facts.get(s.id)?.template ?? "");
      if (!run && !usable(template)) continue;
      const sees =
        who === "all" || (who === "own" && (s.account === reader || run?.account_id === reader));
      const state: ChecklistState = !run
        ? "not_started"
        : run.state === "open"
          ? Number(run.ticked) > 0
            ? "in_progress"
            : "not_started"
          : run.state;
      s.checklist = { name: run?.name ?? template?.name ?? "", state: sees ? state : null };
    }
  }
}

/**
 * Each shift's warnings, as a write would be made with them (ADR 0622), set-based: the
 * qualifications of the kinds on the roster in one read, the people's unavailabilities in one.
 * For a rosterer's read only (it says who is away).
 */
async function addWarnings(
  ctx: HandlerContext,
  shifts: RosterShift[],
  uncoveredDays: number,
): Promise<void> {
  const now = Math.floor(Date.parse(ctx.now) / 1000);
  const kindObjects = [
    ...new Set(shifts.map((s) => s.kind?.object).filter((k): k is string => !!k)),
  ];
  const accounts = [...new Set(shifts.map((s) => s.account).filter((a): a is string => !!a))];
  const quals = kindObjects.length
    ? await ctx.db
        .selectFrom("core_staff_qualification")
        .select(["account_id", "kind_object", "kind_record"])
        .where("kind_object", "in", jsonList(kindObjects))
        .execute()
    : [];
  const anyFor = new Set(quals.map((q) => q.kind_object));
  const has = new Set(
    quals.map((q) => `${q.account_id}\u0000${q.kind_object}\u0000${q.kind_record}`),
  );
  // A kind record in the Trash qualifies nobody.
  const liveKinds = new Set<string>();
  for (const kindObject of kindObjects) {
    const target = getObject(kindObject);
    const ids = [
      ...new Set(shifts.filter((s) => s.kind?.object === kindObject).map((s) => s.kind?.id ?? "")),
    ];
    if (!target || !ids.length) continue;
    const live = await (ctx.db as AnyDb)
      .selectFrom(visibleSource(orgReader(ctx.db), target))
      .select("id")
      .where("id", "in", jsonList(ids))
      .execute();
    for (const r of live as { id: string }[]) liveKinds.add(`${kindObject}\u0000${r.id}`);
  }
  const first = Math.min(...shifts.map((s) => seconds(s.startsAt) ?? now), now);
  const firstDate = new Date((first - 2 * 86_400) * 1000).toISOString().slice(0, 10);
  const away = accounts.length
    ? await ctx.db
        .selectFrom("core_staff_away")
        .selectAll()
        .where("account_id", "in", jsonList(accounts))
        .where((eb) =>
          eb.or([
            eb.and([
              eb("kind", "!=", "regular"),
              eb("ends_at", ">", new Date(first * 1000).toISOString()),
            ]),
            eb.and([
              eb("kind", "=", "regular"),
              eb.or([eb("until_date", "is", null), eb("until_date", ">=", firstDate)]),
            ]),
          ]),
        )
        .limit(2000)
        .execute()
    : [];
  for (const s of shifts) {
    const out: StaffWarning[] = [];
    const label = (getObject(s.object)?.label ?? "shift").toLowerCase();
    const warn = (code: StaffWarning["code"], message: string) =>
      out.push({ code, object: s.object, id: s.id, account: s.account, message });
    const starts = seconds(s.startsAt);
    const ends = seconds(s.endsAt);
    if (s.uncovered) {
      if (starts !== null && starts >= now && starts < now + uncoveredDays * 86_400) {
        warn("uncovered", `This ${label} has nobody on it.`);
      }
    } else if (s.account) {
      const name = s.name ?? "This person";
      if (starts !== null && ends !== null && ends > starts) {
        const mine = away.filter((a) => a.account_id === s.account);
        const over = mine.some((a) => {
          if (a.kind === "regular") return regularOverlaps(a, starts, ends);
          const from = seconds(a.starts_at);
          const until = seconds(a.ends_at);
          return from !== null && until !== null && from < ends && until > starts;
        });
        if (over) warn("unavailable", `${name} said they are not available then.`);
      }
      if (s.kind) {
        const k = `${s.kind.object}\u0000${s.kind.id}`;
        const ok = has.has(`${s.account}\u0000${k}`)
          ? liveKinds.has(k)
          : !anyFor.has(s.kind.object);
        if (!ok)
          warn("not_qualified", `${name} is not marked as qualified for this kind of ${label}.`);
      }
    }
    s.warnings = out;
  }
}
