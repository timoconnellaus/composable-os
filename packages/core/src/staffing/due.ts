// The roster's minute-cron work (stage 45 step 3, ADRs 0623 and 0624), run as the host through
// `staffing.due`:
//
// - **Lapsing**: an open offer whose shift starts within the cut-off lapses (the offerer is told it
//   is still theirs; the rosterers are told), and one whose shift is gone, in the Trash or no
//   longer live is cancelled. With nothing open it is one indexed read.
// - **The daily uncovered notice**: once a local day, from 07:00 in the organisation's zone, the
//   rosterers are told every live shift with nobody on it in the uncovered window, if any.
import type { CoreDatabase } from "@composable-os/db";
import { type Kysely, sql } from "kysely";
import { objectTableOf } from "../extensions/schema.ts";
import { listObjects } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import { loadGeneralSettings } from "../settings.ts";
import { localParts } from "../time/local.ts";
import { shiftTitle, shiftZone } from "./changes.ts";
import { loadShift, UNCOVERED_WINDOW_DAYS } from "./index.ts";
import { endOfferStatement, OFFER_CUTOFF_MINUTES, pastCutoff, whenOf } from "./offers.ts";
import { queueNotice, rosterers, shiftLink, staffName } from "./rosterers.ts";

/** The most open offers one tick looks at. */
const OFFERS_PER_TICK = 50;
/** The local hour the daily uncovered notice is sent from (guess). */
const DAILY_NOTICE_HOUR = 7;
/** The most uncovered shifts one read returns, per object. */
const UNCOVERED_MAX = 200;

export interface UncoveredShift {
  object: string;
  id: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
}

const column = (object: ObjectDefinition, field: string | undefined) =>
  (field && object.fields.find((f) => f.name === field)?.column) || null;

/**
 * Every live shift with nobody on it starting in [`from`, `until`) (unix seconds), in order of
 * start. Read through each staffed object's index on its person field (an uncovered shift's is
 * empty), so a long covered history is never read.
 */
