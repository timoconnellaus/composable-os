// Date-relative triggers counted in minutes (ADR 0570): a run some minutes before or after a
// datetime field of each live record (a reminder three hours before a class, a notice an hour
// after it ends). The minutes are a number, or read per record as a window's are (ADR 0505): a
// number field of the record or one relation away, else the extension's number setting.
//
// The minute cron asks which records are due now. A record is due when its moment has passed and
// is no older than the 15-minute look-back: a tick or two missed by the runner is caught up, and a
// record made within 15 minutes after its moment is still run; one made later (a class added two
// hours before its start with a three-hour reminder) is not.
// The run's idempotency key is the record and the field's value, so each value is run once however
// many ticks see it, and a record whose time changes is due again at its new time.
import type { CoreDatabase } from "@composable-os/db";
import { MAX_MOMENT_MINUTES, type MomentMinutes, type ViewFilter } from "@composable-os/sdk";
import { type Kysely, type RawBuilder, sql } from "kysely";
import { registryFieldName } from "../extensions/naming.ts";
import { refreshSchemaRegistry } from "../extensions/schema.ts";
import { getObject } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import { compileFilter, type Filter } from "../filter.ts";
import { viewColumnOf } from "../records/columns.ts";
import { extensionSettingValues } from "../records/windows.ts";
import { resolveRelative } from "../relative.ts";
import { orgReader, visibleSource } from "../visibility/index.ts";

/** How long after its moment a record is still run (missed ticks); older ones are not. */
export const MOMENT_LOOKBACK_MINUTES = 15;
/** The most records one trigger reads in a tick. */
const MAX_ROWS = 2_000;

export interface MomentTrigger {
  object: string;
  field: string;
  minutesBefore?: MomentMinutes;
  minutesAfter?: MomentMinutes;
}

export interface MomentMatch {
  id: string;
  /** The field's value, as an ISO instant: what the run's key is made of. */
  anchor: string;
  /** When it was due, as an ISO instant (the run's period). */
  moment: string;
}

// biome-ignore lint/suspicious/noExplicitAny: rec_* views are not in CoreDatabase; names come from the registry.
type AnyDb = Kysely<any>;

const asNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
};

const clampMinutes = (n: number) => Math.min(Math.max(0, n), MAX_MOMENT_MINUTES);

/**
 * Where a record's minutes come from, as SQL over the record (`r`) and, one relation away, the
 * record it points to (`t`): its number, else the setting. The largest any record can have
 * bounds the rows the range reads (the start-time index), and the moment itself is then compared
 * in SQL, so only due rows are read. Null when the path names no column.
 */
interface MinutesPlan {
  /** SQL for the record's minutes (NULL when none can be worked out). */
  expr: RawBuilder<number | null>;
  /** The related object to join, and the relation's column on the record. */
  join: { target: ObjectDefinition; column: string } | null;
  max: number;
}

const clamp = (column: RawBuilder<unknown>) =>
  sql<number | null>`max(0, min(${MAX_MOMENT_MINUTES}, ${column}))`;

async function minutesPlan(
  db: Kysely<CoreDatabase>,
  def: ObjectDefinition,
  minutes: MomentMinutes,
): Promise<MinutesPlan | null> {
  if (typeof minutes === "number") {
    const n = clampMinutes(minutes);
    return { expr: sql<number>`${n}`, join: null, max: n };
  }
  const ext = def.extension;
  const settings = minutes.setting && ext ? await extensionSettingValues(db, ext) : {};
  const settingValue = minutes.setting ? asNumber(settings[minutes.setting]) : null;
  const setting = settingValue === null ? null : clampMinutes(settingValue);
  const orSetting = (own: RawBuilder<unknown>) =>
    sql<number | null>`coalesce(${clamp(own)}, ${setting})`;
  if (!minutes.field)
    return { expr: sql<number | null>`${setting}`, join: null, max: setting ?? 0 };
  const parts = minutes.field.split(".");
  if (parts.length === 1) {
    const field = def.fields.find((f) => f.name === parts[0]);
    const column = field ? viewColumnOf(field) : null;
    if (!column) return null;
    // Read per record: bounded by the declared max (a week at most).
    return { expr: orSetting(sql.ref(`r.${column}`)), join: null, max: MAX_MOMENT_MINUTES };
  }
  const [relationName, local] = parts as [string, string];
  const rel = def.fields.find((f) => f.name === relationName);
  const target = rel?.options?.to ? getObject(rel.options.to) : undefined;
  const relationColumn = rel ? viewColumnOf(rel) : null;
  if (!target || !relationColumn || !ext) return null;
  const name = registryFieldName(ext, target.name, local);
  const field = target.fields.find((f) => f.name === name);
  const column = field ? viewColumnOf(field) : null;
  if (!column) return null;
  // The minute cron's own read, for the whole org (ADR 0244: automations act org-wide).
  const largest = (await (db as AnyDb)
    .selectFrom(visibleSource(orgReader(db), target, "t"))
    .select(sql<number | null>`max(${clamp(sql.ref(`t.${column}`))})`.as("n"))
    .executeTakeFirst()) as { n: number | null } | undefined;
  return {
    expr: orSetting(sql.ref(`t.${column}`)),
    join: { target, column: relationColumn },
    max: Math.max(asNumber(largest?.n) ?? 0, setting ?? 0),
  };
}

