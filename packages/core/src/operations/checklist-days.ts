// Checklists on their own, without a roster (ADR 0651; a follow-on to stage 45 step 4b, ADR 0650).
//
// A checklist with a standing schedule is due on its days (the business's day, in its time zone),
// by whoever it names. Each due day has one run. These operations are tool-only, as a shift's
// checklist's are: called from a shipped pack's tool a person calls themselves (Daily checklists'),
// for the staff account the pipeline verified as the tool's caller, never anything in the input.
// - `checklist.today`: the caller's checklists today: each one they may do (and, for someone who
//   manages checklists, every one), with its run or a preview of its steps.
// - `checklist.day`: one checklist on one day: today's for whoever may do it; any day's for
//   someone who manages checklists, with the people who may do it (to tick for one of them).
// - `checklist.dayTick`: tick a step. Anyone who may do it ticks as themselves; someone who
//   manages checklists ticks for one of them, with why. Whoever ticks the last step finishes it.
// - `checklist.dayDone`: finish it with optional steps left, once every required step is ticked.
// - `checklist.days`: how each day went, for those who manage checklists.
// Who may do it, who manages checklists, and that a finished or missed run never changes are held
// by the database too (migrations 0815 and 0816). An AI never ticks or reads how a day went.
import { sql } from "kysely";
import { z } from "zod";
import {
  accountManages,
  accountMayDo,
  accountsOf,
  DAY_OBJECT,
  type Doers,
  dayRecord,
  dayWindow,
  doersOf,
  dueOn,
  makeDayRunsStatements,
  newDayRunValues,
  parseDayRecord,
  type Scheduled,
  scheduledTemplates,
  today,
} from "../checklists/days.ts";
import { MAX_STEPS, stepsOf } from "../checklists/index.ts";
import {
  latestTicks,
  type RunRow,
  type RunView,
  runOf,
  runViews,
  TICKS_PER_STEP,
  ticked,
} from "../checklists/runs.ts";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { jsonList } from "../records/common.ts";
import { loadGeneralSettings } from "../settings.ts";
import { parseLocalDate } from "../time/local.ts";
import { PRIVATE_INPUTS, personAtScreen, runShape } from "./checklist.ts";

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date, YYYY-MM-DD");

const whoShape = z.object({
  kind: z.enum(["staff", "role", "grant"]),
  value: z.string().nullable(),
});

const dayItemShape = z.object({
  template: z.object({ id: z.string(), name: z.string(), purpose: z.string().nullable() }),
  date: z.string(),
  who: whoShape.describe("Who may do it"),
  dueBy: z.string().nullable().describe("The local time it is due by"),
  dueAt: z.string().nullable(),
  opens: z.string(),
  closes: z.string().describe("The end of its day: not finished by then, it is missed"),
  state: z.enum(["not_started", "open", "done", "missed"]),
  /** Finished after its due time, or still open past it. */
  late: z.boolean(),
  run: runShape.nullable(),
  preview: z
    .array(z.object({ text: z.string(), required: z.boolean(), asksNote: z.boolean() }))
    .nullable()
    .describe("Its steps as they are now, before today's run is made"),
  mayDo: z.boolean().describe("The caller may do it themselves"),
  canTick: z.boolean().describe("The caller may tick it now (themselves, or for someone)"),
});

type DayItem = z.output<typeof dayItemShape>;

const iso = (s: number) => new Date(s * 1000).toISOString();

/** The day's window in the business's zone, and its due time (the date is checked first). */
const window = (date: string, dueBy: string | null, zone: string) => {
  if (!parseLocalDate(date)) throw new ValidationError("Not a date", { field: "date" });
  return dayWindow(date, dueBy, zone);
};

const doersOfRun = (run: RunRow): Doers => ({
  kind: run.doers_kind ?? "staff",
  value: run.doers_value ?? null,
});

const notThere = (template: string, date: string) =>
  new NotFoundError("checklist on", `${template} ${date}`);

