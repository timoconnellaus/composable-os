// Checklists on their own, without a roster (ADR 0651; a follow-on to stage 45 step 4b, ADR 0650).
//
// A checklist template may have a standing schedule: the days of the week it is due (in the
// business's time zone, the business's day of time/local.ts), a time it is due by, and who may do
// it (everyone on staff, the people holding a role or a pack role, or those granted a permission).
// Each due day gets one **day run**: a run of the template (core_checklist_run, as a duty shift's)
// whose record is the day itself (`checklist.day`, `<template>:<YYYY-MM-DD>`), so the run table's
// own rule makes it one a day. It is open from the start of that local day to the start of the
// next, with no grace: a run not finished by then is closed by the host as missed.
//
// What the host holds here, for every actor (and the database too, migration 0816):
// - **Who may do it** is copied from the template onto the run when it is made, and fixed. Anyone
//   who may do it ticks it as themselves; whoever ticks the last step finishes it (or, with
//   optional steps left, marks it done once every required one is ticked).
// - **Who manages checklists** (an admin, or an account granted checklists:write, never a pack
//   role) reads how every day went and may tick or finish one for someone who may do it, with why.
// - A finished or missed run never changes (migration 0815's triggers hold for these as for any).
import type { CoreDatabase } from "@composable-os/db";
import { CompiledQuery, type Kysely, sql } from "kysely";
import { jsonList } from "../records/common.ts";
import {
  addLocalDays,
  isoWeekday,
  localDay,
  parseLocalDate,
  wallClockToInstant,
} from "../time/local.ts";
import {
  MAX_STEPS,
  RUN_CHUNK_BYTES,
  type RunStep,
  type TemplateCopy,
  templateCopies,
} from "./index.ts";

/** A day run's object: its record is the day, `<template>:<YYYY-MM-DD>`. */
export const DAY_OBJECT = "checklist.day";

/** Who may do a scheduled checklist. */
export type DoersKind = "staff" | "role" | "grant";
export interface Doers {
  kind: DoersKind;
  /** The role or pack role (`member`, `rostering.team`), or the permission granted; null: staff. */
  value: string | null;
}

/** A template's standing schedule. */
export interface Schedule {
  /** ISO weekdays, 1 Monday … 7 Sunday, in order. */
  days: number[];
  /** A local time, HH:MM, or null. */
  dueBy: string | null;
  doers: Doers;
}

/** The day run's record id. */
export const dayRecord = (template: string, date: string) => `${template}:${date}`;

/** A day run's template and date, from its record id. */
export function parseDayRecord(record: string): { template: string; date: string } | null {
  const at = record.lastIndexOf(":");
  if (at < 1) return null;
  const date = record.slice(at + 1);
  return parseLocalDate(date) ? { template: record.slice(0, at), date } : null;
}

/** A template row's schedule, or null when it has none (or what is stored does not parse). */
export function scheduleOf(row: {
  days: string | null;
  due_by: string | null;
  doers_kind: DoersKind | null;
  doers_value: string | null;
}): Schedule | null {
  if (!row.days) return null;
  let days: number[] = [];
  try {
    const parsed = JSON.parse(row.days) as unknown;
    if (Array.isArray(parsed)) {
      days = [
        ...new Set(parsed.filter((d): d is number => Number.isInteger(d) && d >= 1 && d <= 7)),
      ];
    }
  } catch {
    days = [];
  }
  if (!days.length) return null;
  const kind = row.doers_kind ?? "staff";
  return {
    days: days.sort((a, b) => a - b),
    dueBy: row.due_by,
    doers: { kind, value: kind === "staff" ? null : row.doers_value },
  };
}

