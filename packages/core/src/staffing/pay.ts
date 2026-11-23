// Pay periods (stage 45 step 6, ADR 0627): who is counted, the period a shift belongs to, a
// period's lines and totals worked out from the roster, and the export. No rates and no money:
// whole minutes and counts only (decision 14); payroll applies the rates.
//
// - **The period** is the pack's setting (`staffing.settings.payPeriod`, decision 20): weekly or
//   fortnightly from the date one period starts (until that is set nothing is totalled), or
//   monthly from a day of the month (1 to 28), in the organisation's zone. A shift belongs to the
//   period of its local start date.
// - **A line** is one live shift of a counted person in the period (decision 18: the roster as it
//   stands, corrected before the lock): its own minutes (end minus start, as instants, so a clock
//   change counts the hours really worked), plus its kind's before and after minutes (pay only,
//   decision 19), or nothing when it is marked not worked. Who is counted is the basis in force
//   on the shift's own local date, so a period totalled again later gives the same lines.
// - **Evidence** beside each line: whether its list was taken and by whom (a kind of shift that
//   declares `staffed.evidence`), flagged when someone other than its person took it.
// - **Hours** are shown from whole minutes: minutes ÷ 60, rounded half up to two places, from
//   the summed minutes (never a sum of rounded hours). The minutes are what count.
import { CompiledQuery, sql } from "kysely";
import { ValidationError } from "../errors.ts";
import { columnName, ident, sideTable } from "../extensions/naming.ts";
import { objectTableOf } from "../extensions/schema.ts";
import { getObject, listObjects } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import { jsonList } from "../records/common.ts";
import { loadGeneralSettings } from "../settings.ts";
import { addLocalDays, localParts, parseLocalDate, wallClockToInstant } from "../time/local.ts";
import { kindObjectOf } from "./kinds.ts";
import { payPeriodSettings } from "./rosterers.ts";
import { literal } from "./sql.ts";

export type PayBasis = "by_time" | "by_class" | "not_counted";
export const PAY_BASES = ["by_time", "by_class", "not_counted"] as const;
export type PeriodKind = "weekly" | "fortnightly" | "monthly";

/** The most shifts one period totals; more is refused, never cut short (pay is never partial). */
export const MAX_PERIOD_SHIFTS = 10_000;
const PAGE = 1000;

/** How pay periods run: the pack's setting, in the organisation's zone. */
export interface PayConfig {
  period: PeriodKind;
  /** Weekly and fortnightly: the date one period starts; null until it is set. */
  start: string | null;
  /** Monthly: the day of the month a period starts (1 to 28). */
  day: number;
  zone: string;
}