/** One day's item as `account` reads it. */
function itemOf(args: {
  date: string;
  zone: string;
  now: number;
  isToday: boolean;
  run: RunRow | null;
  view: RunView | null;
  scheduled: Scheduled | undefined;
  mayDo: boolean;
  manages: boolean;
}): DayItem {
  const { run, scheduled } = args;
  // A run keeps the due time it was made with; before it is made, the template's.
  const w = run
    ? { opens: run.opens, closes: run.closes, dueAt: run.due_at ?? null }
    : window(args.date, scheduled?.schedule.dueBy ?? null, args.zone);
  const state: DayItem["state"] = run
    ? run.state === "cancelled"
      ? "missed"
      : run.state
    : "not_started";
  const finishedAt = run?.closed_at ? Math.floor(Date.parse(run.closed_at) / 1000) : null;
  const late =
    w.dueAt !== null &&
    (state === "done" ? finishedAt !== null && finishedAt > w.dueAt : args.now > w.dueAt);
  const open = state === "not_started" || state === "open";
  return {
    template: {
      id: run?.checklist_id ?? scheduled?.template.id ?? "",
      name: run?.name ?? scheduled?.template.name ?? "",
      purpose: scheduled?.template.purpose ?? null,
    },
    date: args.date,
    who: run ? doersOfRun(run) : (scheduled?.schedule.doers ?? { kind: "staff", value: null }),
    dueBy: w.dueAt === null ? null : localTime(w.dueAt, args.zone),
    dueAt: w.dueAt === null ? null : iso(w.dueAt),
    opens: iso(w.opens),
    closes: iso(w.closes),
    state,
    late,
    run: args.view,
    preview:
      !run && scheduled
        ? scheduled.template.steps.map((s) => ({
            text: s.text,
            required: s.required,
            asksNote: s.note,
          }))
        : null,
    mayDo: args.mayDo,
    canTick:
      open &&
      args.isToday &&
      args.now < w.closes &&
      args.now >= w.opens &&
      (args.mayDo || args.manages),
  };
}

const localTime = (at: number, zone: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(at * 1000));

/** The runs of `date` (one read, by the opening index). */
async function runsOn(ctx: HandlerContext, date: string, zone: string): Promise<RunRow[]> {
  const w = window(date, null, zone);
  const rows = await ctx.db
    .selectFrom("core_checklist_run")
    .selectAll()
    .where("object_type", "=", DAY_OBJECT)
    .where("opens", ">=", w.opens)
    .where("opens", "<", w.closes)
    .orderBy("name")
    .limit(500)
    .execute();
  return (rows as RunRow[]).filter((r) => parseDayRecord(r.record_id)?.date === date);
}

// --- Today --------------------------------------------------------------------------------------

export const checklistToday = defineOperation({
  name: "checklist.today",
  description:
    "Tool-only (a shipped pack's tool): the checklists due today in the business's time zone " +
    "(the ones with a standing schedule, done on their own, not a shift's) that the caller may " +
    "do, and for someone who manages checklists every one: each with when it is due by, who may " +
    "do it, its steps and their ticks (who ticked each and when), or a preview before today's " +
    "run is made, and whether the caller may tick it now. A person's own read, never an " +
    "assistant's. Read-only.",
  input: z.object({}),
  output: z.object({
    zone: z.string(),
    date: z.string(),
    items: z.array(dayItemShape),
    you: z.string(),
    youManage: z
      .boolean()
      .describe("The reader manages checklists: tick for anyone, see every day"),
  }),
  permission: "records:read",
  risk: "read",
  toolOnly: true,
  auditForPeople: true,
  mcp: { expose: false },
  async handler(_input, ctx) {
    const account = await personAtScreen(ctx, "checklist.today");
    const { timezone } = await loadGeneralSettings(ctx.db);
    const date = today(ctx.now, timezone);
    const now = Math.floor(Date.parse(ctx.now) / 1000);
    const me = (await accountsOf(ctx.db, [account])).get(account);
    const manages = accountManages(me);
    const scheduled = await scheduledTemplates(ctx.db);
    const runs = await runsOn(ctx, date, timezone);
    const ran = new Set(runs.map((r) => r.checklist_id));
    const mine = runs.filter((r) => manages || accountMayDo(me, doersOfRun(r)));
    const pending = [...scheduled.values()].filter(
      (s) =>
        dueOn(s.schedule, date) &&
        !ran.has(s.template.id) &&
        (manages || accountMayDo(me, s.schedule.doers)),
    );
    const views = await runViews(ctx.db, mine, { account, rosters: manages });
    const items = [
      ...mine.map((run, i) =>
        itemOf({
          date,
          zone: timezone,
          now,
          isToday: true,
          run,
          view: views[i] ?? null,
          scheduled: scheduled.get(run.checklist_id),
          mayDo: accountMayDo(me, doersOfRun(run)),
          manages,
        }),
      ),
      ...pending.map((s) =>
        itemOf({
          date,
          zone: timezone,
          now,
          isToday: true,
          run: null,
          view: null,
          scheduled: s,
          mayDo: accountMayDo(me, s.schedule.doers),
          manages,
        }),
      ),
    ].sort(
      (a, b) =>
        (a.dueAt ?? "~").localeCompare(b.dueAt ?? "~") ||
        a.template.name.localeCompare(b.template.name),
    );
    return { zone: timezone, date, items, you: account, youManage: manages };
  },
});