/** A day's window and due time (unix seconds), in the business's zone. */
export function dayWindow(
  date: string,
  dueBy: string | null,
  zone: string,
): { opens: number; closes: number; dueAt: number | null } {
  const d = parseLocalDate(date);
  if (!d) throw new Error(`not a date: ${date}`);
  const opens = Math.floor(wallClockToInstant({ ...d, hour: 0, minute: 0 }, zone) / 1000);
  const closes = Math.floor(
    wallClockToInstant({ ...addLocalDays(d, 1), hour: 0, minute: 0 }, zone) / 1000,
  );
  const [h, m] = (dueBy ?? "").split(":").map(Number);
  const dueAt =
    dueBy && Number.isInteger(h) && Number.isInteger(m)
      ? Math.floor(
          wallClockToInstant({ ...d, hour: h as number, minute: m as number }, zone) / 1000,
        )
      : null;
  return { opens, closes, dueAt };
}

/** Today in the business's zone. */
export const today = (now: string, zone: string) => localDay(now, zone).date;

/** Whether a schedule is due on a date. */
export const dueOn = (schedule: Schedule | null, date: string) =>
  schedule !== null && schedule.days.includes(isoWeekday(date));

// --- Who may do it, who manages ---------------------------------------------------------------

/** A staff account as these rules read it. */
interface Account {
  id: string;
  kind: string;
  role: string;
  pack_role: string | null;
  granted_permissions: string | null;
  deactivated_at: string | null;
  support_grant_id: string | null;
}

const grantsOf = (stored: string | null): string[] => {
  if (!stored) return [];
  try {
    const value = JSON.parse(stored) as unknown;
    return Array.isArray(value) ? value.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
};

/**
 * Whether an account may do a checklist with these doers: an active person on the staff who may
 * write (a viewer may not, a pack role may), holding the role or pack role, or the grant, named.
 * The same rule as migration 0816's triggers.
 */
export function accountMayDo(u: Account | undefined, doers: Doers): boolean {
  if (!u || u.kind !== "human" || u.deactivated_at || u.support_grant_id) return false;
  if (u.pack_role === null && u.role === "viewer") return false;
  if (doers.kind === "staff") return true;
  if (doers.kind === "role") {
    return u.pack_role !== null ? u.pack_role === doers.value : u.role === doers.value;
  }
  return doers.value !== null && grantsOf(u.granted_permissions).includes(doers.value);
}

/** Whether an account manages checklists: an active admin, or granted checklists:write; never a
 * pack role (which holds no core permission). The same rule as migration 0816's triggers. */
export function accountManages(u: Account | undefined): boolean {
  if (!u || u.kind !== "human" || u.deactivated_at || u.pack_role !== null) return false;
  return u.role === "admin" || grantsOf(u.granted_permissions).includes("checklists:write");
}

/** The accounts `ids` as these rules read them (one read). */
export async function accountsOf(
  db: Kysely<CoreDatabase>,
  ids: readonly string[],
): Promise<Map<string, Account>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, Account>();
  if (!unique.length) return out;
  const rows = await db
    .selectFrom("core_user")
    .select([
      "id",
      "kind",
      "role",
      "pack_role",
      "granted_permissions",
      "deactivated_at",
      "support_grant_id",
    ])
    .where("id", "in", jsonList(unique))
    .execute();
  for (const r of rows) out.set(r.id, r as Account);
  return out;
}

/** The most people a "who may do it" list names (for someone ticking for one of them). */
export const DOERS_LISTED = 200;

/** The people who may do a checklist with these doers, by name (one read, at most 200). */
export async function doersOf(
  db: Kysely<CoreDatabase>,
  doers: Doers,
): Promise<{ id: string; name: string }[]> {
  let q = db
    .selectFrom("core_user")
    .select([
      "id",
      "name",
      "email",
      "kind",
      "role",
      "pack_role",
      "granted_permissions",
      "deactivated_at",
      "support_grant_id",
    ])
    .where("kind", "=", "human")
    .where("deactivated_at", "is", null)
    .where("support_grant_id", "is", null);
  if (doers.kind === "role" && doers.value) {
    const value = doers.value;
    q = q.where((eb) =>
      eb.or([
        eb("pack_role", "=", value),
        eb.and([eb("pack_role", "is", null), eb("role", "=", value as never)]),
      ]),
    );
  } else if (doers.kind === "grant") {
    q = q.where("granted_permissions", "is not", null);
  }
  const rows = await q
    .orderBy("name")
    .orderBy("id")
    .limit(doers.kind === "grant" ? 2000 : DOERS_LISTED)
    .execute();
  return rows
    .filter((r) => accountMayDo(r as Account, doers))
    .slice(0, DOERS_LISTED)
    .map((r) => ({ id: r.id, name: r.name || r.email || "Someone" }));
}

