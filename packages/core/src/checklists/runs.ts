// Checklist runs as their readers see them, and the minute cron's checklist work (ADR 0650).
//
// The cron, as the host, each minute there is work:
// - **makes runs** for live records with a usable template opening within a day (or already open
//   and not past their grace), copying the template's steps as they are then;
// - **keeps open runs current** with their record: its person (a shift reassigned), its times (a
//   shift moved); an open run nobody has ticked whose record no longer names its template is
//   removed (and a run of the new one made), since nothing was done on it;
// - **closes** an open run past its close and grace: missed when its record is live (the steps
//   nobody ticked are kept, and the rosterers told), cancelled otherwise (cancelled, in the Trash,
//   gone).
// Nothing here can fail for ever: every statement is guarded by what it reads (an insert only where
// no run is, a removal only of an untouched open run, a close only of an open one), so the triggers
// that keep a closed run unchanged are never what refuses it.
import type { CoreDatabase } from "@composable-os/db";
import { CompiledQuery, type Kysely, sql } from "kysely";
import { newId } from "../ids.ts";
import type { HandlerContext } from "../operation.ts";
import { jsonList } from "../records/common.ts";
import { loadGeneralSettings } from "../settings.ts";
import { whenOf } from "../staffing/offers.ts";
import { queueNotice, rosterers, shiftLink } from "../staffing/rosterers.ts";
import {
  type Declared,
  declaredObjects,
  GRACE_SECONDS,
  MAKE_AHEAD_SECONDS,
  makeRunsStatement,
  newRunValues,
  namesOf,
  type RecordFacts,
  type RunState,
  type RunStep,
  stepsOf,
  templateCopies,
  usable,
} from "./index.ts";

/** A run's row. */
export type RunRow = {
  id: string;
  object_type: string;
  record_id: string;
  checklist_id: string;
  version: number;
  name: string;
  steps: string;
  account_id: string | null;
  opens: number;
  closes: number;
  state: RunState;
  made_at: string;
  closed_at: string | null;
  closed_by: string | null;
  closed_why: string | null;
  missed_steps: string | null;
};

/** One tick as its readers see it: who ticked it, and for whom. */
export interface TickView {
  done: boolean;
  why: string | null;
  note: string | null;
  by: string;
  byName: string;
  for: string;
  forName: string;
  /** Ticked by someone who rosters for the run's person: never the person's own tick. */
  onBehalf: boolean;
  onBehalfWhy: string | null;
  at: string;
  /** "Ticked by X" or "Ticked by X for Y", as every screen shows it. */
  label: string;
}

export interface RunView {
  id: string;
  object: string;
  record: string;
  template: { id: string; name: string; version: number };
  state: RunState;
  account: string | null;
  name: string | null;
  opens: string;
  closes: string;
  /** Ticks are taken until then. */
  tickUntil: string;
  madeAt: string;
  closedAt: string | null;
  closedBy: string | null;
  closedByName: string | null;
  /** Marked done for its person by someone else: why. */
  closedWhy: string | null;
  steps: {
    position: number;
    text: string;
    required: boolean;
    asksNote: boolean;
    tick: TickView | null;
    /** Missed: nobody ticked it by the close. */
    missed: boolean;
  }[];
  corrections: { id: string; text: string; by: string; byName: string; at: string }[];
}

const iso = (s: number) => new Date(s * 1000).toISOString();

function parseList(json: string | null): number[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === "number") : [];
  } catch {
    return [];
  }
}