// --- One day ------------------------------------------------------------------------------------

/** A day of one checklist as the caller stands toward it. */
interface DayStanding {
  account: string;
  zone: string;
  date: string;
  isToday: boolean;
  run: RunRow | null;
  scheduled: Scheduled | undefined;
  doers: Doers;
  mayDo: boolean;
  manages: boolean;
}

/**
 * The caller's standing toward a checklist's day: today's run (or the template due today) for
 * whoever may do it; any day's for those who manage checklists. Anyone else is told it is not
 * there, not even that it was missed.
 */
async function dayStanding(
  ctx: HandlerContext,
  account: string,
  template: string,
  date: string,
): Promise<DayStanding> {
  if (!parseLocalDate(date)) throw new ValidationError("Not a date", { field: "date" });
  const { timezone } = await loadGeneralSettings(ctx.db);
  const isToday = date === today(ctx.now, timezone);
  const run = await runOf(ctx.db, DAY_OBJECT, dayRecord(template, date));
  const scheduled = (await scheduledTemplates(ctx.db, [template])).get(template);
  const me = (await accountsOf(ctx.db, [account])).get(account);
  const manages = accountManages(me);
  if (!run && (!isToday || !scheduled || !dueOn(scheduled.schedule, date))) {
    throw notThere(template, date);
  }
  const doers = run ? doersOfRun(run) : (scheduled as Scheduled).schedule.doers;
  const mayDo = accountMayDo(me, doers);
  if (!manages && !(mayDo && isToday)) throw notThere(template, date);
  return { account, zone: timezone, date, isToday, run, scheduled, doers, mayDo, manages };
}

const dayInput = {
  template: z.string().min(1).max(64).describe("The checklist"),
  date: localDate.describe("Its day (YYYY-MM-DD, the business's): today, to tick it"),
};

export const checklistDay = defineOperation({
  name: "checklist.day",
  description:
    "Tool-only (a shipped pack's tool): one checklist done on its own, on one day: its steps, " +
    "each step's latest tick (who ticked it, and for whom, and when), whether it is done (by " +
    "whom, when) or missed, and whether the caller may tick it now. Today's for whoever may do " +
    "it; any day's for someone who manages checklists, with the people who may do it (to tick " +
    "for one of them). What someone wrote on a tick only to its author and those who manage " +
    "checklists. To anyone else it is not there. A person's own read. Read-only.",
  input: z.object(dayInput),
  output: z.object({
    item: dayItemShape,
    zone: z.string(),
    doers: z
      .array(z.object({ id: z.string(), name: z.string() }))
      .nullable()
      .describe("Who may do it (at most 200), for someone who manages checklists"),
    you: z.string(),
    youManage: z.boolean(),
  }),
  permission: "records:read",
  risk: "read",
  toolOnly: true,
  auditForPeople: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    const account = await personAtScreen(ctx, "checklist.day");
    const s = await dayStanding(ctx, account, input.template, input.date);
    const view = s.run
      ? ((await runViews(ctx.db, [s.run], { account, rosters: s.manages }))[0] ?? null)
      : null;
    return {
      item: itemOf({
        date: s.date,
        zone: s.zone,
        now: Math.floor(Date.parse(ctx.now) / 1000),
        isToday: s.isToday,
        run: s.run,
        view,
        scheduled: s.scheduled,
        mayDo: s.mayDo,
        manages: s.manages,
      }),
      zone: s.zone,
      doers: s.manages ? await doersOf(ctx.db, s.doers) : null,
      you: account,
      youManage: s.manages,
    };
  },
});

