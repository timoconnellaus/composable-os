// A staff member leaving (stage 45 step 3, ADR 0624): `user.deactivate` answers with their future
// shifts and the patterns that name them and, confirmed with that count (as `recurring.change`
// is), in the same batch: clears them from every future shift and pattern (each now uncovered),
// which releases their time claims (the staffed triggers), cancels their open offers and those
// named to them, and tells the rosterers with the list. Past shifts, and shifts already under way,
// keep them. Reactivating puts nothing back.
//
// Set-based, so a coach with a long future and a longer past is a handful of statements: the
// future shifts are read from their claims (indexed by account and end, so nothing past is read),
// and each object's shifts are cleared by one statement whose ids are taken from those claims
// again at commit, so a shift the series made between this read and the commit is cleared too.
import { CompiledQuery, sql } from "kysely";
import { ConflictError } from "../errors.ts";
import { objectTableOf } from "../extensions/schema.ts";
import { getObject, listObjects } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import { jsonList } from "../records/common.ts";
import { armSeriesStatement, noteSeriesBump } from "../recurring/bookkeeping.ts";
import { loadGeneralSettings } from "../settings.ts";
import { whenOf } from "./offers.ts";
import { queueNotice, rosterers, shiftLink, staffName } from "./rosterers.ts";

/** The most future shifts one deactivation names (it clears every one, whatever the number). */
const NAMED_MAX = 50;
/** The most future shifts read to answer and audit one deactivation. */
const READ_MAX = 2000;

interface FutureShift {
  object: string;
  id: string;
  title: string;
  startsAt: string;
  /** The person field's value now (a coach profile, or the account). */
  was: string | null;
}

interface Pattern {
  object: string;
  id: string;
  title: string;
  field: string;
  column: string;
  was: string;
}

