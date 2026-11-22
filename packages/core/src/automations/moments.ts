// Date-relative triggers counted in minutes (ADR 0570): a run some minutes before or after a
// datetime field of each live record (a reminder three hours before a class, a notice an hour
// after it ends). The minutes are a number, or read per record as a window's are (ADR 0505): a
// number field of the record or one relation away, else the extension's number setting.
//
// The minute cron asks which records are due now. A record is due when its moment has passed and
// is no older than the look-back (a tick or two missed by the runner is caught up; a record made
// after its moment, a class added two hours before its start with a three-hour reminder, is not).
// The run's idempotency key is the record and the field's value, so each value is run once however
// many ticks see it, and a record whose time changes is due again at its new time.
import type { CoreDatabase } from "@composable-os/db";
import { MAX_MOMENT_MINUTES, type MomentMinutes } from "@composable-os/sdk";
import { type Kysely, sql } from "kysely";
import { registryFieldName } from "../extensions/naming.ts";
import { refreshSchemaRegistry } from "../extensions/schema.ts";
import { getObject } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import { viewColumnOf } from "../records/columns.ts";
import { extensionSettingValues } from "../records/windows.ts";
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
 * Where a record's minutes come from: a column of the record, or of the record one relation
 * points to (read once for every record of that object, which is small: class types), and the
 * setting. Null when the path names no column (the registry changed under the declaration).
 */
interface MinutesPlan {
  ownColumn: string | null;
  relation: { column: string; values: Map<string, number | null> } | null;
  setting: number | null;
  /** The largest minutes any record can have, which bounds the rows read. */
  max: number;
}

async function minutesPlan(
  db: Kysely<CoreDatabase>,
  def: ObjectDefinition,
  minutes: Exclude<MomentMinutes, number>,
): Promise<MinutesPlan | null> {
  const ext = def.extension;
  const settings = minutes.setting && ext ? await extensionSettingValues(db, ext) : {};
  const settingValue = minutes.setting ? asNumber(settings[minutes.setting]) : null;
  const setting = settingValue === null ? null : clampMinutes(settingValue);
  if (!minutes.field) return { ownColumn: null, relation: null, setting, max: setting ?? 0 };
  const parts = minutes.field.split(".");
  if (parts.length === 1) {
    const field = def.fields.find((f) => f.name === parts[0]);
    const column = field ? viewColumnOf(field) : null;
    if (!column) return null;
    // Read per record: bounded by the declared max (a week at most).
    return { ownColumn: column, relation: null, setting, max: MAX_MOMENT_MINUTES };
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
  const rows = (await (db as AnyDb)
    .selectFrom(visibleSource(orgReader(db), target))
    .select(["id", sql.ref(column).as("value")])
    .limit(MAX_ROWS)
    .execute()) as { id: string; value: unknown }[];
  const values = new Map<string, number | null>();
  let max = setting ?? 0;
  for (const row of rows) {
    const n = asNumber(row.value);
    const v = n === null ? null : clampMinutes(n);
    values.set(row.id, v);
    if (v !== null && v > max) max = v;
  }
  return { ownColumn: null, relation: { column: relationColumn, values }, setting, max };
}

/**
 * The live records of a minutes trigger whose moment is due at `at`: passed, and no more than
 * MOMENT_LOOKBACK_MINUTES ago. Oldest moment first, at most `limit`.
 */
export async function recordsAtMoment(
  db: Kysely<CoreDatabase>,
  trigger: MomentTrigger,
  at: Date,
  limit: number,
): Promise<MomentMatch[]> {
  const minutes = trigger.minutesBefore ?? trigger.minutesAfter;
  if (minutes === undefined) return [];
  const sign = trigger.minutesBefore !== undefined ? -1 : 1;
  await refreshSchemaRegistry(db);
  const def = getObject(trigger.object);
  const anchorField = def?.fields.find((f) => f.name === trigger.field);
  const anchorColumn = anchorField ? viewColumnOf(anchorField) : null;
  if (!def || !anchorColumn) return [];
  const plan: MinutesPlan | null =
    typeof minutes === "number"
      ? {
          ownColumn: null,
          relation: null,
          setting: clampMinutes(minutes),
          max: clampMinutes(minutes),
        }
      : await minutesPlan(db, def, minutes);
  if (!plan) return [];
  const now = at.getTime();
  const lookback = MOMENT_LOOKBACK_MINUTES * 60_000;
  // moment = anchor + sign × m, due when now − lookback < moment ≤ now, for m in [0, max].
  const span = plan.max * 60_000;
  const from = new Date(sign < 0 ? now - lookback : now - lookback - span).toISOString();
  const until = new Date(sign < 0 ? now + span : now).toISOString();
  const extra = [plan.ownColumn, plan.relation?.column].filter((c): c is string => Boolean(c));
  const rows = await (db as AnyDb)
    .selectFrom(visibleSource(orgReader(db), def))
    .select([
      "id",
      sql.ref(anchorColumn).as("anchor"),
      ...extra.map((c, i) => sql.ref(c).as(`c${i}`)),
    ])
    .where(sql.ref(anchorColumn), "is not", null)
    .where(sql`julianday(${sql.ref(anchorColumn)})`, ">", sql`julianday(${from})`)
    .where(sql`julianday(${sql.ref(anchorColumn)})`, "<=", sql`julianday(${until})`)
    .orderBy(sql`julianday(${sql.ref(anchorColumn)})`)
    .orderBy("id")
    .limit(MAX_ROWS)
    .execute();
  const out: MomentMatch[] = [];
  for (const row of rows as Record<string, unknown>[]) {
    const instant = typeof row.anchor === "string" ? Date.parse(row.anchor) : Number.NaN;
    if (Number.isNaN(instant)) continue;
    let m: number | null = null;
    if (plan.ownColumn) m = asNumber(row.c0);
    else if (plan.relation) {
      const related = row.c0;
      m = typeof related === "string" ? (plan.relation.values.get(related) ?? null) : null;
    }
    if (m === null) m = plan.setting;
    else m = clampMinutes(m);
    // No number anywhere: the moment cannot be worked out, and nothing is run.
    if (m === null) continue;
    const moment = instant + sign * m * 60_000;
    if (moment > now || moment <= now - lookback) continue;
    out.push({
      id: String(row.id),
      anchor: new Date(instant).toISOString(),
      moment: new Date(moment).toISOString(),
    });
    if (out.length >= limit) break;
  }
  out.sort((a, b) => a.moment.localeCompare(b.moment) || a.id.localeCompare(b.id));
  return out;
}