// --- Ticking ------------------------------------------------------------------------------------

/**
 * What a tick or a finish needs: today, inside the day, a run (made now from its template if the
 * cron has not yet), open, and the caller one who may do it (for themselves) or who manages
 * checklists (for someone who may, with why).
 */
async function prepareDayTick(
  ctx: HandlerContext,
  name: string,
  input: { template: string; date: string; for?: string | undefined; forWhy?: string | undefined },
) {
  const account = await personAtScreen(ctx, name);
  const s = await dayStanding(ctx, account, input.template, input.date);
  if (s.run && s.run.state !== "open") {
    throw new ConflictError(
      `This checklist is ${s.run.state === "done" ? "done" : "missed"}, so it does not change.`,
      { rule: "checklist_closed", state: s.run.state },
    );
  }
  const now = Math.floor(Date.parse(ctx.now) / 1000);
  const w = s.run ? { opens: s.run.opens, closes: s.run.closes } : window(s.date, null, s.zone);
  if (!s.isToday || now < w.opens || now >= w.closes) {
    throw new ConflictError("This checklist is ticked on its own day only.", {
      rule: "checklist_window",
    });
  }
  const forOther = input.for !== undefined && input.for !== account;
  let ticker = account;
  if (forOther) {
    if (!s.manages) {
      throw new ForbiddenError("Only someone who manages checklists ticks one for someone else.", {
        rule: "checklist_for_someone",
      });
    }
    const them = (await accountsOf(ctx.db, [input.for as string])).get(input.for as string);
    if (!accountMayDo(them, s.doers)) {
      throw new ValidationError("They may not do this checklist.", {
        field: "for",
        rule: "checklist_not_theirs",
      });
    }
    if (!input.forWhy?.trim()) {
      throw new ValidationError(
        "Ticking for someone else needs a reason (it is kept with the tick).",
        { field: "forWhy", rule: "checklist_for_why" },
      );
    }
    ticker = input.for as string;
  } else if (!s.mayDo) {
    // Someone who manages checklists but may not do this one ticks it for someone who may.
    throw new ValidationError("Say whom you are ticking this for: it is not yours to do.", {
      field: "for",
      rule: "checklist_for_whom",
    });
  }
  let make: ReturnType<typeof makeDayRunsStatements> | null = null;
  let runId = s.run?.id ?? "";
  let steps = s.run ? stepsOf(s.run.steps) : [];
  if (!s.run) {
    const scheduled = s.scheduled as Scheduled;
    runId = newId("checklistRun");
    make = makeDayRunsStatements([newDayRunValues(runId, scheduled, s.date, s.zone, ctx.now)]);
    steps = scheduled.template.steps;
  }
  return {
    account,
    standing: s,
    forAccount: ticker,
    onBehalf: forOther,
    forWhy: forOther ? (input.forWhy?.trim() ?? null) : null,
    make,
    runId,
    steps,
  };
}

/** The day's run, whoever made it: this call a moment ago, or the minute cron meanwhile. */
const runOfDay = (template: string, date: string) =>
  sql<string>`(SELECT id FROM core_checklist_run WHERE object_type = ${DAY_OBJECT} AND record_id = ${dayRecord(template, date)})`;

/** The SQL that every step of the run `core_checklist_run` has a latest tick that is not a clear. */
const everyStepTicked = (requiredOnly: boolean) =>
  sql<boolean>`NOT EXISTS (SELECT 1 FROM json_each(core_checklist_run.steps) s
    WHERE ${requiredOnly ? sql`json_extract(s.value, '$.required') = 1 AND ` : sql``}coalesce((SELECT k.state FROM core_checklist_tick k
      WHERE k.run_id = core_checklist_run.id AND k.position = s.key
      ORDER BY k.ticked_at DESC, k.id DESC LIMIT 1), 'cleared') = 'cleared')`;

const forInput = {
  for: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("Someone who manages checklists ticking for someone who may do it: their account"),
  forWhy: z.string().trim().max(500).optional().describe("Ticking for someone else: why"),
};