/** Runs as their readers see them: their ticks, corrections and names, read once for all. */
export async function runViews(db: Kysely<CoreDatabase>, runs: readonly RunRow[]): Promise<RunView[]> {
  if (!runs.length) return [];
  const ids = runs.map((r) => r.id);
  const ticks = await db
    .selectFrom("core_checklist_tick")
    .selectAll()
    .where("run_id", "in", jsonList(ids))
    .execute();
  const notes = await db
    .selectFrom("core_checklist_note")
    .selectAll()
    .where("run_id", "in", jsonList(ids))
    .orderBy("written_at")
    .execute();
  const names = await namesOf(db, [
    ...runs.flatMap((r) => [r.account_id, r.closed_by]),
    ...ticks.flatMap((t) => [t.ticked_by, t.ticked_for]),
    ...notes.map((n) => n.written_by),
  ]);
  const nameOf = (a: string) => names.get(a) ?? "a former staff member";
  return runs.map((r) => {
    const missed = new Set(parseList(r.missed_steps));
    const mine = ticks.filter((t) => t.run_id === r.id);
    return {
      id: r.id,
      object: r.object_type,
      record: r.record_id,
      template: { id: r.checklist_id, name: r.name, version: r.version },
      state: r.state,
      account: r.account_id,
      name: r.account_id ? nameOf(r.account_id) : null,
      opens: iso(r.opens),
      closes: iso(r.closes),
      tickUntil: iso(r.closes + GRACE_SECONDS),
      madeAt: r.made_at,
      closedAt: r.closed_at,
      closedBy: r.closed_by,
      closedByName: r.closed_by ? nameOf(r.closed_by) : null,
      closedWhy: r.closed_why,
      steps: stepsOf(r.steps).map((s: RunStep, position) => {
        const t = mine.find((x) => x.position === position);
        const byName = t ? nameOf(t.ticked_by) : "";
        const forName = t ? nameOf(t.ticked_for) : "";
        return {
          position,
          text: s.text,
          required: s.required,
          asksNote: s.note,
          missed: missed.has(position),
          tick: t
            ? {
                done: t.done === 1,
                why: t.why,
                note: t.note,
                by: t.ticked_by,
                byName,
                for: t.ticked_for,
                forName,
                onBehalf: t.on_behalf === 1,
                onBehalfWhy: t.on_behalf_why,
                at: t.ticked_at,
                label: t.on_behalf === 1 ? `Ticked by ${byName} for ${forName}` : `Ticked by ${byName}`,
              }
            : null,
        };
      }),
      corrections: notes
        .filter((n) => n.run_id === r.id)
        .map((n) => ({
          id: n.id,
          text: n.text,
          by: n.written_by,
          byName: nameOf(n.written_by),
          at: n.written_at,
        })),
    };
  });
}

// --- The minute cron ------------------------------------------------------------------------------

/** The most runs one minute makes, and the most open runs it looks at, per object. */
const PER_TICK = 200;

/** The records of one object that need a run now (live, a template, opening soon or open). */
async function needingRuns(
  db: Kysely<CoreDatabase>,
  d: Declared,
  now: number,
  limit: number,
): Promise<RecordFacts[]> {
  const tpl = d.template.via ? sql`v.${sql.ref(d.template.column)}` : sql.ref(`t.${d.template.column}`);
  const join = d.template.via
    ? sql`JOIN ${sql.table(d.template.via.table)} v ON v.id = t.${sql.ref(d.template.via.column)}`
    : sql``;
  // By the index on the opening time: from two days back (a long record still open) to a day ahead.
  const lo = iso(now - 3 * 86_400);
  const hi = iso(now + MAKE_AHEAD_SECONDS + 86_400);
  const opens = sql`CAST(strftime('%s', t.${sql.ref(d.opens)}) AS INTEGER)`;
  const closes = sql`CAST(strftime('%s', t.${sql.ref(d.closes)}) AS INTEGER)`;
  const rows = await sql<{
    id: string;
    who: string | null;
    opens: string | null;
    closes: string | null;
    title: string | null;
    zone: string | null;
    template: string | null;
  }>`SELECT t.id AS id, t.${sql.ref(d.who)} AS who, t.${sql.ref(d.opens)} AS opens,
      t.${sql.ref(d.closes)} AS closes, ${d.title ? sql`t.${sql.ref(d.title)}` : sql`NULL`} AS title,
      ${d.zone ? sql`t.${sql.ref(d.zone)}` : sql`NULL`} AS zone, ${tpl} AS template
    FROM ${sql.table(d.table)} t ${join}
    WHERE t.deleted_at IS NULL AND t.${sql.ref(d.state)} IN (${sql.join(d.live.map((s) => sql`${s}`))})
      AND ${tpl} IS NOT NULL AND ${tpl} != ''
      AND t.${sql.ref(d.opens)} >= ${lo} AND t.${sql.ref(d.opens)} < ${hi}
      AND ${opens} <= ${now + MAKE_AHEAD_SECONDS} AND ${closes} + ${GRACE_SECONDS} > ${now}
      AND NOT EXISTS (SELECT 1 FROM core_checklist_run r WHERE r.object_type = ${d.object.name}
        AND r.record_id = t.id)
    ORDER BY t.${sql.ref(d.opens)} LIMIT ${limit}`.execute(db);
  return rows.rows.map((r) => ({
    object: d.object.name,
    id: r.id,
    title: r.title || d.object.label,
    zone: r.zone || null,
    account: r.who || null,
    opens: r.opens ? Math.floor(Date.parse(r.opens) / 1000) : null,
    closes: r.closes ? Math.floor(Date.parse(r.closes) / 1000) : null,
    live: true,
    template: r.template,
  }));
}