export interface LeavingAnswer {
  shifts: number;
  patterns: number;
  offers: number;
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

function columnOf(object: ObjectDefinition, field: string | undefined): string | null {
  return (field && object.fields.find((f) => f.name === field)?.column) || null;
}

/** The values a staffed object's person field takes for `account`: the account, or its profiles. */
async function personValues(
  ctx: HandlerContext,
  object: ObjectDefinition,
  account: string,
): Promise<string[]> {
  const def = object.staffed;
  if (!def) return [];
  if (!def.who.account) return [account];
  const holder = def.who.object ? getObject(def.who.object) : undefined;
  const table = holder ? objectTableOf(holder.name) : undefined;
  const column = holder ? columnOf(holder, def.who.account) : null;
  if (!table || !column) return [];
  const rows = await sql<{ id: string }>`SELECT id FROM ${sql.table(table)} WHERE ${sql.ref(
    column,
  )} = ${account}`.execute(ctx.db);
  return rows.rows.map((r) => r.id);
}

/** Every future shift of `account` (starting after now), from its claims. */
async function futureShifts(ctx: HandlerContext, account: string): Promise<FutureShift[]> {
  const now = Math.floor(Date.parse(ctx.now) / 1000);
  const claims = await ctx.db
    .selectFrom("core_staff_time")
    .select(["object_type", "record_id", "starts"])
    .where("account_id", "=", account)
    .where("ends", ">", now)
    .where("starts", ">", now)
    .orderBy("starts")
    .limit(READ_MAX)
    .execute();
  const byObject = new Map<string, typeof claims>();
  for (const c of claims) byObject.set(c.object_type, [...(byObject.get(c.object_type) ?? []), c]);
  const out: FutureShift[] = [];
  for (const [name, rows] of byObject) {
    const object = getObject(name);
    const table = object ? objectTableOf(name) : undefined;
    const who = object ? columnOf(object, object.staffed?.who.field) : null;
    if (!object || !table || !who) continue;
    const title = columnOf(object, object.titleField);
    const stored = await sql<{ id: string; title: string | null; who: string | null }>`SELECT id, ${
      title ? sql.ref(title) : sql`NULL`
    } AS title, ${sql.ref(who)} AS who FROM ${sql.table(table)} WHERE id IN ${jsonList(
      rows.map((r) => r.record_id),
    )}`.execute(ctx.db);
    const found = new Map(stored.rows.map((r) => [r.id, r]));
    for (const c of rows) {
      const row = found.get(c.record_id);
      out.push({
        object: name,
        id: c.record_id,
        title: row?.title || object.label,
        startsAt: iso(c.starts),
        was: row?.who ?? null,
      });
    }
  }
  return out.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/** The series (patterns) whose person is `account`, for every staffed object a series makes. */
async function patternsOf(ctx: HandlerContext, account: string): Promise<Pattern[]> {
  const out: Pattern[] = [];
  for (const staffed of listObjects()) {
    const who = staffed.staffed?.who.field;
    if (!who) continue;
    const values = await personValues(ctx, staffed, account);
    if (!values.length) continue;
    for (const series of listObjects()) {
      const def = series.recurring;
      if (def?.generates !== staffed.name) continue;
      const field = def.copy[who];
      const column = columnOf(series, field);
      const table = objectTableOf(series.name);
      if (!field || !column || !table) continue;
      const title = columnOf(series, series.titleField);
      const rows = await sql<{ id: string; title: string | null; was: string }>`SELECT id, ${
        title ? sql.ref(title) : sql`NULL`
      } AS title, ${sql.ref(column)} AS was FROM ${sql.table(table)} WHERE ${sql.ref(
        column,
      )} IN ${jsonList(values)} AND deleted_at IS NULL LIMIT 200`.execute(ctx.db);
      for (const row of rows.rows) {
        out.push({
          object: series.name,
          id: row.id,
          title: row.title || series.label,
          field,
          column,
          was: row.was,
        });
      }
    }
  }
  return out;
}

/**
 * What leaving takes off `account`, refused unless `confirm` is its count, then queued in the
 * caller's batch (user.deactivate's). Nothing staffed installed, or nothing of theirs: nothing.
 */
export async function leaveRoster(
  ctx: HandlerContext,
  account: string,
  confirm: number | undefined,
): Promise<LeavingAnswer> {
  if (!listObjects().some((o) => o.staffed)) return { shifts: 0, patterns: 0, offers: 0 };
  const shifts = await futureShifts(ctx, account);
  const patterns = await patternsOf(ctx, account);
  const count = shifts.length + patterns.length;
  if (count > 0 && confirm !== count) {
    const name = await staffName(ctx.db, account);
    throw new ConflictError(
      `${name} is on ${shifts.length} future shift${shifts.length === 1 ? "" : "s"} and ${patterns.length} regular pattern${patterns.length === 1 ? "" : "s"}. Deactivating them leaves each with nobody on it. Confirm with that count (${count}) to go ahead.`,
      {
        rule: "deactivate_confirm",
        count,
        shifts: shifts
          .slice(0, NAMED_MAX)
          .map(({ object, id, title, startsAt }) => ({ object, id, title, startsAt })),
        shiftCount: shifts.length,
        patterns: patterns.map(({ object, id, title }) => ({ object, id, title })),
      },
    );
  }
  const now = Math.floor(Date.parse(ctx.now) / 1000);
  // The patterns first: each series names nobody from now on, and its version moves, so a run
  // planned from the series as it was fails and makes its dates again from this.
  for (const p of patterns) {
    const table = objectTableOf(p.object) as string;
    ctx.write(
      CompiledQuery.raw(
        `UPDATE ${table} SET ${p.column} = NULL, updated_at = ?, updated_by = ? WHERE id = ? AND ${p.column} = ? AND deleted_at IS NULL`,
        [ctx.now, ctx.user.id, p.id, p.was],
      ),
      armSeriesStatement(p.object, p.id, ctx.now, ctx.now),
    );
    noteSeriesBump(ctx, p.object, p.id);
    ctx.recordChange({
      object: p.object,
      id: p.id,
      action: "update",
      before: { [p.field]: p.was },
      after: { [p.field]: null },
    });
  }
  // Every future shift of theirs, object by object: the ids are taken from their claims at commit.
  for (const object of new Set(shifts.map((s) => s.object))) {
    const def = getObject(object);
    const table = objectTableOf(object);
    const who = def ? columnOf(def, def.staffed?.who.field) : null;
    if (!def?.staffed || !table || !who) continue;
    ctx.write(
      CompiledQuery.raw(
        `UPDATE ${table} SET ${who} = NULL, updated_at = ?, updated_by = ? WHERE deleted_at IS NULL AND id IN (SELECT record_id FROM core_staff_time WHERE account_id = ? AND object_type = ? AND ends > ? AND starts > ?)`,
        [ctx.now, ctx.user.id, account, object, now, now],
      ),
    );
    for (const s of shifts.filter((x) => x.object === object)) {
      ctx.recordChange({
        object,
        id: s.id,
        action: "update",
        before: { [def.staffed.who.field]: s.was },
        after: { [def.staffed.who.field]: null },
      });
    }
  }
  // Their open offers, and those named to them: cancelled; whoever offered one to them is told.
  const offers = await ctx.db
    .selectFrom("core_staff_offer")
    .select(["id", "object_type", "record_id", "from_account", "made_by", "to_account"])
    .where("state", "=", "open")
    .where((eb) => eb.or([eb("from_account", "=", account), eb("to_account", "=", account)]))
    .execute();
  const name = await staffName(ctx.db, account);
  for (const offer of offers) {
    ctx.write(
      ctx.db
        .updateTable("core_staff_offer")
        .set({ state: "cancelled", ended_at: ctx.now, ended_by: ctx.user.id, why: "deactivated" })
        .where("id", "=", offer.id),
    );
    if (offer.to_account === account) {
      await queueNotice(ctx, {
        to: [offer.from_account ?? offer.made_by],
        title: "Your offer was cancelled",
        body: `${name} left, so your offer to them was cancelled. The shift is still yours.`,
        link: shiftLink(offer.object_type, offer.record_id),
      });
    }
  }
  if (count > 0) {
    // In the organisation's zone, read once.
    const { timezone } = await loadGeneralSettings(ctx.db);
    const lines: string[] = [];
    for (const s of shifts.slice(0, NAMED_MAX)) {
      lines.push(`${s.title}, ${await whenOf(ctx, Date.parse(s.startsAt) / 1000, timezone)}`);
    }
    const more = shifts.length > NAMED_MAX ? [`and ${shifts.length - NAMED_MAX} more`] : [];
    const regular = patterns.map((p) => `Regular: ${p.title}`);
    await queueNotice(ctx, {
      to: await rosterers(ctx.db),
      title: `${name} left: ${shifts.length} shift${shifts.length === 1 ? "" : "s"} now have nobody on them`,
      body: [...regular, ...lines, ...more].join("\n"),
    });
  }
  return { shifts: shifts.length, patterns: patterns.length, offers: offers.length };
}