export const checklistDayTick = defineOperation({
  name: "checklist.dayTick",
  description:
    "Tool-only (a shipped pack's tool): tick one step of today's run of a checklist done on its " +
    "own: done (with a note where the step asks for one), not done (with why), or clear it. " +
    "Anyone who may do it ticks as themselves; someone who manages checklists may tick for " +
    "someone who may (`for`), with why (`forWhy`), kept as ticked by them for that person. " +
    "Every tick is kept, the latest counts, and only someone who manages checklists changes a " +
    "tick someone else made. Whoever ticks the last step finishes it, and a finished checklist " +
    "never changes. On its own day only. A person's own act, never an assistant's.",
  input: z.object({
    ...dayInput,
    step: z
      .number()
      .int()
      .min(0)
      .max(MAX_STEPS - 1)
      .describe("The step's position, from 0"),
    state: z.enum(["done", "not_done", "clear"]),
    note: z.string().trim().max(1000).optional().describe("What was found or done"),
    why: z.string().trim().max(500).optional().describe("Why it was not done"),
    ...forInput,
  }),
  output: z.object({
    run: z.string(),
    step: z.number().int(),
    state: z.enum(["done", "not_done", "clear"]),
    ticked: z.number().int().describe("Steps ticked now, as this call saw them"),
    of: z.number().int(),
    finished: z.boolean().describe("This tick finished it (every step ticked)"),
  }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  auditForPeople: true,
  mcp: { expose: false },
  redact: [...PRIVATE_INPUTS, "state"],
  auditSummary: (output) => ({ run: output.run, step: output.step }),
  async handler(input, ctx) {
    const p = await prepareDayTick(ctx, "checklist.dayTick", input);
    const step = p.steps[input.step];
    if (!step) {
      throw new ValidationError(`This checklist has ${p.steps.length} steps.`, { field: "step" });
    }
    const note = input.note?.trim() || null;
    const why = input.why?.trim() || null;
    if (input.state === "done" && step.note && !note) {
      throw new ValidationError(`"${step.text}" asks for a note: write what was found or done.`, {
        field: "note",
        rule: "checklist_note_needed",
      });
    }
    if (input.state === "not_done" && !why) {
      throw new ValidationError("Say why it was not done.", {
        field: "why",
        rule: "checklist_why",
      });
    }
    const run = p.standing.run;
    const latest = run ? (await latestTicks(ctx.db, [run.id])).get(run.id) : undefined;
    const current = latest?.get(input.step);
    // Someone else's tick is changed only by someone who manages checklists.
    if (
      current &&
      current.state !== "cleared" &&
      current.ticked_by !== p.account &&
      !p.standing.manages
    ) {
      throw new ForbiddenError(
        "Someone else ticked this step: only whoever manages checklists changes it.",
        {
          rule: "checklist_not_your_tick",
        },
      );
    }
    if (input.state === "clear" && !ticked(current)) {
      throw new ValidationError("This step is not ticked, so there is nothing to clear.", {
        field: "state",
        rule: "checklist_nothing_to_clear",
      });
    }
    if (run) {
      const count = await ctx.db
        .selectFrom("core_checklist_tick")
        .select(sql<number>`count(*)`.as("n"))
        .where("run_id", "=", run.id)
        .where("position", "=", input.step)
        .executeTakeFirst();
      if (Number(count?.n ?? 0) >= TICKS_PER_STEP) {
        throw new ConflictError(
          `This step has been ticked ${TICKS_PER_STEP} times, the most one step takes.`,
          { rule: "checklist_too_many_ticks" },
        );
      }
    }
    if (p.make) ctx.write(...p.make);
    const runId = runOfDay(input.template, p.standing.date);
    ctx.write(
      ctx.db.insertInto("core_checklist_tick").values({
        id: newId("checklistTick"),
        run_id: runId,
        position: input.step,
        state: input.state === "clear" ? "cleared" : input.state,
        why: input.state === "not_done" ? why : null,
        note: input.state === "clear" ? null : note,
        ticked_by: p.account,
        ticked_for: p.forAccount,
        on_behalf: p.onBehalf ? 1 : 0,
        on_behalf_why: p.forWhy,
        ticked_at: ctx.now,
      }),
      // Whoever ticks the last step finishes it: judged in the batch, after this tick, so two
      // people ticking the last two steps at once still finish it.
      ctx.db
        .updateTable("core_checklist_run")
        .set({
          state: "done",
          account_id: p.forAccount,
          closed_at: ctx.now,
          closed_by: p.account,
          closed_why: p.forWhy,
        })
        .where("id", "=", runId)
        .where("state", "=", "open")
        .where(everyStepTicked(false)),
    );
    const now = new Map([...(latest ?? new Map())].map(([k, v]) => [k, ticked(v)]));
    now.set(input.step, input.state !== "clear");
    const count = [...now.values()].filter(Boolean).length;
    return {
      run: p.runId,
      step: input.step,
      state: input.state,
      ticked: count,
      of: p.steps.length,
      finished: input.state !== "clear" && count === p.steps.length,
    };
  },
});

export const checklistDayDone = defineOperation({
  name: "checklist.dayDone",
  description:
    "Tool-only (a shipped pack's tool): finish today's run of a checklist done on its own when " +
    "optional steps are left, once every required step is ticked (done, or not done with why). " +
    "Finished is final: it never changes again. Anyone who may do it; someone who manages " +
    "checklists for someone who may, with why. A person's own act.",
  input: z.object({ ...dayInput, ...forInput }),
  output: z.object({ run: z.string(), state: z.literal("done") }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  auditForPeople: true,
  mcp: { expose: false },
  redact: PRIVATE_INPUTS,
  auditSummary: (output) => ({ run: output.run }),
  async handler(input, ctx) {
    const p = await prepareDayTick(ctx, "checklist.dayDone", input);
    const run = p.standing.run;
    const latest = run ? (await latestTicks(ctx.db, [run.id])).get(run.id) : undefined;
    const left = p.steps
      .map((s, i) => ({ s, i }))
      .filter(({ s, i }) => s.required && !ticked(latest?.get(i)));
    if (left.length) {
      throw new ValidationError(
        `Not every required step is ticked: ${left.map(({ s }) => s.text).join("; ")}.`,
        { rule: "checklist_incomplete", steps: left.map(({ i }) => i) },
      );
    }
    if (p.make) ctx.write(...p.make);
    ctx.write(
      // Still open, and every required step still ticked (a clear meanwhile fails it whole).
      sql`INSERT INTO core_staff_guard (expected, actual) SELECT 1, count(*) FROM core_checklist_run WHERE object_type = ${DAY_OBJECT} AND record_id = ${dayRecord(input.template, p.standing.date)} AND state = 'open' AND ${everyStepTicked(true)}`.compile(
        ctx.db,
      ),
      ctx.db
        .updateTable("core_checklist_run")
        .set({
          state: "done",
          account_id: p.forAccount,
          closed_at: ctx.now,
          closed_by: p.account,
          closed_why: p.forWhy,
        })
        .where("id", "=", runOfDay(input.template, p.standing.date))
        .where("state", "=", "open"),
    );
    return { run: p.runId, state: "done" as const };
  },
});

// --- How each day went ----------------------------------------------------------------------------

const DAYS_MAX = 62;
const DAYS_RUNS_MAX = 500;

export const checklistDays = defineOperation({
  name: "checklist.days",
  description:
    "Tool-only (a shipped pack's tool): how the checklists done on their own went, day by day, " +
    "from `from` to `to` (local dates, both included, at most 62 days): each day's run, whether " +
    "it is open, done (by whom, for whom, when, and whether after its due time) or missed (with " +
    "the steps nobody ticked), how many steps were ticked and how many for someone by someone " +
    "else. For those who manage checklists (checklists:write), a person's own read. Read-only.",
  input: z.object({
    from: localDate,
    to: localDate,
    template: z.string().min(1).max(64).optional().describe("Only this checklist's days"),
  }),
  output: z.object({
    zone: z.string(),
    days: z.array(
      z.object({
        run: z.string(),
        template: z.object({ id: z.string(), name: z.string() }),
        date: z.string(),
        state: z.enum(["open", "done", "missed"]),
        dueAt: z.string().nullable(),
        late: z.boolean(),
        finishedAt: z.string().nullable(),
        finishedBy: z.string().nullable().describe("Who finished it"),
        finishedFor: z
          .string()
          .nullable()
          .describe("Finished for someone by someone who manages checklists: whom"),
        steps: z.number().int(),
        ticked: z.number().int(),
        onBehalf: z.number().int().describe("Ticks made for someone by someone else"),
        missed: z.array(z.string()).describe("The steps nobody ticked, when it was missed"),
      }),
    ),
    truncated: z.boolean(),
  }),
  permission: "records:read",
  risk: "read",
  toolOnly: true,
  auditForPeople: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    const account = await personAtScreen(ctx, "checklist.days");
    const me = (await accountsOf(ctx.db, [account])).get(account);
    if (!accountManages(me)) {
      throw new ForbiddenError("Only someone who manages checklists sees how every day went.", {
        rule: "checklists_manage",
      });
    }
    const from = parseLocalDate(input.from);
    const to = parseLocalDate(input.to);
    if (!from || !to) throw new ValidationError("Not a date", { field: from ? "to" : "from" });
    if (input.to < input.from) {
      throw new ValidationError("It must end on or after its first date", { field: "to" });
    }
    const days =
      (Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day)) /
        86_400_000 +
      1;
    if (days > DAYS_MAX) {
      throw new ValidationError(`At most ${DAYS_MAX} days at a time`, { field: "to" });
    }
    const { timezone } = await loadGeneralSettings(ctx.db);
    const start = window(input.from, null, timezone).opens;
    const end = window(input.to, null, timezone).closes;
    let q = ctx.db
      .selectFrom("core_checklist_run as r")
      .selectAll("r")
      .select(
        sql<number>`(SELECT count(*) FROM core_checklist_tick t WHERE t.run_id = r.id AND t.on_behalf = 1)`.as(
          "behalf",
        ),
      )
      .where("r.object_type", "=", DAY_OBJECT)
      .where("r.opens", ">=", start)
      .where("r.opens", "<", end)
      .orderBy("r.opens", "desc")
      .orderBy("r.name")
      .limit(DAYS_RUNS_MAX + 1);
    if (input.template) q = q.where("r.checklist_id", "=", input.template);
    const rows = await q.execute();
    const truncated = rows.length > DAYS_RUNS_MAX;
    if (truncated) rows.length = DAYS_RUNS_MAX;
    const latest = await latestTicks(
      ctx.db,
      rows.map((r) => r.id),
    );
    const names = new Map<string, string>();
    const accounts = [
      ...new Set(rows.flatMap((r) => [r.closed_by, r.account_id]).filter((a): a is string => !!a)),
    ];
    if (accounts.length) {
      for (const u of await ctx.db
        .selectFrom("core_user")
        .select(["id", "name", "email"])
        .where("id", "in", jsonList(accounts))
        .execute()) {
        names.set(u.id, u.name || u.email);
      }
    }
    const nameOf = (a: string | null) => (a ? (names.get(a) ?? "a former staff member") : null);
    const now = Math.floor(Date.parse(ctx.now) / 1000);
    return {
      zone: timezone,
      truncated,
      days: rows.map((r) => {
        const steps = stepsOf(r.steps);
        let missed: number[] = [];
        try {
          missed = r.missed_steps ? (JSON.parse(r.missed_steps) as number[]) : [];
        } catch {
          missed = [];
        }
        const state = r.state === "cancelled" ? "missed" : r.state;
        const finishedAt = r.closed_at && state === "done" ? r.closed_at : null;
        const due = r.due_at ?? null;
        return {
          run: r.id,
          template: { id: r.checklist_id, name: r.name },
          date: parseDayRecord(r.record_id)?.date ?? "",
          state,
          dueAt: due === null ? null : iso(due),
          late:
            due !== null &&
            (finishedAt ? Date.parse(finishedAt) / 1000 > due : state !== "done" && now > due),
          finishedAt,
          finishedBy: state === "done" ? nameOf(r.closed_by) : null,
          finishedFor:
            state === "done" && r.account_id && r.account_id !== r.closed_by
              ? nameOf(r.account_id)
              : null,
          steps: steps.length,
          ticked: [...(latest.get(r.id)?.values() ?? [])].filter(ticked).length,
          onBehalf: Number(r.behalf),
          missed: missed.map((i) => steps[i]?.text ?? `Step ${i + 1}`),
        };
      }),
    };
  },
});

export const checklistDayOperations = [
  checklistToday,
  checklistDay,
  checklistDayTick,
  checklistDayDone,
  checklistDays,
] as const;