/** An open run of one object that is due (past its grace) or no longer matches its record. */
interface Stale {
  run: RunRow;
  ticked: number;
  /** The record now; null when it is gone. */
  facts: RecordFacts | null;
}

async function staleRuns(
  db: Kysely<CoreDatabase>,
  d: Declared,
  now: number,
  limit: number,
): Promise<Stale[]> {
  const tpl = d.template.via ? sql`v.${sql.ref(d.template.column)}` : sql.ref(`t.${d.template.column}`);
  const join = d.template.via
    ? sql`LEFT JOIN ${sql.table(d.template.via.table)} v ON v.id = t.${sql.ref(d.template.via.column)}`
    : sql``;
  const opens = sql`CAST(strftime('%s', t.${sql.ref(d.opens)}) AS INTEGER)`;
  const closes = sql`CAST(strftime('%s', t.${sql.ref(d.closes)}) AS INTEGER)`;
  const live = sql`(t.deleted_at IS NULL AND t.${sql.ref(d.state)} IN (${sql.join(
    d.live.map((s) => sql`${s}`),
  )}))`;
  const rows = await sql<
    RunRow & {
      ticked: number;
      rec: string | null;
      who: string | null;
      r_opens: string | null;
      r_closes: string | null;
      is_live: number | null;
      title: string | null;
      zone: string | null;
      template: string | null;
    }
  >`SELECT r.*, (SELECT count(*) FROM core_checklist_tick k WHERE k.run_id = r.id) AS ticked,
      t.id AS rec, t.${sql.ref(d.who)} AS who, t.${sql.ref(d.opens)} AS r_opens,
      t.${sql.ref(d.closes)} AS r_closes, ${live} AS is_live,
      ${d.title ? sql`t.${sql.ref(d.title)}` : sql`NULL`} AS title,
      ${d.zone ? sql`t.${sql.ref(d.zone)}` : sql`NULL`} AS zone, ${tpl} AS template
    FROM core_checklist_run r
    LEFT JOIN ${sql.table(d.table)} t ON t.id = r.record_id ${join}
    WHERE r.state = 'open' AND r.object_type = ${d.object.name}
      AND (r.closes + ${GRACE_SECONDS} <= ${now}
        OR (${live} AND (t.${sql.ref(d.who)} IS NOT r.account_id OR ${opens} IS NOT r.opens
          OR ${closes} IS NOT r.closes
          OR (${tpl} IS NOT r.checklist_id
            AND NOT EXISTS (SELECT 1 FROM core_checklist_tick k2 WHERE k2.run_id = r.id)))))
    ORDER BY r.closes LIMIT ${limit}`.execute(db);
  return rows.rows.map((row) => {
    const { ticked, rec, who, r_opens, r_closes, is_live, title, zone, template, ...run } = row;
    return {
      run: run as RunRow,
      ticked: Number(ticked),
      facts:
        rec === null
          ? null
          : {
              object: d.object.name,
              id: rec,
              title: title || d.object.label,
              zone: zone || null,
              account: who || null,
              opens: r_opens ? Math.floor(Date.parse(r_opens) / 1000) : null,
              closes: r_closes ? Math.floor(Date.parse(r_closes) / 1000) : null,
              live: Number(is_live) === 1,
              template: template || null,
            },
    };
  });
}

/**
 * Whether the minute cron has checklist work now (read outside any operation, so a quiet minute
 * writes nothing): a record needing a run, or an open run due or out of step with its record.
 */