/** The accounts who manage checklists (for a missed day's notice). */
export async function checklistManagers(db: Kysely<CoreDatabase>): Promise<string[]> {
  const rows = await db
    .selectFrom("core_user")
    .select([
      "id",
      "kind",
      "role",
      "pack_role",
      "granted_permissions",
      "deactivated_at",
      "support_grant_id",
    ])
    .where("kind", "=", "human")
    .where("deactivated_at", "is", null)
    .where("pack_role", "is", null)
    // Granted checklists:write itself, not any grant: the limit then counts managers only.
    .where((eb) =>
      eb.or([
        eb("role", "=", "admin"),
        sql<boolean>`json_valid(granted_permissions) AND EXISTS (SELECT 1 FROM json_each(granted_permissions) g WHERE g.value = 'checklists:write')`,
      ]),
    )
    .orderBy("id")
    .limit(500)
    .execute();
  return rows.filter((r) => accountManages(r as Account)).map((r) => r.id);
}

// --- Scheduled templates ------------------------------------------------------------------------

/** A scheduled template, with its steps as they are now. */
export interface Scheduled {
  template: TemplateCopy & { purpose: string | null };
  schedule: Schedule;
}

/** The most scheduled checklists the host reads at once (the template list's own limit). */
export const SCHEDULED_MAX = 500;

/** The active templates with a schedule, without their steps (one read); only `ids` when given. */
async function scheduledRows(
  db: Kysely<CoreDatabase>,
  ids?: readonly string[],
): Promise<{ id: string; purpose: string | null; schedule: Schedule }[]> {
  if (ids && !ids.length) return [];
  let q = db
    .selectFrom("core_checklist")
    .select(["id", "purpose", "days", "due_by", "doers_kind", "doers_value"])
    .where("active", "=", 1)
    .where("days", "is not", null)
    .orderBy("name")
    .orderBy("id")
    .limit(SCHEDULED_MAX);
  if (ids) q = q.where("id", "in", jsonList([...new Set(ids)]));
  return (await q.execute()).flatMap((r) => {
    const schedule = scheduleOf(r);
    return schedule ? [{ id: r.id, purpose: r.purpose, schedule }] : [];
  });
}

/**
 * The active templates with a schedule and 1 to 50 steps, with their steps (three reads), by id;
 * only `ids` when given.
 */
export async function scheduledTemplates(
  db: Kysely<CoreDatabase>,
  ids?: readonly string[],
): Promise<Map<string, Scheduled>> {
  const rows = await scheduledRows(db, ids);
  const copies = await templateCopies(
    db,
    rows.map((r) => r.id),
  );
  const out = new Map<string, Scheduled>();
  for (const r of rows) {
    const copy = copies.get(r.id);
    if (!copy || !copy.steps.length || copy.steps.length > MAX_STEPS) continue;
    out.set(r.id, { template: { ...copy, purpose: r.purpose }, schedule: r.schedule });
  }
  return out;
}

/** A new day run's values. */
export function newDayRunValues(id: string, s: Scheduled, date: string, zone: string, now: string) {
  const w = dayWindow(date, s.schedule.dueBy, zone);
  return {
    id,
    record: dayRecord(s.template.id, date),
    checklist: s.template.id,
    version: s.template.version,
    name: s.template.name,
    steps: s.template.steps as RunStep[],
    opens: w.opens,
    closes: w.closes,
    dueAt: w.dueAt,
    doersKind: s.schedule.doers.kind,
    doersValue: s.schedule.doers.value,
    madeAt: now,
  };
}

/**
 * The statements making day runs, each bound as one JSON value of at most `RUN_CHUNK_BYTES` (well
 * under D1's limit on a bound value: 200 runs of 50 long steps are several), each run only where
 * its day has none (so none fails on one made meanwhile).
 */
