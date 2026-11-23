// Checklist runs as their readers see them, and the minute cron's checklist work (ADR 0650).
//
// The cron, as the host, each minute there is work, in two steps that never hold each other up
// (each its own batch):
// - **closing** (`close`): keeps open runs current with their record (its person, a shift
//   reassigned; its times, a shift moved); removes an open run nobody has ticked whose record now
//   names another checklist, only before its window opens (once open, a run keeps the checklist it
//   opened with); and closes an open run past its close and grace: missed when its record is live,
//   or when it left its live states after the run opened by someone who does not roster; cancelled
//   when it left them before the run opened or by someone who rosters (or the host), with who.
//   The rosterers are told of every miss;
// - **making** (`make`): runs for live records whose checklist is active and whose holder (the
//   duty) is not in the Trash, opening within a day (or already open and not past their grace),
//   copying the template's steps as they are then.
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
  makeRunsStatements,
  namesOf,
  newRunValues,
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
  ended_at: string | null;
  ended_by: string | null;
  closed_at: string | null;
  closed_by: string | null;
  closed_why: string | null;
  missed_steps: string | null;
};

export type TickState = "done" | "not_done" | "cleared";

/** One tick as its reader sees it: who ticked it, and for whom. */
export interface TickView {
  id: string;
  state: TickState;
  done: boolean;
  /** Why it was not done, what was written on it, why it was ticked for someone: its author's and
   * the rosterers' only (null, and `withheld`, for anyone else). */
  why: string | null;
  note: string | null;
  onBehalfWhy: string | null;
  withheld: boolean;
  by: string;
  byName: string;
  for: string;
  forName: string;
  /** Ticked by someone who rosters for the run's person: never the person's own tick. */
  onBehalf: boolean;
  at: string;
  /** "Ticked by X" or "Ticked by X for Y" ("Cleared by …" for a clear), as every screen shows it. */
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
  /** Marked done for its person by someone else: why (its author's and the rosterers' only). */
  closedWhy: string | null;
  steps: {
    position: number;
    text: string;
    required: boolean;
    asksNote: boolean;
    /** The step's latest tick (null when none, or the latest is a clear). */
    tick: TickView | null;
    /** Its earlier ticks, oldest first, the latest HISTORY_SHOWN: all for a rosterer, their own
     * for anyone else. */
    history: TickView[];
    /** Earlier ticks the reader may see were left out (more than HISTORY_SHOWN). */
    historyTruncated: boolean;
    /** Missed: a required step nobody ticked by the close. */
    missed: boolean;
  }[];
  corrections: { id: string; text: string; by: string; byName: string; at: string }[];
}

/** Who reads a run: their account, and whether they roster (they then read every tick whole). */
export interface Reader {
  account: string;
  rosters: boolean;
}

const iso = (s: number) => new Date(s * 1000).toISOString();

/** The most ticks one step of one run takes (a later one is refused), and how many a read shows. */
export const TICKS_PER_STEP = 50;
export const HISTORY_SHOWN = 20;

function parseList(json: string | null): number[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === "number") : [];
  } catch {
    return [];
  }
}

/** A step's ticks in order, latest last (by when, then by id: a ULID made in time order). */
const inOrder = <T extends { ticked_at: string; id: string }>(ticks: T[]) =>
  ticks.sort((a, b) => a.ticked_at.localeCompare(b.ticked_at) || a.id.localeCompare(b.id));