export async function checklistWorkDue(
  db: Kysely<CoreDatabase>,
  nowIso: string,
): Promise<boolean> {
  const now = Math.floor(Date.parse(nowIso) / 1000);
  for (const d of declaredObjects()) {
    if ((await staleRuns(db, d, now, 1)).length) return true;
    if ((await needingRuns(db, d, now, 1)).length) return true;
  }
  return false;
}

/**
 * Closes the open runs `ids` (one statement), guarded: the batch fails whole if any of them closed
 * meanwhile (its person marked it done), and the next minute looks again. `accounts` is each run's
 * person as it closes. A missed run keeps the positions of the steps nobody ticked.
 */
function closeStatements(
  ids: readonly string[],
  state: "missed" | "cancelled",
  accounts: Record<string, string | null>,
  now: string,
): CompiledQuery[] {
  const list = JSON.stringify(ids);
  return [
    CompiledQuery.raw(
      "INSERT INTO core_staff_guard (expected, actual) SELECT ?, count(*) FROM core_checklist_run WHERE id IN (SELECT value FROM json_each(?)) AND state = 'open'",
      [ids.length, list],
    ),
    CompiledQuery.raw(
      `UPDATE core_checklist_run SET state = ?, closed_at = ?,
        account_id = json_extract(?, '$."' || id || '"'),
        missed_steps = CASE WHEN ? = 'missed' THEN (SELECT json_group_array(s.key)
          FROM json_each(core_checklist_run.steps) s WHERE NOT EXISTS (SELECT 1
            FROM core_checklist_tick k WHERE k.run_id = core_checklist_run.id
            AND k.position = s.key)) ELSE NULL END
      WHERE id IN (SELECT value FROM json_each(?)) AND state = 'open'`,
      [state, now, JSON.stringify(accounts), state, list],
    ),
  ];
}

/** The minute cron's checklist work, in the caller's batch: a few statements per object. */
export async function checklistDue(
  ctx: HandlerContext,
): Promise<{ made: number; missed: number; cancelled: number; moved: number }> {
  const now = Math.floor(Date.parse(ctx.now) / 1000);
  let made = 0;
  let moved = 0;
  const missedRuns: { run: RunRow; facts: RecordFacts }[] = [];
  const cancelledRuns: RunRow[] = [];
  for (const d of declaredObjects()) {
    // Open runs first: those due close, the rest follow their record.
    const stale = await staleRuns(ctx.db, d, now, PER_TICK);
    const missed: { run: RunRow; facts: RecordFacts }[] = [];
    const cancelled: RunRow[] = [];
    const follow: Record<string, { account: string | null; opens: number; closes: number }> = {};
    const remove: string[] = [];
    const remade: RecordFacts[] = [];
    for (const { run, ticked, facts } of stale) {
      const closes = facts?.live ? (facts.closes ?? run.closes) : run.closes;
      if (closes + GRACE_SECONDS <= now) {
        if (facts?.live) missed.push({ run, facts });
        else cancelled.push(run);
        continue;
      }
      if (!facts?.live) continue; // Cancelled or in the Trash: it waits (it may be restored).
      if (facts.template !== run.checklist_id && ticked === 0) {
        // Nothing was done on it, and its record now names another checklist (or none).
        remove.push(run.id);
        if (facts.template) remade.push(facts);
        continue;
      }
      follow[run.id] = {
        account: facts.account,
        opens: facts.opens ?? run.opens,
        closes: facts.closes ?? run.closes,
      };
    }
    if (missed.length) {
      const accounts = Object.fromEntries(missed.map((m) => [m.run.id, m.facts.account]));
      ctx.write(...closeStatements(Object.keys(accounts), "missed", accounts, ctx.now));
      missedRuns.push(...missed);
    }
    if (cancelled.length) {
      const accounts = Object.fromEntries(cancelled.map((r) => [r.id, r.account_id]));
      ctx.write(...closeStatements(Object.keys(accounts), "cancelled", accounts, ctx.now));
      cancelledRuns.push(...cancelled);
    }
    if (remove.length) {
      ctx.write(
        CompiledQuery.raw(
          "DELETE FROM core_checklist_run WHERE id IN (SELECT value FROM json_each(?)) AND state = 'open' AND NOT EXISTS (SELECT 1 FROM core_checklist_tick k WHERE k.run_id = core_checklist_run.id)",
          [JSON.stringify(remove)],
        ),
      );
      moved += remove.length;
    }
    if (Object.keys(follow).length) {
      // Each follows its record: its person and times, from one JSON map.
      ctx.write(
        CompiledQuery.raw(
          `UPDATE core_checklist_run SET
            account_id = json_extract(?1, '$."' || id || '".account'),
            opens = json_extract(?1, '$."' || id || '".opens'),
            closes = json_extract(?1, '$."' || id || '".closes')
          WHERE id IN (SELECT key FROM json_each(?1)) AND state = 'open'`,
          [JSON.stringify(follow)],
        ),
      );
      moved += Object.keys(follow).length;
    }
    // Then the records needing a run (and those whose run was just removed for another template).
    const needing = [...(await needingRuns(ctx.db, d, now, PER_TICK)), ...remade];
    const templates = await templateCopies(
      ctx.db,
      needing.map((f) => f.template).filter((t): t is string => !!t),
    );
    const runs = needing.flatMap((facts) => {
      const template = templates.get(facts.template ?? "");
      return usable(template) ? [newRunValues(newId("checklistRun"), facts, template, ctx.now)] : [];
    });
    if (runs.length) {
      // Made only where no run is (after the removal above in this batch, for a remade one; if a
      // tick reached the old run meanwhile it stays, and nothing is made for it).
      ctx.write(makeRunsStatement(runs));
      made += runs.length;
    }
  }
  if (missedRuns.length) await tellMissed(ctx, missedRuns);
  return { made, missed: missedRuns.length, cancelled: cancelledRuns.length, moved };
}

