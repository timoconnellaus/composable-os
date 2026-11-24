// The `* * * * *` cron (ADR 0130): schedule triggers whose cron matches this minute in the
// automation timezone, and once a day (the first tick from 00:05 local) date-relative triggers.
// Idempotency keys are per period (`<minute>` for schedules, `<recordId>:<date>` for date-relative
// matches), so a repeated tick never starts a second run.
import {
  type AutomationSettings,
  addDaysToDate,
  cronMatches,
  FAN_OUT_BUDGET,
  loadAutomationSettings,
  loadEnabledAutomations,
  type RunCandidate,
  recordsAtMoment,
  recordsOnDate,
  recordsOnLocalDate,
  zonedTime,
} from "@composable-os/core";
import { type CrmDb, createCrmDb } from "@composable-os/db";
import { type CandidateOrigin, type DispatchEnv, type StartResult, startRuns } from "./dispatch.ts";

/** core_automation_counters row that marks the day's date-relative scan as done. */
export const DATE_RELATIVE_MARKER = "~dateRelative";
/** Marks an hour's scan of date-relative triggers counted in each record's own zone (ADR 0460). */
export const ZONED_DATE_RELATIVE_MARKER = "~dateRelativeZoned";

/** A cron scan's origin: it starts a cascade of its own, the scan's id its root and event. */
function scanOrigin(id: string, at: string): CandidateOrigin {
  return { depth: 0, chain: [], rootEventId: id, eventId: id, at };
}

/**
 * Runs `scan` once per `key` (a day, an hour): `marker`'s core_automation_counters row for the key
 * says it ran. Null when it already had.
 */
async function onceFor(
  crm: CrmDb,
  marker: string,
  key: string,
  scan: () => Promise<StartResult>,
): Promise<StartResult | null> {
  const done = await crm.query
    .selectFrom("core_automation_counters")
    .select("hour")
    .where("automation_id", "=", marker)
    .where("hour", "=", key)
    .executeTakeFirst();
  if (done) return null;
  const result = await scan();
  await crm.query
    .insertInto("core_automation_counters")
    .values({ automation_id: marker, hour: key, runs: 1, writes: 0 })
    .onConflict((oc) => oc.doNothing())
    .execute();
  return result;
}

export async function runAutomationCron(
  env: DispatchEnv,
  at: Date = new Date(),
): Promise<{
  schedule: StartResult | null;
  dateRelative: StartResult | null;
  zonedDateRelative: StartResult | null;
  moments: StartResult | null;
}> {
  const crm = createCrmDb(env.DB);
  const settings = await loadAutomationSettings(crm.query);
  if (settings.killSwitch) {
    return { schedule: null, dateRelative: null, zonedDateRelative: null, moments: null };
  }
  const local = zonedTime(at, settings.timezone);
  const iso = at.toISOString();

  let schedule: StartResult | null = null;
  const schedules = await loadEnabledAutomations(crm.query, ["schedule"]);
  const due: RunCandidate[] = schedules
    .filter((a) => a.spec.trigger.type === "schedule" && cronMatches(a.spec.trigger.cron, local))
    .map((a) => ({ automation: a, idempotencyKey: local.minuteKey, period: local.minuteKey }));
  if (due.length) {
    schedule = await startRuns(
      env,
      due,
      scanOrigin(`schedule:${local.minuteKey}`, iso),
      { now: at },
      settings,
    );
  }

  const dateRelative =
    local.hour > 0 || local.minute >= 5
      ? await onceFor(crm, DATE_RELATIVE_MARKER, local.date, () =>
          runDateRelative(env, local.date, iso, settings),
        )
      : null;
  // Triggers counted in each record's own zone: once an hour, from five past, so a record's
  // local day is seen within its first hour wherever it is (ADR 0460).
  const zonedDateRelative =
    at.getUTCMinutes() >= 5
      ? await onceFor(crm, ZONED_DATE_RELATIVE_MARKER, iso.slice(0, 13), () =>
          runZonedDateRelative(env, at, settings),
        )
      : null;
  // Triggers counted in minutes (ADR 0570): every tick.
  const moments = await runMomentDateRelative(env, at, settings);
  return { schedule, dateRelative, zonedDateRelative, moments };
}

/**
 * Date-relative matches of the triggers counted in minutes (ADR 0570): records whose moment (some
 * minutes before or after a datetime field) has passed within the look-back. The idempotency key
 * is the record and the field's value, so every tick that sees a moment starts one run for it,
 * and a record whose time changed is due again at its new one. Null when no trigger counts in
 * minutes (one read of the enabled automations, as the day scans make).
 */