export interface MomentOptions {
  /** The trigger's conditions, checked in the same query (the view filter language). */
  conditions?: ViewFilter;
  /** The automation's id: records it already ran for this value of the field are left out. */
  automationId?: string;
  /** Who relative values in the conditions resolve against (`me`). */
  userId?: string;
}

/**
 * The live records of a minutes trigger whose moment is due at `at`: passed, and no more than
 * MOMENT_LOOKBACK_MINUTES ago, matching the trigger's conditions, and not yet run for this value
 * of the field. Oldest moment first, at most `limit`: every row read is due.
 */
export async function recordsAtMoment(
  db: Kysely<CoreDatabase>,
  trigger: MomentTrigger,
  at: Date,
  limit: number,
  options: MomentOptions = {},
): Promise<MomentMatch[]> {
  const minutes = trigger.minutesBefore ?? trigger.minutesAfter;
  if (minutes === undefined) return [];
  const sign = trigger.minutesBefore !== undefined ? -1 : 1;
  await refreshSchemaRegistry(db);
  const def = getObject(trigger.object);
  const anchorField = def?.fields.find((f) => f.name === trigger.field);
  const anchorColumn = anchorField ? viewColumnOf(anchorField) : null;
  if (!def || !anchorColumn) return [];
  const plan = await minutesPlan(db, def, minutes);
  if (!plan) return [];
  const now = at.getTime();
  const lookback = MOMENT_LOOKBACK_MINUTES * 60_000;
  // moment = anchor + sign × m, due when now − lookback < moment ≤ now. The anchor's range for
  // m in [0, max] uses the index; the moment itself is then compared exactly.
  const span = plan.max * 60_000;
  const from = new Date(sign < 0 ? now - lookback : now - lookback - span).toISOString();
  const until = new Date(sign < 0 ? now + span : now).toISOString();
  const anchor = sql.ref(`r.${anchorColumn}`);
  const moment = sql<number>`julianday(${anchor}) + ${sign} * ${plan.expr} / 1440.0`;
  const anchorIso = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', ${anchor})`;
  let query = (db as AnyDb)
    .selectFrom(visibleSource(orgReader(db), def, "r"))
    .select([
      "r.id as id",
      anchorIso.as("anchor"),
      sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', ${moment})`.as("moment"),
    ])
    .where(anchor, "is not", null)
    .where(sql`julianday(${anchor})`, ">", sql`julianday(${from})`)
    .where(sql`julianday(${anchor})`, "<=", sql`julianday(${until})`)
    .where(plan.expr, "is not", null)
    .where(sql<boolean>`${moment} <= julianday(${at.toISOString()})`)
    .where(sql<boolean>`${moment} > julianday(${new Date(now - lookback).toISOString()})`);
  if (plan.join) {
    query = query.leftJoin(
      visibleSource(orgReader(db), plan.join.target, "t"),
      "t.id",
      `r.${plan.join.column}`,
    );
  }
  if (options.conditions) {
    const filter = resolveRelative(
      options.conditions,
      options.userId ?? `extension:${def.extension ?? ""}`,
      at.toISOString(),
    ) as Filter;
    query = query.where(compileFilter(def, filter, "r"));
  }
  if (options.automationId) {
    // A record this automation already ran for at this value of the field (the run's key).
    query = query.where(
      sql<boolean>`NOT EXISTS (SELECT 1 FROM core_automation_runs x WHERE x.automation_id = ${options.automationId} AND x.record_object = ${trigger.object} AND x.record_id = r.id AND json_extract(x.trigger, '$.key') = r.id || ':' || ${anchorIso})`,
    );
  }
  const rows = (await query
    .orderBy(moment)
    .orderBy("r.id")
    .limit(Math.min(limit, MAX_ROWS))
    .execute()) as { id: string; anchor: string; moment: string }[];
  return rows.map((row) => ({ id: String(row.id), anchor: row.anchor, moment: row.moment }));
}