export async function uncoveredShifts(
  ctx: Pick<HandlerContext, "db">,
  from: number,
  until: number,
): Promise<UncoveredShift[]> {
  const out: UncoveredShift[] = [];
  for (const object of listObjects()) {
    const def = object.staffed;
    const table = def ? objectTableOf(object.name) : undefined;
    const who = def ? column(object, def.who.field) : null;
    const starts = def ? column(object, def.starts) : null;
    const ends = def ? column(object, def.ends) : null;
    const state = column(object, object.states?.field);
    if (!def || !table || !who || !starts || !ends || !state) continue;
    const title = column(object, object.titleField);
    const rows = await sql<{
      id: string;
      title: string | null;
      starts: string;
      ends: string | null;
    }>`SELECT id, ${title ? sql.ref(title) : sql`NULL`} AS title, ${sql.ref(starts)} AS starts, ${sql.ref(
      ends,
    )} AS ends FROM ${sql.table(table)} WHERE ${sql.ref(who)} IS NULL AND deleted_at IS NULL AND ${sql.ref(
      state,
    )} IN (${sql.join(def.live.map((s) => sql`${s}`))}) AND CAST(strftime('%s', ${sql.ref(
      starts,
    )}) AS INTEGER) >= ${from} AND CAST(strftime('%s', ${sql.ref(starts)}) AS INTEGER) < ${until} ORDER BY ${sql.ref(
      starts,
    )} LIMIT ${UNCOVERED_MAX}`.execute(ctx.db);
    for (const row of rows.rows) {
      out.push({
        object: object.name,
        id: row.id,
        title: row.title || object.label,
        startsAt: new Date(row.starts).toISOString(),
        endsAt: row.ends ? new Date(row.ends).toISOString() : null,
      });
    }
  }
  return out.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/** The latest shift start whose offer has closed at `now` (unix seconds). */
const cutoffOf = (now: string) => Math.floor(Date.parse(now) / 1000) + OFFER_CUTOFF_MINUTES * 60;

/** Open offers past their cut-off lapse; those whose shift is gone are cancelled. */
async function lapseOffers(ctx: HandlerContext): Promise<{ lapsed: number; cancelled: number }> {
  // The offers whose cut-off has come, nearest first, by the index on their shift's start: however
  // many far ones are open, these are read.
  const open = await ctx.db
    .selectFrom("core_staff_offer")
    .selectAll()
    .where("state", "=", "open")
    .where("starts", "<=", cutoffOf(ctx.now))
    .orderBy("starts")
    .limit(OFFERS_PER_TICK)
    .execute();
  let lapsed = 0;
  let cancelled = 0;
  let told: string[] | null = null;
  for (const offer of open) {
    const s = await loadShift(ctx, offer.object_type, offer.record_id);
    const link = shiftLink(offer.object_type, offer.record_id);
    if (!s || s.deleted || !s.shift.live) {
      ctx.write(endOfferStatement(ctx, offer.id, "cancelled", "The shift is no longer on."));
      cancelled += 1;
      continue;
    }
    if (!pastCutoff(s.shift.starts, ctx.now)) continue;
    ctx.write(endOfferStatement(ctx, offer.id, "lapsed", "Nobody took it before the cut-off."));
    lapsed += 1;
    const title = shiftTitle(s.object, s.values);
    const when = await whenOf(ctx, s.shift.starts, shiftZone(s.object, s.values));
    if (offer.from_account) {
      await queueNotice(ctx, {
        to: [offer.from_account],
        title: `Nobody took your shift: ${title}`,
        body: `Nobody took ${title}, ${when}, before the offer closed. It is still yours to work.`,
        link,
      });
    }
    told ??= await rosterers(ctx.db);
    const who = s.shift.account ? await staffName(ctx.db, s.shift.account) : null;
    await queueNotice(ctx, {
      to: told.filter((r) => r !== offer.from_account),
      title: `An offered shift was not taken: ${title}`,
      body: who
        ? `Nobody took ${title}, ${when}, before the offer closed. ${who} is still on it.`
        : `Nobody took ${title}, ${when}, before the offer closed. It still has nobody on it.`,
      link,
    });
  }
  return { lapsed, cancelled };
}

/** Once a local day, from DAILY_NOTICE_HOUR: the rosterers hear of every uncovered shift ahead. */
async function dailyUncovered(ctx: HandlerContext): Promise<number> {
  if (!listObjects().some((o) => o.staffed)) return 0;
  const { timezone } = await loadGeneralSettings(ctx.db);
  const nowMs = Date.parse(ctx.now);
  const local = localParts(nowMs, timezone);
  if (local.hour < DAILY_NOTICE_HOUR) return 0;
  const ran = await ctx.db
    .selectFrom("core_staff_run")
    .select("last_date")
    .where("name", "=", "uncovered")
    .executeTakeFirst();
  if (ran && ran.last_date >= local.date) return 0;
  ctx.write(
    ctx.db
      .insertInto("core_staff_run")
      .values({ name: "uncovered", last_date: local.date })
      .onConflict((oc) => oc.column("name").doUpdateSet({ last_date: local.date })),
  );
  const now = Math.floor(nowMs / 1000);
  const shifts = await uncoveredShifts(ctx, now, now + UNCOVERED_WINDOW_DAYS * 86_400);
  if (!shifts.length) return 0;
  const lines: string[] = [];
  for (const s of shifts.slice(0, 30)) {
    lines.push(`${s.title}, ${await whenOf(ctx, Date.parse(s.startsAt) / 1000, timezone)}`);
  }
  if (shifts.length > 30) lines.push(`and ${shifts.length - 30} more`);
  await queueNotice(ctx, {
    to: await rosterers(ctx.db),
    title: `${shifts.length} shift${shifts.length === 1 ? " has" : "s have"} nobody on ${shifts.length === 1 ? "it" : "them"} in the next ${UNCOVERED_WINDOW_DAYS} days`,
    body: lines.join("\n"),
    dedupeKey: `staffing.uncovered.${local.date}`,
  });
  return shifts.length;
}

/**
 * Whether the minute cron has roster work now (read outside any operation, so a quiet minute
 * writes nothing, not even an audit row): an open offer past its cut-off or whose shift is gone,
 * or the daily notice due.
 */
export async function staffingWorkDue(db: Kysely<CoreDatabase>, nowIso: string): Promise<boolean> {
  if (!listObjects().some((o) => o.staffed)) return false;
  const due = await db
    .selectFrom("core_staff_offer")
    .select("id")
    .where("state", "=", "open")
    .where("starts", "<=", cutoffOf(nowIso))
    .limit(1)
    .executeTakeFirst();
  if (due) return true;
  const { timezone } = await loadGeneralSettings(db);
  const local = localParts(Date.parse(nowIso), timezone);
  if (local.hour < DAILY_NOTICE_HOUR) return false;
  const ran = await db
    .selectFrom("core_staff_run")
    .select("last_date")
    .where("name", "=", "uncovered")
    .executeTakeFirst();
  return !ran || ran.last_date < local.date;
}

/** The minute cron's roster work, in the caller's batch. */
export async function staffingDue(
  ctx: HandlerContext,
): Promise<{ lapsed: number; cancelled: number; uncovered: number }> {
  const { lapsed, cancelled } = await lapseOffers(ctx);
  const uncovered = await dailyUncovered(ctx);
  return { lapsed, cancelled, uncovered };
}