/** The most missed runs one notice names. */
const NOTICE_LINES = 20;

/**
 * Rosterers hear of the runs missed this minute, in one notice: each record, its person and the
 * steps nobody ticked (one run: its steps; several: a line each).
 */
async function tellMissed(
  ctx: HandlerContext,
  missedRuns: readonly { run: RunRow; facts: RecordFacts }[],
): Promise<void> {
  const shown = missedRuns.slice(0, NOTICE_LINES);
  const ticks = await ctx.db
    .selectFrom("core_checklist_tick")
    .select(["run_id", "position"])
    .where("run_id", "in", jsonList(shown.map((m) => m.run.id)))
    .execute();
  const names = await namesOf(
    ctx.db,
    shown.map((m) => m.facts.account),
  );
  const { timezone } = await loadGeneralSettings(ctx.db);
  const lines: string[] = [];
  for (const { run, facts } of shown) {
    const done = new Set(ticks.filter((t) => t.run_id === run.id).map((t) => t.position));
    const left = stepsOf(run.steps).filter((_, i) => !done.has(i));
    const when = await whenOf(ctx, facts.opens, facts.zone ?? timezone);
    const who = facts.account ? (names.get(facts.account) ?? "Someone") : "nobody";
    const steps =
      left.length > 10
        ? `${left
            .slice(0, 10)
            .map((s) => s.text)
            .join("; ")}; and ${left.length - 10} more`
        : left.map((s) => s.text).join("; ");
    lines.push(`${run.name} on ${facts.title}, ${when} (${who} was on it). Not done: ${steps}`);
  }
  if (missedRuns.length > shown.length) lines.push(`and ${missedRuns.length - shown.length} more`);
  const first = missedRuns[0] as { run: RunRow; facts: RecordFacts };
  await queueNotice(ctx, {
    to: await rosterers(ctx.db),
    title:
      missedRuns.length === 1
        ? `A checklist was missed: ${first.run.name}, ${first.facts.title}`
        : `${missedRuns.length} checklists were missed`,
    body: lines.join("\n"),
    ...(missedRuns.length === 1 ? { link: shiftLink(first.facts.object, first.facts.id) } : {}),
    // How a checklist went is a person's to read: no AI acting for a rosterer lists it.
    humanOnly: true,
    dedupeKey: `checklist.missed.${first.run.id}`,
  });
}

/** A run of one record (or null), read by the record. */
export async function runOf(
  db: Kysely<CoreDatabase>,
  object: string,
  record: string,
): Promise<RunRow | null> {
  const row = await db
    .selectFrom("core_checklist_run")
    .selectAll()
    .where("object_type", "=", object)
    .where("record_id", "=", record)
    .executeTakeFirst();
  return (row as RunRow | undefined) ?? null;
}