/** A period: its local dates (both included), zone, and local midnights as unix seconds. */
export interface PeriodRange {
  start: string;
  end: string;
  zone: string;
  starts: number;
  ends: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const fmt = (d: { year: number; month: number; day: number }) =>
  `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
const dayNumber = (d: { year: number; month: number; day: number }) =>
  Date.UTC(d.year, d.month - 1, d.day) / 86_400_000;

/**
 * The pay period's settings, or null when no installed pack declares them (no pay periods).
 * A weekly or fortnightly period with no valid start date has `start: null`: nothing is totalled.
 */
export async function payConfig(db: HandlerContext["db"]): Promise<PayConfig | null> {
  const settings = await payPeriodSettings(db);
  if (!settings) return null;
  const { timezone } = await loadGeneralSettings(db);
  const period: PeriodKind =
    settings.period === "weekly" || settings.period === "monthly" ? settings.period : "fortnightly";
  const start =
    typeof settings.start === "string" &&
    DATE_RE.test(settings.start.trim()) &&
    parseLocalDate(settings.start.trim())
      ? settings.start.trim()
      : null;
  const raw = Number(settings.day);
  const day = Number.isInteger(raw) && raw >= 1 && raw <= 28 ? raw : 1;
  return { period, start, day, zone: timezone };
}

/** The local midnight starting `date` in `zone`, as unix seconds. */
function midnight(date: { year: number; month: number; day: number }, zone: string): number {
  return Math.floor(wallClockToInstant({ ...date, hour: 0, minute: 0 }, zone) / 1000);
}

/** A period from its local first and last dates, with its instants. */
export function periodRange(start: string, end: string, zone: string): PeriodRange {
  const s = parseLocalDate(start);
  const e = parseLocalDate(end);
  if (!s || !e) throw new ValidationError(`${start} to ${end} are not dates`, { field: "start" });
  return { start, end, zone, starts: midnight(s, zone), ends: midnight(addLocalDays(e, 1), zone) };
}

/**
 * The period containing the local date `date`, or null when the setting cannot place it yet (a
 * weekly or fortnightly period with no start date).
 */
export function periodContaining(config: PayConfig, date: string): PeriodRange | null {
  const d = parseLocalDate(date);
  if (!d) throw new ValidationError(`${date} is not a date`, { field: "start" });
  if (config.period === "monthly") {
    const first =
      d.day >= config.day
        ? { year: d.year, month: d.month, day: config.day }
        : d.month === 1
          ? { year: d.year - 1, month: 12, day: config.day }
          : { year: d.year, month: d.month - 1, day: config.day };
    const next =
      first.month === 12
        ? { year: first.year + 1, month: 1, day: config.day }
        : { year: first.year, month: first.month + 1, day: config.day };
    return periodRange(fmt(first), fmt(addLocalDays(next, -1)), config.zone);
  }
  if (!config.start) return null;
  const anchor = parseLocalDate(config.start);
  if (!anchor) return null;
  const length = config.period === "weekly" ? 7 : 14;
  const offset = dayNumber(d) - dayNumber(anchor);
  const k = Math.floor(offset / length);
  const first = addLocalDays(anchor, k * length);
  return periodRange(fmt(first), fmt(addLocalDays(first, length - 1)), config.zone);
}

/** A stored (locked or reopened) period: its dates, zone and instants, which never change. */
export interface StoredPeriod {
  start: string;
  end: string;
  zone: string;
  starts: number;
  ends: number;
}

const shiftDate = (date: string, days: number) => {
  const d = parseLocalDate(date);
  if (!d) throw new ValidationError(`${date} is not a date`, { field: "start" });
  return fmt(addLocalDays(d, days));
};

/**
 * The period containing the local date `date`, given the setting and the periods already locked
 * (or locked and reopened), which keep their dates and instants whatever the setting says since
 * (the review of PR #287, ADR 0627). A date inside a stored period is in it. Any other date is in
 * the setting's period for it, cut short where it would reach into a stored period: so after the
 * last stored period the setting's rule starts the day after it ends (a change of length, start
 * date, monthly day or zone takes effect from there), and a gap left between stored periods is
 * its own period. Next to a stored period a period starts or ends at its very instant, so a zone
 * changed since leaves no hour in two periods or in none. Periods never overlap and never leave a
 * gap; every shift is in exactly one. Null until a weekly or fortnightly start date is set.
 */
export function periodFor(
  config: PayConfig,
  stored: readonly StoredPeriod[],
  date: string,
): PeriodRange | null {
  const held = stored.find((p) => p.start <= date && date <= p.end);
  if (held) return { ...held };
  const grid = periodContaining(config, date);
  if (!grid) return null;
  let { start, end, starts, ends } = grid;
  const prev = stored
    .filter((p) => p.end < date)
    .reduce<StoredPeriod | null>((a, p) => (!a || p.end > a.end ? p : a), null);
  const next = stored
    .filter((p) => p.start > date)
    .reduce<StoredPeriod | null>((a, p) => (!a || p.start < a.start ? p : a), null);
  if (prev && prev.end >= shiftDate(start, -1)) {
    if (prev.end >= start) start = shiftDate(prev.end, 1);
    starts = prev.ends;
  }
  if (next && next.start <= shiftDate(end, 1)) {
    if (next.start <= end) end = shiftDate(next.start, -1);
    ends = next.starts;
  }
  return { start, end, zone: config.zone, starts, ends };
}

/** The local date `seconds` falls on in `zone`. */
export const localDateOf = (seconds: number, zone: string) => localParts(seconds * 1000, zone).date;

/** Whole minutes as hours, rounded half up to two places: "7.50". Integers only, no floats. */
export function hoursOf(minutes: number): string {
  const hundredths = Math.floor((minutes * 100 + 30) / 60);
  return `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, "0")}`;
}

// --- A period's lines ------------------------------------------------------------------------------

/** One shift counted in a period (core_pay_line's shape before it is stored). */
export interface PayLine {
  account: string;
  name: string;
  email: string;
  basis: "by_time" | "by_class";
  object: string;
  id: string;
  kind: { object: string; id: string } | null;
  kindName: string;
  title: string;
  place: string | null;
  starts: number;
  ends: number;
  localDate: string;
  localStart: string;
  localEnd: string;
  shiftMinutes: number;
  beforeMinutes: number;
  afterMinutes: number;
  countedMinutes: number;
  counted: boolean;
  notWorkedReason: string | null;
  /** Null: this kind of shift keeps no list. */
  listTaken: boolean | null;
  markedBy: string | null;
  flagged: boolean;
}

// biome-ignore lint/suspicious/noExplicitAny: x_* tables are not in CoreDatabase; names come from the registry.
type AnyDb = import("kysely").Kysely<any>;

const column = (object: ObjectDefinition, field: string | undefined) =>
  (field && object.fields.find((f) => f.name === field)?.column) || null;
const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
const seconds = (value: unknown): number | null => {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};
const minutesOf = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 1440) : 0;
};
const localStamp = (s: number, zone: string) => {
  const p = localParts(s * 1000, zone);
  return `${p.date} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
};