/** Runs as `reader` sees them: their ticks, corrections and names, read once for all. */
export async function runViews(
  db: Kysely<CoreDatabase>,
  runs: readonly RunRow[],
  reader: Reader,
): Promise<RunView[]> {
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
  const view = (t: (typeof ticks)[number]): TickView => {
    const whole = reader.rosters || t.ticked_by === reader.account;
    const byName = nameOf(t.ticked_by);
    const forName = nameOf(t.ticked_for);
    const verb = t.state === "cleared" ? "Cleared" : "Ticked";
    return {
      id: t.id,
      state: t.state,
      done: t.state === "done",
      why: whole ? t.why : null,
      note: whole ? t.note : null,
      onBehalfWhy: whole ? t.on_behalf_why : null,
      withheld: !whole && (t.why !== null || t.note !== null || t.on_behalf_why !== null),
      by: t.ticked_by,
      byName,
      for: t.ticked_for,
      forName,
      onBehalf: t.on_behalf === 1,
      at: t.ticked_at,
      label: t.on_behalf === 1 ? `${verb} by ${byName} for ${forName}` : `${verb} by ${byName}`,
    };
  };
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
      closedWhy: reader.rosters || r.closed_by === reader.account ? r.closed_why : null,
      steps: stepsOf(r.steps).map((s: RunStep, position) => {
        const all = inOrder(mine.filter((x) => x.position === position));
        const latest = all.at(-1);
        const seen = [
          ...all.slice(0, -1).filter((t) => reader.rosters || t.ticked_by === reader.account),
          ...(latest?.state === "cleared" ? [latest] : []),
        ];
        const shown = seen.slice(-HISTORY_SHOWN);
        return {
          position,
          text: s.text,
          required: s.required,
          asksNote: s.note,
          missed: missed.has(position),
          tick: latest && latest.state !== "cleared" ? view(latest) : null,
          history: shown.map(view),
          historyTruncated: seen.length > shown.length,
        };
      }),
      // Corrections are about how the run went: its own person's and the rosterers' only.
      corrections: notes
        .filter((n) => n.run_id === r.id && (reader.rosters || r.account_id === reader.account))
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

/** Each step's latest tick of runs `ids` (one read): run id → position → that tick. */
export async function latestTicks(
  db: Kysely<CoreDatabase>,
  ids: readonly string[],
): Promise<Map<string, Map<number, { state: TickState; ticked_by: string }>>> {
  const out = new Map<string, Map<number, { state: TickState; ticked_by: string }>>();
  if (!ids.length) return out;
  const rows = await db
    .selectFrom("core_checklist_tick")
    .select(["id", "run_id", "position", "state", "ticked_by", "ticked_at"])
    .where("run_id", "in", jsonList([...new Set(ids)]))
    .execute();
  for (const t of inOrder(rows)) {
    const byStep = out.get(t.run_id) ?? new Map();
    byStep.set(t.position, { state: t.state, ticked_by: t.ticked_by });
    out.set(t.run_id, byStep);
  }
  return out;
}

/** Whether a step's latest tick counts as ticked (done, or not done with why). */
export const ticked = (t: { state: TickState } | undefined) =>
  t !== undefined && t.state !== "cleared";

// --- The minute cron ------------------------------------------------------------------------------

/** The most runs one minute makes, and the most open runs it looks at, per object. */
const PER_TICK = 200;

/** The template's SQL on a declaring object's records (`t`, joined to its holder `v`). */
function templateOf(d: Declared, joinKind: "JOIN" | "LEFT JOIN") {
  const tpl = d.template.via
    ? sql`v.${sql.ref(d.template.column)}`
    : sql.ref(`t.${d.template.column}`);
  const join = d.template.via
    ? sql`${sql.raw(joinKind)} ${sql.table(d.template.via.table)} v ON v.id = t.${sql.ref(
        d.template.via.column,
      )}`
    : sql``;
  return { tpl, join };
}

/**
 * The records of one object that need a run now: live, naming an active checklist with steps
 * through a holder not in the Trash, opening within a day or open and not past their grace, with
 * no run yet.
 */
async function needingRuns(
  db: Kysely<CoreDatabase>,
  d: Declared,
  now: number,
  limit: number,
): Promise<RecordFacts[]> {
  const { tpl, join } = templateOf(d, "JOIN");
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
    JOIN core_checklist c ON c.id = ${tpl} AND c.active = 1
    WHERE t.deleted_at IS NULL AND t.${sql.ref(d.state)} IN (${sql.join(d.live.map((s) => sql`${s}`))})
      ${d.template.via ? sql`AND v.deleted_at IS NULL` : sql``}
      AND EXISTS (SELECT 1 FROM core_checklist_step s WHERE s.checklist_id = c.id)
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
  const { tpl, join } = templateOf(d, "LEFT JOIN");
  const opens = sql`CAST(strftime('%s', t.${sql.ref(d.opens)}) AS INTEGER)`;
  const closes = sql`CAST(strftime('%s', t.${sql.ref(d.closes)}) AS INTEGER)`;
  const live = sql`(t.deleted_at IS NULL AND t.${sql.ref(d.state)} IN (${sql.join(
    d.live.map((s) => sql`${s}`),
  )}))`;
  const rows = await sql<
    RunRow & {
      ticks: number;
      rec: string | null;
      who: string | null;
      r_opens: string | null;
      r_closes: string | null;
      is_live: number | null;
      title: string | null;
      zone: string | null;
      template: string | null;
    }
  >`SELECT r.*, (SELECT count(*) FROM core_checklist_tick k WHERE k.run_id = r.id) AS ticks,
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
          OR (${tpl} IS NOT r.checklist_id AND r.opens > ${now}
            AND NOT EXISTS (SELECT 1 FROM core_checklist_tick k2 WHERE k2.run_id = r.id)))))
    ORDER BY r.closes LIMIT ${limit}`.execute(db);
  return rows.rows.map((row) => {
    const { ticks, rec, who, r_opens, r_closes, is_live, title, zone, template, ...run } = row;
    return {
      run: run as RunRow,
      ticked: Number(ticks),
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

export type DueStep = "close" | "make";

/**
 * Whether the minute cron has checklist work of `step` now (read outside any operation, so a quiet
 * minute writes nothing): an open run due or out of step with its record (close), or a record
 * needing a run (make).
 */
export async function checklistWorkDue(
  db: Kysely<CoreDatabase>,
  nowIso: string,
  step: DueStep,
): Promise<boolean> {
  const now = Math.floor(Date.parse(nowIso) / 1000);
  for (const d of declaredObjects()) {
    if (step === "close" && (await staleRuns(db, d, now, 1)).length) return true;
    if (step === "make" && (await needingRuns(db, d, now, 1)).length) return true;
  }
  return false;
}

/**
 * Closes the open runs `ids` (one statement), guarded: the batch fails whole if any of them closed
 * meanwhile (its person marked it done), and the next minute looks again. `people` is each run's
 * person as it closes, and `closers` who closed it (a cancel by someone who rosters). A missed run
 * keeps the positions of the required steps whose latest tick is none or a clear.
 */
function closeStatements(
  ids: readonly string[],
  state: "missed" | "cancelled",
  people: Record<string, string | null>,
  closers: Record<string, string | null>,
  now: string,
): CompiledQuery[] {
  const list = JSON.stringify(ids);
  return [
    CompiledQuery.raw(
      "INSERT INTO core_staff_guard (expected, actual) SELECT ?, count(*) FROM core_checklist_run WHERE id IN (SELECT value FROM json_each(?)) AND state = 'open'",
      [ids.length, list],
    ),
    CompiledQuery.raw(
      `UPDATE core_checklist_run SET state = ?1, closed_at = ?2,
        account_id = json_extract(?3, '$."' || id || '"'),
        closed_by = json_extract(?4, '$."' || id || '"'),
        missed_steps = CASE WHEN ?1 = 'missed' THEN (SELECT json_group_array(s.key)
          FROM json_each(core_checklist_run.steps) s
          WHERE json_extract(s.value, '$.required') = 1
            AND coalesce((SELECT k.state FROM core_checklist_tick k
              WHERE k.run_id = core_checklist_run.id AND k.position = s.key
              ORDER BY k.ticked_at DESC, k.id DESC LIMIT 1), 'cleared') = 'cleared')
          ELSE NULL END
      WHERE id IN (SELECT value FROM json_each(?5)) AND state = 'open'`,
      [state, now, JSON.stringify(people), JSON.stringify(closers), list],
    ),
  ];
}

/** The minute cron's checklist work of `step`, in the caller's batch: a few statements per object. */
export async function checklistDue(
  ctx: HandlerContext,
  step: DueStep,
): Promise<{ made: number; missed: number; cancelled: number; moved: number }> {
  const now = Math.floor(Date.parse(ctx.now) / 1000);
  let made = 0;
  let moved = 0;
  const missedRuns: { run: RunRow; facts: RecordFacts }[] = [];
  let cancelledRuns = 0;
  for (const d of declaredObjects()) {
    if (step === "make") {
      const needing = await needingRuns(ctx.db, d, now, PER_TICK);
      const templates = await templateCopies(
        ctx.db,
        needing.map((f) => f.template).filter((t): t is string => !!t),
      );
      const runs = needing.flatMap((facts) => {
        const template = templates.get(facts.template ?? "");
        return usable(template)
          ? [newRunValues(newId("checklistRun"), facts, template, ctx.now)]
          : [];
      });
      // Made only where no run is: never fails on one made meanwhile.
      if (runs.length) ctx.write(...makeRunsStatements(runs));
      made += runs.length;
      continue;
    }
    const stale = await staleRuns(ctx.db, d, now, PER_TICK);
    const missed: { run: RunRow; facts: RecordFacts }[] = [];
    const cancelled: { run: RunRow; by: string | null }[] = [];
    const follow: Record<string, { account: string | null; opens: number; closes: number }> = {};
    const remove: string[] = [];
    for (const { run, ticked: ticks, facts } of stale) {
      const closes = facts?.live ? (facts.closes ?? run.closes) : run.closes;
      if (closes + GRACE_SECONDS <= now) {
        // The record as it was, for the notice, when it is gone.
        const shown: RecordFacts = facts ?? {
          object: d.object.name,
          id: run.record_id,
          title: d.object.label,
          zone: null,
          account: run.account_id,
          opens: run.opens,
          closes: run.closes,
          live: false,
          template: run.checklist_id,
        };
        if (facts?.live || (run.ended_at !== null && run.ended_by === null)) {
          // Live at its close, or ended after it opened by someone who does not roster: missed.
          missed.push({ run, facts: shown });
        } else {
          cancelled.push({ run, by: run.ended_by });
        }
        continue;
      }
      if (!facts?.live) continue; // Cancelled or in the Trash: it waits (it may be restored).
      if (facts.template !== run.checklist_id && ticks === 0 && run.opens > now) {
        // Not yet open, nothing done on it, and its record now names another checklist (or none).
        remove.push(run.id);
        continue;
      }
      follow[run.id] = {
        account: facts.account,
        opens: facts.opens ?? run.opens,
        closes: facts.closes ?? run.closes,
      };
    }
    if (missed.length) {
      const people = Object.fromEntries(
        missed.map((m) => [m.run.id, m.facts.live ? m.facts.account : m.run.account_id]),
      );
      const closers = Object.fromEntries(missed.map((m) => [m.run.id, null]));
      ctx.write(...closeStatements(Object.keys(people), "missed", people, closers, ctx.now));
      missedRuns.push(...missed);
    }
    if (cancelled.length) {
      const people = Object.fromEntries(cancelled.map((c) => [c.run.id, c.run.account_id]));
      const closers = Object.fromEntries(cancelled.map((c) => [c.run.id, c.by]));
      ctx.write(...closeStatements(Object.keys(people), "cancelled", people, closers, ctx.now));
      cancelledRuns += cancelled.length;
    }
    if (remove.length) {
      // Removed only while untouched and not yet open; the make step then makes the new one.
      ctx.write(
        CompiledQuery.raw(
          "DELETE FROM core_checklist_run WHERE id IN (SELECT value FROM json_each(?)) AND state = 'open' AND opens > ? AND NOT EXISTS (SELECT 1 FROM core_checklist_tick k WHERE k.run_id = core_checklist_run.id)",
          [JSON.stringify(remove), now],
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
  }
  if (missedRuns.length) await tellMissed(ctx, missedRuns);
  return { made, missed: missedRuns.length, cancelled: cancelledRuns, moved };
}

/** The most missed runs one notice names. */
const NOTICE_LINES = 20;

/**
 * Rosterers hear of the runs missed this minute, in one notice: each record, its person and the
 * required steps nobody ticked (one run: its steps; several: a line each). Never a note.
 */
async function tellMissed(
  ctx: HandlerContext,
  missedRuns: readonly { run: RunRow; facts: RecordFacts }[],
): Promise<void> {
  const shown = missedRuns.slice(0, NOTICE_LINES);
  const latest = await latestTicks(
    ctx.db,
    shown.map((m) => m.run.id),
  );
  const names = await namesOf(
    ctx.db,
    shown.map((m) => m.facts.account ?? m.run.account_id),
  );
  const { timezone } = await loadGeneralSettings(ctx.db);
  const lines: string[] = [];
  for (const { run, facts } of shown) {
    const byStep = latest.get(run.id);
    const left = stepsOf(run.steps).filter((s, i) => s.required && !ticked(byStep?.get(i)));
    const when = await whenOf(ctx, facts.opens ?? run.opens, facts.zone ?? timezone);
    const account = facts.account ?? run.account_id;
    const who = account ? (names.get(account) ?? "Someone") : "nobody";
    const ended = facts.live ? "" : " Its shift was cancelled or removed after it opened.";
    const steps =
      left.length > 10
        ? `${left
            .slice(0, 10)
            .map((s) => s.text)
            .join("; ")}; and ${left.length - 10} more`
        : left.map((s) => s.text).join("; ");
    lines.push(
      `${run.name} on ${facts.title}, ${when} (${who} was on it).${ended} Not done: ${steps || "it was not marked done"}`,
    );
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
