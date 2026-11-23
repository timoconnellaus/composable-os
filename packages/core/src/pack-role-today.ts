// A pack role limited to today (stage 31a step 7, ADR 0553): a role may declare, by object, the
// moment its holder's reach is limited to (`today: { "bookings.class": { at: "startsAt", until:
// "endsAt", zone: "timezone" } }`). While a call carries the limit (the account holds the role,
// or a tool run it started, nested runs included), a record of such an object is reached only
// when it is on today: its start falls on today's date in its own zone (the organisation's when
// it has none), or it has started and not yet ended (a class running past midnight). The limit is
// held before the operation runs:
//   - record.list: a predicate in the list's own query (before its limit, count and cursor);
//   - record.get, record.update: the stored record is checked, else it is not found;
//   - any other operation naming a limited object (count, create, batch, …): refused.
// The coach sees today's classes and lists and ticks today's names; nobody else is limited.
import type { CoreDatabase } from "@composable-os/db";
import { CompiledQuery, type Kysely } from "kysely";
import { healthListOf } from "./agreements/health-list.ts";
import { ForbiddenError, NotFoundError } from "./errors.ts";
import { getObject } from "./fields/index.ts";
import type { ObjectDefinition } from "./fields/types.ts";
import { viewColumnOf } from "./records/columns.ts";
import { loadGeneralSettings } from "./settings.ts";
import { localParts } from "./time/local.ts";

/** One limited object's moment: a datetime path, or with its end and zone (same relation). */
export type TodayLimit = string | { at: string; until?: string; zone?: string };
export type TodayLimits = Readonly<Record<string, TodayLimit>>;

/** How far around now the candidates are read (local today in any zone, and running classes). */
const BEFORE_MS = 3 * 86_400_000;
const AFTER_MS = 2 * 86_400_000;

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

interface Plan {
  /** The limited object's relation field to the record holding the moment; null: itself. */
  relation: string | null;
  relationColumn: string | null;
  target: ObjectDefinition;
  atColumn: string;
  untilColumn: string | null;
  zoneColumn: string | null;
}

/** The registry's columns for a limit, or null when the limit names nothing it can read. */
function planOf(objectName: string, limit: TodayLimit): Plan | null {
  const object = getObject(objectName);
  if (!object) return null;
  const spec = typeof limit === "string" ? { at: limit } : limit;
  const split = (path: string) => {
    const parts = path.split(".");
    return parts.length === 2 ? { rel: parts[0] as string, field: parts[1] as string } : null;
  };
  const at = split(spec.at);
  const relation = at?.rel ?? null;
  let target: ObjectDefinition | undefined = object;
  let relationColumn: string | null = null;
  if (relation) {
    const rel = object.fields.find((f) => f.name === relation);
    target = rel?.options?.to ? getObject(rel.options.to) : undefined;
    relationColumn = rel ? viewColumnOf(rel) : null;
    if (!target || !relationColumn) return null;
  } else if (spec.at.includes(".")) {
    return null;
  }
  const columnOf = (path: string | undefined) => {
    if (path === undefined) return undefined;
    const p = split(path);
    if ((p?.rel ?? null) !== relation) return null;
    const name = p ? p.field : path;
    const field = (target as ObjectDefinition).fields.find((f) => f.name === name);
    return field ? viewColumnOf(field) : null;
  };
  const atColumn = columnOf(spec.at);
  const untilColumn = columnOf(spec.until);
  const zoneColumn = columnOf(spec.zone);
  if (!atColumn || untilColumn === null || zoneColumn === null) return null;
  return {
    relation,
    relationColumn,
    target,
    atColumn,
    untilColumn: untilColumn ?? null,
    zoneColumn: zoneColumn ?? null,
  };
}

const dayOf = (at: number | string, zone: string) => {
  const p = localParts(at, zone);
  return `${p.year}-${p.month}-${p.day}`;
};

/** Whether a moment row is on today: its start's local date is today's, or it is running. */
function onToday(row: Record<string, unknown>, plan: Plan, now: number, orgZone: string): boolean {
  const at = row[plan.atColumn];
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) return false;
  const zoneValue = plan.zoneColumn ? row[plan.zoneColumn] : null;
  const zone = typeof zoneValue === "string" && zoneValue ? zoneValue : orgZone;
  if (dayOf(at, zone) === dayOf(now, zone)) return true;
  const until = plan.untilColumn ? row[plan.untilColumn] : null;
  return (
    Date.parse(at) <= now &&
    typeof until === "string" &&
    !Number.isNaN(Date.parse(until)) &&
    Date.parse(until) > now
  );
}