/** The SQL range a period reads on a staffed object's start column (an ISO pre-filter, then exact). */
function rangeWhere(startsCol: string, range: PeriodRange, alias = ""): string {
  const c = `${alias}${ident(startsCol)}`;
  const lo = new Date((range.starts - 86_400) * 1000).toISOString();
  const hi = new Date((range.ends + 86_400) * 1000).toISOString();
  return (
    `${c} >= ${literal(lo)} AND ${c} < ${literal(hi)} ` +
    `AND CAST(strftime('%s', ${c}) AS INTEGER) >= ${range.starts} ` +
    `AND CAST(strftime('%s', ${c}) AS INTEGER) < ${range.ends}`
  );
}

interface StaffedShape {
  object: ObjectDefinition;
  table: string;
  who: string;
  starts: string;
  ends: string;
  state: string;
  kind: string | null;
  title: string | null;
  place: string | null;
}

function staffedShapes(): StaffedShape[] {
  const out: StaffedShape[] = [];
  for (const object of listObjects()) {
    const def = object.staffed;
    const table = def ? objectTableOf(object.name) : undefined;
    const who = def ? column(object, def.who.field) : null;
    const starts = def ? column(object, def.starts) : null;
    const ends = def ? column(object, def.ends) : null;
    const state = column(object, object.states?.field);
    if (!def || !table || !who || !starts || !ends || !state) continue;
    const [placeField] = (def.place ?? "").split(".") as [string];
    out.push({
      object,
      table,
      who,
      starts,
      ends,
      state,
      kind: column(object, def.kind),
      title: column(object, object.titleField),
      place: def.place ? column(object, placeField) : null,
    });
  }
  return out;
}

/** Each account's basis rows, in order of date. */
async function basesOf(
  ctx: HandlerContext,
  accounts: readonly string[],
  until: string,
): Promise<Map<string, { from: string; basis: PayBasis }[]>> {
  const out = new Map<string, { from: string; basis: PayBasis }[]>();
  if (!accounts.length) return out;
  const rows = await ctx.db
    .selectFrom("core_staff_pay_basis")
    .select(["account_id", "from_date", "basis"])
    .where("account_id", "in", jsonList([...accounts]))
    .where("from_date", "<=", until)
    .orderBy("account_id")
    .orderBy("from_date")
    .execute();
  for (const r of rows) {
    const list = out.get(r.account_id) ?? [];
    list.push({ from: r.from_date, basis: r.basis });
    out.set(r.account_id, list);
  }
  return out;
}

/** The basis in force on `date`: the latest row from on or before it, or not counted. */
export function basisOn(
  rows: readonly { from: string; basis: PayBasis }[] | undefined,
  date: string,
) {
  let basis: PayBasis = "not_counted";
  for (const r of rows ?? []) if (r.from <= date) basis = r.basis;
  return basis;
}

/**
 * A period's lines from the roster as it stands: every live shift of a counted person whose local
 * start date is in the period, across every staffed object, read set-based in pages. Refuses
 * (never cuts short) a period of more than MAX_PERIOD_SHIFTS shifts.
 */