export async function runMomentDateRelative(
  env: DispatchEnv,
  at: Date,
  settings?: AutomationSettings,
): Promise<StartResult | null> {
  const db = createCrmDb(env.DB).query;
  const automations = (await loadEnabledAutomations(db, ["dateRelative"])).filter(
    (a) =>
      a.spec.trigger.type === "dateRelative" &&
      (a.spec.trigger.minutesBefore !== undefined || a.spec.trigger.minutesAfter !== undefined),
  );
  if (!automations.length) return null;
  const candidates: RunCandidate[] = [];
  for (const a of automations) {
    const t = a.spec.trigger;
    if (t.type !== "dateRelative") continue;
    const matches = await recordsAtMoment(
      db,
      {
        object: t.object,
        field: t.field,
        ...(t.minutesBefore !== undefined ? { minutesBefore: t.minutesBefore } : {}),
        ...(t.minutesAfter !== undefined ? { minutesAfter: t.minutesAfter } : {}),
      },
      at,
      FAN_OUT_BUDGET,
      // Its conditions and the runs it already made are left out in the query, so a busy tick
      // never starves the records after the first page.
      {
        ...(a.spec.conditions ? { conditions: a.spec.conditions } : {}),
        automationId: a.id,
        userId: a.ownerUserId ?? `extension:${a.extensionId}`,
      },
    );
    for (const { id, anchor, moment } of matches) {
      candidates.push({
        automation: a,
        idempotencyKey: `${id}:${anchor}`,
        record: { object: t.object, id },
        period: moment,
      });
    }
  }
  const iso = at.toISOString();
  return startRuns(
    env,
    candidates,
    scanOrigin(`dateRelativeMoment:${iso.slice(0, 16)}`, iso),
    { now: at },
    settings,
  );
}

/**
 * Date-relative matches of the triggers that name a `zoneField` (ADR 0460): each record's day is
 * counted in its own time zone, and is due on that zone's day. The idempotency key is the record
 * and that local day, so the hourly scans start one run per record per day.
 */
export async function runZonedDateRelative(
  env: DispatchEnv,
  at: Date,
  settings?: AutomationSettings,
): Promise<StartResult> {
  const db = createCrmDb(env.DB).query;
  const loaded = settings ?? (await loadAutomationSettings(db));
  const automations = await loadEnabledAutomations(db, ["dateRelative"]);
  const candidates: RunCandidate[] = [];
  for (const a of automations) {
    const t = a.spec.trigger;
    if (t.type !== "dateRelative" || !t.zoneField || t.offsetDays === undefined) continue;
    const matches = await recordsOnLocalDate(
      db,
      { object: t.object, field: t.field, zoneField: t.zoneField, offsetDays: t.offsetDays },
      at,
      loaded.timezone,
      FAN_OUT_BUDGET,
    );
    for (const { id, day } of matches) {
      candidates.push({
        automation: a,
        idempotencyKey: `${id}:${day}`,
        record: { object: t.object, id },
        period: day,
      });
    }
  }
  const iso = at.toISOString();
  return startRuns(
    env,
    candidates,
    scanOrigin(`dateRelativeZoned:${iso.slice(0, 13)}`, iso),
    {},
    loaded,
  );
}

/** Date-relative matches for `date` (local): records whose date field is `date - offsetDays`. */
export async function runDateRelative(
  env: DispatchEnv,
  date: string,
  at: string,
  settings?: AutomationSettings,
): Promise<StartResult> {
  const db = createCrmDb(env.DB).query;
  const automations = await loadEnabledAutomations(db, ["dateRelative"]);
  const candidates: RunCandidate[] = [];
  for (const a of automations) {
    const t = a.spec.trigger;
    // A trigger counted in each record's own zone is the hourly scan's (runZonedDateRelative).
    // Counted in minutes: the minute scan's (runMomentDateRelative).
    if (t.type !== "dateRelative" || t.zoneField || t.offsetDays === undefined) continue;
    const target = addDaysToDate(date, -t.offsetDays);
    const ids = await recordsOnDate(db, t.object, t.field, target, FAN_OUT_BUDGET);
    for (const id of ids) {
      candidates.push({
        automation: a,
        idempotencyKey: `${id}:${date}`,
        record: { object: t.object, id },
        period: date,
      });
    }
  }
  return startRuns(env, candidates, scanOrigin(`dateRelative:${date}`, at), {}, settings);
}