/** The ids of the moment's records on today (read from the stored rows, org-wide). */
async function reachableIds(db: Kysely<CoreDatabase>, plan: Plan, now: number): Promise<string[]> {
  const orgZone = (await loadGeneralSettings(db)).timezone;
  const cols = [plan.atColumn, plan.untilColumn, plan.zoneColumn].filter(
    (c): c is string => c !== null,
  );
  const at = ident(plan.atColumn);
  const { rows } = await db.executeQuery<Record<string, unknown>>(
    CompiledQuery.raw(
      `SELECT id, ${cols.map(ident).join(", ")} FROM ${ident(plan.target.source)} WHERE ${at} IS NOT NULL AND julianday(${at}) >= julianday(?) AND julianday(${at}) <= julianday(?) LIMIT 2000`,
      [new Date(now - BEFORE_MS).toISOString(), new Date(now + AFTER_MS).toISOString()],
    ),
  );
  return rows.filter((r) => onToday(r, plan, now, orgZone)).map((r) => String(r.id));
}

/** Whether the stored record `id` of the limited object is on today. */
async function reachable(
  db: Kysely<CoreDatabase>,
  objectName: string,
  plan: Plan,
  id: string,
  now: number,
): Promise<boolean> {
  const object = getObject(objectName);
  if (!object) return false;
  let targetId = id;
  if (plan.relationColumn) {
    const { rows } = await db.executeQuery<Record<string, unknown>>(
      CompiledQuery.raw(
        `SELECT ${ident(plan.relationColumn)} AS rel FROM ${ident(object.source)} WHERE id = ?`,
        [id],
      ),
    );
    const rel = rows[0]?.rel;
    if (typeof rel !== "string" || !rel) return false;
    targetId = rel;
  }
  const cols = [plan.atColumn, plan.untilColumn, plan.zoneColumn].filter(
    (c): c is string => c !== null,
  );
  const { rows } = await db.executeQuery<Record<string, unknown>>(
    CompiledQuery.raw(
      `SELECT ${cols.map(ident).join(", ")} FROM ${ident(plan.target.source)} WHERE id = ?`,
      [targetId],
    ),
  );
  const row = rows[0];
  if (!row) return false;
  return onToday(row, plan, now, (await loadGeneralSettings(db)).timezone);
}

/**
 * Holds `limits` on one call, before it runs: returns the input to run (a list with the limit's
 * predicate added), or throws (not found for a record that is not today's; forbidden for an
 * operation on a limited object the limit cannot check, or a limit naming nothing readable).
 */
export async function holdRoleToday(
  db: Kysely<CoreDatabase>,
  limits: TodayLimits | null | undefined,
  operation: string,
  input: unknown,
  now = Date.now(),
): Promise<unknown> {
  if (!limits) return input;
  const record = (input ?? {}) as Record<string, unknown>;
  // A health-note list names its list's own record by `value` (stage 44, ADR 0643): held to the
  // role's limit on that record's object, as a record.get of it would be.
  if (operation === "agreement.listHealthNotes" && typeof record.records === "string") {
    const list = healthListOf(record.records);
    if (!list) return input;
    const limited = [list.parent.name, list.object.name].filter((o) => Object.hasOwn(limits, o));
    if (!limited.length) return input;
    const plan = Object.hasOwn(limits, list.parent.name)
      ? planOf(list.parent.name, limits[list.parent.name] as TodayLimit)
      : null;
    const id = String(record.value ?? "");
    if (!plan || !(await reachable(db, list.parent.name, plan, id, now))) {
      throw new NotFoundError(list.parent.name, id);
    }
    return input;
  }
  const object = record.object;
  if (typeof object !== "string" || !Object.hasOwn(limits, object)) return input;
  const plan = planOf(object, limits[object] as TodayLimit);
  const refuse = () =>
    new ForbiddenError(
      `${operation} on ${object} is not open to this role: it reaches today's records only`,
      { rule: "role_today", object, operation },
    );
  if (!plan) throw refuse();
  if (operation === "record.list") {
    const ids = await reachableIds(db, plan, now);
    const condition = {
      field: plan.relation ?? "id",
      op: "in",
      // An empty list matches nothing; a value no record has keeps the predicate valid.
      value: ids.length ? ids : ["none"],
    };
    const filter = record.filter ? { and: [record.filter, condition] } : condition;
    return { ...record, filter };
  }
  if (operation === "record.get" || operation === "record.update") {
    const id = String(record.id ?? "");
    if (!(await reachable(db, object, plan, id, now))) throw new NotFoundError(object, id);
    return input;
  }
  throw refuse();
}