export async function periodLines(ctx: HandlerContext, range: PeriodRange): Promise<PayLine[]> {
  type Raw = {
    shape: StaffedShape;
    id: string;
    who: string | null;
    starts: number;
    ends: number;
    kind: string | null;
    title: string | null;
    place: string | null;
  };
  const raws: Raw[] = [];
  for (const shape of staffedShapes()) {
    const def = shape.object.staffed;
    if (!def) continue;
    let after: { starts: string; id: string } | null = null;
    for (;;) {
      const page: {
        id: string;
        who: string | null;
        starts: string;
        ends: string | null;
        kind: string | null;
        title: string | null;
        place: string | null;
      }[] = (
        await sql<{
          id: string;
          who: string | null;
          starts: string;
          ends: string | null;
          kind: string | null;
          title: string | null;
          place: string | null;
        }>`SELECT id, ${sql.ref(shape.who)} AS who, ${sql.ref(shape.starts)} AS starts,
          ${sql.ref(shape.ends)} AS ends, ${shape.kind ? sql.ref(shape.kind) : sql`NULL`} AS kind,
          ${shape.title ? sql.ref(shape.title) : sql`NULL`} AS title,
          ${shape.place ? sql.ref(shape.place) : sql`NULL`} AS place
        FROM ${sql.table(shape.table)}
        WHERE deleted_at IS NULL AND ${sql.ref(shape.state)} IN (${sql.join(def.live.map((s) => sql`${s}`))})
          AND ${sql.raw(rangeWhere(shape.starts, range))}
          AND ${sql.ref(shape.who)} IS NOT NULL AND ${sql.ref(shape.who)} != ''
          ${after ? sql`AND (${sql.ref(shape.starts)}, id) > (${after.starts}, ${after.id})` : sql``}
        ORDER BY ${sql.ref(shape.starts)}, id LIMIT ${PAGE}`.execute(ctx.db)
      ).rows;
      for (const r of page) {
        const s = seconds(r.starts);
        const e = seconds(r.ends);
        // A live shift always ends after it starts (ADR 0621); one that does not claims nothing.
        if (s === null || e === null || e <= s) continue;
        raws.push({
          shape,
          id: r.id,
          who: r.who,
          starts: s,
          ends: e,
          kind: r.kind,
          title: r.title,
          place: r.place,
        });
      }
      if (raws.length > MAX_PERIOD_SHIFTS) {
        throw new ValidationError(
          `A pay period totals at most ${MAX_PERIOD_SHIFTS.toLocaleString("en")} shifts; this one has more. Use a shorter pay period.`,
          { rule: "pay_period_too_large" },
        );
      }
      const last = page.at(-1);
      if (page.length < PAGE || !last) break;
      after = { starts: last.starts, id: last.id };
    }
  }

  // Whose each shift is: the user field itself, or its holder's account (a coach profile's).
  const accountOf = new Map<string, string | null>();
  for (const shape of new Set(raws.map((r) => r.shape))) {
    const def = shape.object.staffed;
    if (!def?.who.account || !def.who.object) continue;
    const holder = getObject(def.who.object);
    const holderTable = holder ? objectTableOf(holder.name) : undefined;
    const holderCol = holder ? column(holder, def.who.account) : null;
    const ids = [...new Set(raws.filter((r) => r.shape === shape).map((r) => r.who as string))];
    if (!holderTable || !holderCol || !ids.length) continue;
    const held = await sql<{ id: string; account: string | null }>`SELECT id, ${sql.ref(
      holderCol,
    )} AS account FROM ${sql.table(holderTable)} WHERE id IN ${jsonList(ids)}`.execute(ctx.db);
    for (const h of held.rows) accountOf.set(`${shape.object.name}\u0000${h.id}`, text(h.account));
  }
  const accountFor = (r: Raw) =>
    r.shape.object.staffed?.who.account
      ? (accountOf.get(`${r.shape.object.name}\u0000${r.who}`) ?? null)
      : text(r.who);

  // Who is counted, on each shift's own date.
  const withAccount = raws
    .map((r) => ({ r, account: accountFor(r) }))
    .filter((x): x is { r: Raw; account: string } => x.account !== null);
  const bases = await basesOf(ctx, [...new Set(withAccount.map((x) => x.account))], range.end);
  const counted = withAccount
    .map((x) => ({ ...x, date: localDateOf(x.r.starts, range.zone) }))
    .map((x) => ({ ...x, basis: basisOn(bases.get(x.account), x.date) }))
    .filter((x): x is typeof x & { basis: "by_time" | "by_class" } => x.basis !== "not_counted");
  if (!counted.length) return [];

  // The marks, the kinds (name, before and after minutes), the places and the evidence, once each.
  const marks = new Map<string, string>();
  for (const objectName of new Set(counted.map((x) => x.r.shape.object.name))) {
    const ids = counted.filter((x) => x.r.shape.object.name === objectName).map((x) => x.r.id);
    const rows = await ctx.db
      .selectFrom("core_staff_not_worked")
      .select(["record_id", "reason"])
      .where("object_type", "=", objectName)
      .where("record_id", "in", jsonList(ids))
      .execute();
    for (const m of rows) marks.set(`${objectName}\u0000${m.record_id}`, m.reason);
  }
  const kinds = new Map<string, { name: string; before: number; after: number }>();
  const places = new Map<string, string>();
  const evidence = new Map<string, Set<string>>();
  for (const shape of new Set(counted.map((x) => x.r.shape))) {
    const def = shape.object.staffed;
    if (!def) continue;
    const mine = counted.filter((x) => x.r.shape === shape);
    const kindObject = kindObjectOf(shape.object);
    const kindDef = kindObject ? getObject(kindObject) : undefined;
    const kindTable = kindObject ? objectTableOf(kindObject) : undefined;
    const kindIds = [...new Set(mine.map((x) => x.r.kind).filter((k): k is string => !!k))];
    if (kindDef && kindTable && kindIds.length) {
      const titleCol = column(kindDef, kindDef.titleField);
      // The kind's minutes: its own field, or one this extension adds to it (`bookings.
      // rosterBeforeMinutes`), which lives in this extension's side table for it (ADR 0015).
      const ext = shape.object.name.split(".")[0] as string;
      const minutesSource = (path: { field: string } | undefined) => {
        const local = path?.field.split(".")[1];
        if (!local) return null;
        const own = column(kindDef, local);
        if (own) return { table: kindTable, column: own };
        return column(kindDef, `${ext}.${local}`)
          ? { table: sideTable(ext, kindObject as string), column: columnName(local) }
          : null;
      };
      const minutesSql = (src: { table: string; column: string } | null) =>
        src
          ? sql`(SELECT ${sql.ref(`m.${src.column}`)} FROM ${sql.table(src.table)} m WHERE m.id = k.id)`
          : sql`NULL`;
      const rows = await sql<{ id: string; name: unknown; before_m: unknown; after_m: unknown }>`
        SELECT k.id AS id, ${titleCol ? sql.ref(`k.${titleCol}`) : sql`NULL`} AS name,
          ${minutesSql(minutesSource(def.payBefore))} AS before_m,
          ${minutesSql(minutesSource(def.payAfter))} AS after_m
        FROM ${sql.table(kindTable)} k WHERE k.id IN ${jsonList(kindIds)}`.execute(ctx.db);
      for (const k of rows.rows) {
        kinds.set(`${kindObject}\u0000${k.id}`, {
          name: text(k.name) ?? kindDef.label,
          before: minutesOf(k.before_m),
          after: minutesOf(k.after_m),
        });
      }
    }
    const [placeField, placeOf] = (def.place ?? "").split(".") as [string, string | undefined];
    const placeTarget = placeOf
      ? shape.object.fields.find((f) => f.name === placeField)?.options?.to
      : undefined;
    const placeDef = placeTarget ? getObject(placeTarget) : undefined;
    const placeTable = placeTarget ? objectTableOf(placeTarget) : undefined;
    const placeCol = placeDef && placeOf ? column(placeDef, placeOf) : null;
    const placeIds = [...new Set(mine.map((x) => x.r.place).filter((p): p is string => !!p))];
    if (placeTable && placeCol && placeIds.length) {
      const rows = await sql<{ id: string; name: unknown }>`SELECT id, ${sql.ref(
        placeCol,
      )} AS name FROM ${sql.table(placeTable)} WHERE id IN ${jsonList(placeIds)}`.execute(ctx.db);
      for (const p of rows.rows) {
        const name = text(p.name);
        if (name) places.set(`${shape.object.name}\u0000${p.id}`, name);
      }
    }
    if (def.evidence) {
      const evDef = getObject(def.evidence.object);
      const evTable = objectTableOf(def.evidence.object);
      const linkCol = evDef ? column(evDef, def.evidence.link) : null;
      const byCol = evDef ? column(evDef, def.evidence.by) : null;
      if (evTable && linkCol && byCol) {
        const rows = await sql<{ shift: string; by: string }>`SELECT ${sql.ref(
          linkCol,
        )} AS shift, ${sql.ref(byCol)} AS by FROM ${sql.table(evTable)}
          WHERE ${sql.ref(linkCol)} IN ${jsonList(mine.map((x) => x.r.id))}
            AND deleted_at IS NULL AND ${sql.ref(byCol)} IS NOT NULL AND ${sql.ref(byCol)} != ''
          GROUP BY ${sql.ref(linkCol)}, ${sql.ref(byCol)}`.execute(ctx.db);
        for (const e of rows.rows) {
          const k = `${shape.object.name}\u0000${e.shift}`;
          const set = evidence.get(k) ?? new Set<string>();
          set.add(e.by);
          evidence.set(k, set);
        }
      }
    }
  }

  // Names and emails as they are now (kept on the lines at the lock).
  const people = new Set(counted.map((x) => x.account));
  for (const set of evidence.values()) for (const a of set) people.add(a);
  const users = await ctx.db
    .selectFrom("core_user")
    .select(["id", "name", "email"])
    .where("id", "in", jsonList([...people]))
    .execute();
  const userOf = new Map(users.map((u) => [u.id, u]));
  const nameOf = (id: string) => userOf.get(id)?.name || userOf.get(id)?.email || "Someone";

  const lines: PayLine[] = counted.map(({ r, account, basis, date }) => {
    const name = r.shape.object.name;
    const kindObject = kindObjectOf(r.shape.object);
    const kind = kindObject && r.kind ? kinds.get(`${kindObject}\u0000${r.kind}`) : undefined;
    const reason = marks.get(`${name}\u0000${r.id}`) ?? null;
    const shiftMinutes = Math.floor((r.ends - r.starts) / 60);
    const before = kind?.before ?? 0;
    const after = kind?.after ?? 0;
    const def = r.shape.object.staffed;
    const markers = def?.evidence ? (evidence.get(`${name}\u0000${r.id}`) ?? new Set()) : null;
    const placeOf = def?.place?.includes(".");
    return {
      account,
      name: nameOf(account),
      email: userOf.get(account)?.email ?? "",
      basis,
      object: name,
      id: r.id,
      kind: kindObject && r.kind ? { object: kindObject, id: r.kind } : null,
      kindName: kind?.name ?? r.shape.object.label,
      title: text(r.title) ?? r.shape.object.label,
      place: placeOf
        ? r.place
          ? (places.get(`${name}\u0000${r.place}`) ?? null)
          : null
        : text(r.place),
      starts: r.starts,
      ends: r.ends,
      localDate: date,
      localStart: localStamp(r.starts, range.zone),
      localEnd: localStamp(r.ends, range.zone),
      shiftMinutes,
      beforeMinutes: before,
      afterMinutes: after,
      countedMinutes: reason === null ? shiftMinutes + before + after : 0,
      counted: reason === null,
      notWorkedReason: reason,
      listTaken: markers === null ? null : markers.size > 0,
      markedBy: markers?.size ? [...markers].map(nameOf).sort().join("; ") : null,
      flagged: markers !== null && [...markers].some((m) => m !== account),
    };
  });
  return lines.sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      a.account.localeCompare(b.account) ||
      a.starts - b.starts ||
      a.object.localeCompare(b.object) ||
      a.id.localeCompare(b.id),
  );
}