export function makeDayRunsStatements(
  runs: readonly ReturnType<typeof newDayRunValues>[],
): CompiledQuery[] {
  const out: CompiledQuery[] = [];
  let chunk: string[] = [];
  let size = 2;
  const flush = () => {
    if (!chunk.length) return;
    out.push(
      CompiledQuery.raw(
        `INSERT INTO core_checklist_run (id, object_type, record_id, checklist_id, version, name,
          steps, account_id, opens, closes, state, made_at, doers_kind, doers_value, due_at)
        SELECT json_extract(j.value, '$.id'), '${DAY_OBJECT}', json_extract(j.value, '$.record'),
          json_extract(j.value, '$.checklist'), json_extract(j.value, '$.version'),
          json_extract(j.value, '$.name'), json_extract(j.value, '$.steps'), NULL,
          json_extract(j.value, '$.opens'), json_extract(j.value, '$.closes'), 'open',
          json_extract(j.value, '$.madeAt'), json_extract(j.value, '$.doersKind'),
          json_extract(j.value, '$.doersValue'), json_extract(j.value, '$.dueAt')
        FROM json_each(?) j
        WHERE NOT EXISTS (SELECT 1 FROM core_checklist_run r
          WHERE r.object_type = '${DAY_OBJECT}' AND r.record_id = json_extract(j.value, '$.record'))`,
        [`[${chunk.join(",")}]`],
      ),
    );
    chunk = [];
    size = 2;
  };
  for (const run of runs) {
    const json = JSON.stringify(run);
    const bytes = new TextEncoder().encode(json).length + 1;
    if (chunk.length && size + bytes > RUN_CHUNK_BYTES) flush();
    chunk.push(json);
    size += bytes;
  }
  flush();
  return out;
}

/**
 * The templates whose day run is to be made now: today's, for every active scheduled template due
 * today that has none yet (two reads; a quiet minute reads no steps).
 */
export async function dayRunsNeeded(
  db: Kysely<CoreDatabase>,
  nowIso: string,
  zone: string,
): Promise<{ date: string; ids: string[] }> {
  const date = today(nowIso, zone);
  const due = (await scheduledRows(db)).filter((r) => dueOn(r.schedule, date));
  if (!due.length) return { date, ids: [] };
  const made = await db
    .selectFrom("core_checklist_run")
    .select("record_id")
    .where("object_type", "=", DAY_OBJECT)
    .where("record_id", "in", jsonList(due.map((r) => dayRecord(r.id, date))))
    .execute();
  const have = new Set(made.map((r) => r.record_id));
  return { date, ids: due.map((r) => r.id).filter((id) => !have.has(dayRecord(id, date))) };
}

/** The most open day runs one minute closes. */
export const DAY_CLOSE_PER_TICK = 200;

/** Open day runs past the end of their day (one read). */
export async function dayRunsEnded(
  db: Kysely<CoreDatabase>,
  now: number,
  limit = DAY_CLOSE_PER_TICK,
) {
  return (
    db
      .selectFrom("core_checklist_run")
      .selectAll()
      // core_checklist_run_open's predicate written out, and `+` so the planner does not walk the
      // (object_type, ...) key instead: that read every day run ever made, every minute.
      .where(sql<boolean>`state = 'open'`)
      .where(sql<boolean>`+object_type = ${DAY_OBJECT}`)
      .where("closes", "<=", now)
      .orderBy("closes")
      .limit(limit)
      .execute()
  );
}

/** Whether there is a day's checklist work of `step` now (read outside any operation). */
export async function dayWorkDue(
  db: Kysely<CoreDatabase>,
  nowIso: string,
  zone: string,
  step: "close" | "make",
): Promise<boolean> {
  if (step === "close") {
    return (await dayRunsEnded(db, Math.floor(Date.parse(nowIso) / 1000), 1)).length > 0;
  }
  return (await dayRunsNeeded(db, nowIso, zone)).ids.length > 0;
}