/** A stored line as a PayLine. */
export function lineFromRow(r: import("@composable-os/db").CoreDatabase["core_pay_line"]): PayLine {
  return {
    account: r.account_id,
    name: r.name,
    email: r.email,
    basis: r.basis,
    object: r.object_type,
    id: r.record_id,
    kind: r.kind_object && r.kind_record ? { object: r.kind_object, id: r.kind_record } : null,
    kindName: r.kind_name,
    title: r.title,
    place: r.place,
    starts: r.starts,
    ends: r.ends,
    localDate: r.local_date,
    localStart: r.local_start,
    localEnd: r.local_end,
    shiftMinutes: r.shift_minutes,
    beforeMinutes: r.before_minutes,
    afterMinutes: r.after_minutes,
    countedMinutes: r.counted_minutes,
    counted: r.counted === 1,
    notWorkedReason: r.not_worked_reason,
    listTaken: r.list_taken === null ? null : r.list_taken === 1,
    markedBy: r.marked_by,
    flagged: r.flagged === 1,
  };
}

/** One person's total for one kind of work. */
export interface PayTotal {
  account: string;
  name: string;
  email: string;
  basis: "by_time" | "by_class";
  kind: { object: string; id: string } | null;
  kindName: string;
  /** Shifts counted (classes for a class kind); a shift marked not worked is not. */
  shifts: number;
  minutes: number;
  hours: string;
  notWorked: number;
  flagged: number;
}

/** The totals, one per person, basis and kind, in the lines' order. */
export function totalsOf(lines: readonly PayLine[]): PayTotal[] {
  const out = new Map<string, PayTotal>();
  for (const l of lines) {
    const key = [l.account, l.basis, l.kind?.object ?? "", l.kind?.id ?? "", l.kindName].join(
      "\u0000",
    );
    let t = out.get(key);
    if (!t) {
      t = {
        account: l.account,
        name: l.name,
        email: l.email,
        basis: l.basis,
        kind: l.kind,
        kindName: l.kindName,
        shifts: 0,
        minutes: 0,
        hours: "0.00",
        notWorked: 0,
        flagged: 0,
      };
      out.set(key, t);
    }
    if (l.counted) t.shifts += 1;
    else t.notWorked += 1;
    t.minutes += l.countedMinutes;
    if (l.flagged) t.flagged += 1;
  }
  for (const t of out.values()) t.hours = hoursOf(t.minutes);
  return [...out.values()];
}

// --- The lock's batch ----------------------------------------------------------------------------

/** The lines' insert, in chunks, each one statement reading a JSON array (one parameter). */
export function lineInserts(periodId: string, lines: readonly PayLine[]): CompiledQuery[] {
  const out: CompiledQuery[] = [];
  const CHUNK = 100;
  const cols: [string, string][] = [
    ["period_id", "p"],
    ["n", "n"],
    ["account_id", "a"],
    ["name", "nm"],
    ["email", "em"],
    ["basis", "b"],
    ["object_type", "o"],
    ["record_id", "r"],
    ["kind_object", "ko"],
    ["kind_record", "kr"],
    ["kind_name", "kn"],
    ["title", "t"],
    ["place", "pl"],
    ["starts", "s"],
    ["ends", "e"],
    ["local_date", "ld"],
    ["local_start", "ls"],
    ["local_end", "le"],
    ["shift_minutes", "sm"],
    ["before_minutes", "bm"],
    ["after_minutes", "am"],
    ["counted_minutes", "cm"],
    ["counted", "c"],
    ["not_worked_reason", "nw"],
    ["list_taken", "lt"],
    ["marked_by", "mb"],
    ["flagged", "f"],
  ];
  const statement =
    `INSERT INTO core_pay_line (${cols.map(([c]) => c).join(", ")}) SELECT ` +
    `${cols.map(([, k]) => `json_extract(value, '$.${k}')`).join(", ")} FROM json_each(?)`;
  for (let i = 0; i < lines.length; i += CHUNK) {
    const rows = lines.slice(i, i + CHUNK).map((l, j) => ({
      p: periodId,
      n: i + j + 1,
      a: l.account,
      nm: l.name,
      em: l.email,
      b: l.basis,
      o: l.object,
      r: l.id,
      ko: l.kind?.object ?? null,
      kr: l.kind?.id ?? null,
      kn: l.kindName,
      t: l.title,
      pl: l.place,
      s: l.starts,
      e: l.ends,
      ld: l.localDate,
      ls: l.localStart,
      le: l.localEnd,
      sm: l.shiftMinutes,
      bm: l.beforeMinutes,
      am: l.afterMinutes,
      cm: l.countedMinutes,
      c: l.counted ? 1 : 0,
      nw: l.notWorkedReason,
      lt: l.listTaken === null ? null : l.listTaken ? 1 : 0,
      mb: l.markedBy,
      f: l.flagged ? 1 : 0,
    }));
    out.push(CompiledQuery.raw(statement, [JSON.stringify(rows)]));
  }
  return out;
}

const msOf = (expr: string) =>
  `CAST(coalesce(max((julianday(${expr}) - 2440587.5) * 86400000), 0) AS INTEGER)`;

/**
 * What a period's lines were read from, as integer SQL the lock reads first and then guards in
 * its own batch (core_staff_guard): the shifts whose start is in the period (how many, and the
 * latest change), their holders' latest change, the kinds' latest change, the not-worked marks
 * in the period and who is counted. Anything written between the read and the lock fails the lock
 * whole (`roster_changed`), so a locked period's lines are exactly the roster it locked.
 */
export function periodFingerprint(range: PeriodRange): string[] {
  const out: string[] = [];
  for (const shape of staffedShapes()) {
    // Out of the Trash (as the start index is): trashing or restoring one changes the count.
    const where = `deleted_at IS NULL AND ${rangeWhere(shape.starts, range)}`;
    const table = ident(shape.table);
    out.push(`SELECT count(*) FROM ${table} WHERE ${where}`);
    out.push(`SELECT ${msOf("updated_at")} FROM ${table} WHERE ${where}`);
    const def = shape.object.staffed;
    if (def?.who.account && def.who.object) {
      const holder = objectTableOf(def.who.object);
      if (holder) {
        out.push(
          `SELECT ${msOf("h.updated_at")} FROM ${ident(holder)} h WHERE h.id IN (SELECT ${ident(shape.who)} FROM ${table} WHERE ${where})`,
        );
      }
    }
    const kindObject = kindObjectOf(shape.object);
    const kindTable = kindObject ? objectTableOf(kindObject) : undefined;
    if (kindTable) out.push(`SELECT ${msOf("updated_at")} FROM ${ident(kindTable)}`);
  }
  out.push(
    `SELECT count(*) FROM core_staff_not_worked WHERE starts >= ${range.starts} AND starts < ${range.ends}`,
    `SELECT ${msOf("marked_at")} FROM core_staff_not_worked WHERE starts >= ${range.starts} AND starts < ${range.ends}`,
    "SELECT count(*) FROM core_staff_pay_basis",
    `SELECT ${msOf("set_at")} FROM core_staff_pay_basis`,
  );
  return [...new Set(out)];
}

/** Reads the fingerprint now: the values the lock's guards expect. */
export async function readFingerprint(
  ctx: HandlerContext,
  queries: readonly string[],
): Promise<number[]> {
  const out: number[] = [];
  for (const q of queries) {
    const row = (await (ctx.db as AnyDb).executeQuery(CompiledQuery.raw(`SELECT (${q}) AS v`, [])))
      .rows[0] as { v: number | null } | undefined;
    out.push(Number(row?.v ?? 0));
  }
  return out;
}

/** The guards: each fails the batch when its value changed since it was read. */
export function fingerprintGuards(queries: readonly string[], values: readonly number[]) {
  return queries.map((q, i) =>
    CompiledQuery.raw(`INSERT INTO core_staff_guard (expected, actual) SELECT ?, (${q})`, [
      values[i] ?? 0,
    ]),
  );
}

// --- The export ----------------------------------------------------------------------------------

/** A formula a spreadsheet would run: its first non-space character, the full-width ones too. */
const FORMULA_START = /^\s*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/u;
/** The same after a separator some spreadsheets split on (`a;=1+1` read with `;`). */
const FORMULA_AFTER_SEPARATOR = /[;,|\t\r\n]\s*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/u;

/**
 * A text cell a spreadsheet will not run (OWASP's CSV injection advice, widened in the review of
 * PR #287): a value whose first non-space character is `=`, `+`, `-`, `@` (or their full-width
 * forms), that starts with a tab, carriage return or line break, or that has one of them after a
 * separator, is prefixed with an apostrophe. Every text cell is quoted, quotes doubled.
 */
export function csvText(value: string | null | undefined): string {
  let v = value ?? "";
  if (FORMULA_START.test(v) || /^[\t\r\n]/.test(v) || FORMULA_AFTER_SEPARATOR.test(v)) {
    v = `'${v}`;
  }
  return `"${v.replaceAll('"', '""')}"`;
}

/** Minutes between two local "YYYY-MM-DD HH:MM" stamps, read as wall-clock times. */
const wallMinutes = (from: string, to: string) =>
  (Date.parse(`${to.replace(" ", "T")}:00Z`) - Date.parse(`${from.replace(" ", "T")}:00Z`)) /
  60_000;

/**
 * A line's note for payroll: a shift across a clock change shows local times whose difference is
 * not the time worked (its minutes are the time really worked).
 */
export function clockChangeNote(l: Pick<PayLine, "localStart" | "localEnd" | "shiftMinutes">) {
  const wall = wallMinutes(l.localStart, l.localEnd);
  return Number.isFinite(wall) && wall !== l.shiftMinutes
    ? `Crosses a clock change: ${l.localStart} to ${l.localEnd} on the clock is ${wall} minutes, ${l.shiftMinutes} minutes were worked.`
    : null;
}
const csvNumber = (n: number | string) => String(n);
const row = (cells: string[]) => cells.join(",");

const BASIS_WORDS: Record<"by_time" | "by_class", string> = {
  by_time: "by time",
  by_class: "by class",
};

/**
 * The export (CSV): the summary, one row per person and kind (period start, end, name, staff
 * email, basis, kind, shifts, hours as a decimal and minutes), a blank line, and the lines, one
 * row per shift (name, email, date, start, end, kind, title, place, minutes counted, not-worked
 * reason, list taken, taken by, flagged). No rates and no money. A preview of an open period says
 * so on its first line.
 */
export function payCsv(
  range: { start: string; end: string },
  lines: readonly PayLine[],
  state: { locked: boolean; version: number | null },
): string {
  const out: string[] = [];
  if (!state.locked) {
    out.push(row([csvText("PREVIEW: this period is not locked; its totals may still change")]));
  }
  out.push(
    row(
      [
        "period start",
        "period end",
        "name",
        "staff email",
        "basis",
        "kind",
        "shifts",
        "hours",
        "minutes",
      ].map(csvText),
    ),
  );
  for (const t of totalsOf(lines)) {
    out.push(
      row([
        csvText(range.start),
        csvText(range.end),
        csvText(t.name),
        csvText(t.email),
        csvText(BASIS_WORDS[t.basis]),
        csvText(t.kindName),
        csvNumber(t.shifts),
        csvNumber(t.hours),
        csvNumber(t.minutes),
      ]),
    );
  }
  out.push("");
  out.push(
    row(
      [
        "name",
        "staff email",
        "date",
        "start",
        "end",
        "kind",
        "title",
        "place",
        "minutes counted",
        "not worked",
        "list taken",
        "taken by",
        "for review",
        "note",
      ].map(csvText),
    ),
  );
  for (const l of lines) {
    out.push(
      row([
        csvText(l.name),
        csvText(l.email),
        csvText(l.localDate),
        csvText(l.localStart),
        csvText(l.localEnd),
        csvText(l.kindName),
        csvText(l.title),
        csvText(l.place),
        csvNumber(l.countedMinutes),
        csvText(l.notWorkedReason),
        csvText(l.listTaken === null ? "" : l.listTaken ? "yes" : "no"),
        csvText(l.markedBy),
        csvText(l.flagged ? "yes" : ""),
        csvText(clockChangeNote(l)),
      ]),
    );
  }
  return `${out.join("\r\n")}\r\n`;
}
