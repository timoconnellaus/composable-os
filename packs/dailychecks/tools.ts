// The Daily checklists tools (ADR 0651). They become operations x.dailychecks.<tool>, run in the
// sandbox, and reach the host only through ctx.ops. None of them holds a rule: which checklists are
// due today, who may do one, who may tick for whom, that the last tick finishes it, that a finished
// or missed day never changes, and who reads how a day went are the host's (its tool-only
// `checklist.today`, `checklist.day`, `checklist.dayTick`, `checklist.dayDone` and
// `checklist.days`, and the database's triggers). Each operation acts for the staff account the
// host verified as this tool's caller, never for anything in the input.
//
// Who may call which (ADR 0652):
// - `today`, `day`, `tick`, `done`: every staff account (`anyStaff`), pack roles included, so a
//   cleaner's or a coach's account reaches them with no grant; the host answers each caller with
//   only the checklists they may do (and, for someone who manages checklists, every one);
// - `history`: those who manage checklists, the core permission checklists:write (admins, and
//   anyone an admin grants it), never a pack role (`corePermission`).
// Every tool is a person's own, at the screen (`humanOnly`): a tick says a person did the step, and
// how a checklist went is read by people, never by an assistant.
import { defineTool, z } from "@composable-os/sdk";

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date, YYYY-MM-DD");

const tick = z.object({
  id: z.string(),
  state: z.enum(["done", "not_done", "cleared"]),
  done: z.boolean(),
  why: z.string().nullable(),
  note: z.string().nullable(),
  onBehalfWhy: z.string().nullable(),
  withheld: z.boolean().describe("Has words only its author and those who manage checklists read"),
  by: z.string(),
  byName: z.string(),
  for: z.string(),
  forName: z.string(),
  onBehalf: z.boolean(),
  at: z.string(),
  label: z.string().describe('"Ticked by X", or "Ticked by X for Y"'),
});

const run = z.object({
  id: z.string(),
  object: z.string(),
  record: z.string(),
  template: z.object({ id: z.string(), name: z.string(), version: z.number() }),
  state: z.enum(["open", "done", "missed", "cancelled"]),
  account: z.string().nullable(),
  name: z.string().nullable(),
  opens: z.string(),
  closes: z.string(),
  tickUntil: z.string(),
  madeAt: z.string(),
  closedAt: z.string().nullable(),
  closedBy: z.string().nullable(),
  closedByName: z.string().nullable(),
  closedWhy: z.string().nullable(),
  steps: z.array(
    z.object({
      position: z.number(),
      text: z.string(),
      required: z.boolean(),
      asksNote: z.boolean(),
      tick: tick.nullable().describe("The latest tick"),
      history: z.array(tick).describe("Earlier ticks, the latest 20"),
      historyTruncated: z.boolean(),
      missed: z.boolean(),
    }),
  ),
  corrections: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      by: z.string(),
      byName: z.string(),
      at: z.string(),
    }),
  ),
});

const item = z.object({
  template: z.object({ id: z.string(), name: z.string(), purpose: z.string().nullable() }),
  date: z.string(),
  who: z.object({ kind: z.enum(["staff", "role", "grant"]), value: z.string().nullable() }),
  dueBy: z.string().nullable().describe("The local time it is due by"),
  dueAt: z.string().nullable(),
  opens: z.string(),
  closes: z.string().describe("The end of its day: not finished by then, it is missed"),
  state: z.enum(["not_started", "open", "done", "missed"]),
  late: z.boolean(),
  run: run.nullable(),
  preview: z
    .array(z.object({ text: z.string(), required: z.boolean(), asksNote: z.boolean() }))
    .nullable(),
  mayDo: z.boolean().describe("You may do it yourself"),
  canTick: z.boolean().describe("You may tick it now (yourself, or for someone)"),
});

const day = { template: z.string().min(1).max(64), date: localDate };
const forSomeone = {
  for: z.string().min(1).max(64).optional().describe("Ticking for someone who may do it"),
  forWhy: z.string().trim().max(500).optional().describe("Ticking for someone else: why"),
};

export const today = defineTool({
  description:
    "Today's checklists (the ones done on their own, not a shift's): each one you may do, and " +
    "every one if you manage checklists, with when it is due by, its steps and who ticked each " +
    "and when, and whether you may tick it now. A person's own read.",
  input: z.object({}),
  output: z.object({
    zone: z.string(),
    date: z.string(),
    items: z.array(item),
    you: z.string(),
    youManage: z.boolean(),
  }),
  risk: "read",
  anyStaff: true,
  humanOnly: true,
  handler: async (input, ctx) => (await ctx.ops.call("checklist.today", input)) as never,
});

export const checklistDay = defineTool({
  description:
    "One checklist on one day: its steps and ticks, whether it is done (by whom, when) or " +
    "missed. Today's for whoever may do it; any day's, with who may do it, for someone who " +
    "manages checklists. A person's own read.",
  input: z.object(day),
  output: z.object({
    item,
    zone: z.string(),
    doers: z.array(z.object({ id: z.string(), name: z.string() })).nullable(),
    you: z.string(),
    youManage: z.boolean(),
  }),
  risk: "read",
  anyStaff: true,
  humanOnly: true,
  handler: async (input, ctx) => (await ctx.ops.call("checklist.day", input)) as never,
});

export const tickStep = defineTool({
  description:
    "Tick one step of today's checklist: done (with a note where the step asks for one), not " +
    "done (with why), or clear your tick. Whoever ticks the last step finishes it, and a " +
    "finished checklist never changes. Someone who manages checklists may tick for someone who " +
    "may do it (`for`), saying why (`forWhy`). A person's own act.",
  input: z.object({
    ...day,
    step: z.number().int().min(0).max(49),
    state: z.enum(["done", "not_done", "clear"]),
    note: z.string().trim().max(1000).optional(),
    why: z.string().trim().max(500).optional(),
    ...forSomeone,
  }),
  output: z.object({
    run: z.string(),
    step: z.number(),
    state: z.enum(["done", "not_done", "clear"]),
    ticked: z.number(),
    of: z.number(),
    finished: z.boolean(),
  }),
  risk: "write",
  anyStaff: true,
  humanOnly: true,
  // What someone writes on a step, why it was not done, why it was ticked for them, and how it
  // went: never in the audit log.
  redact: ["note", "why", "forWhy", "state"],
  handler: async (input, ctx) => (await ctx.ops.call("checklist.dayTick", input)) as never,
});

export const done = defineTool({
  description:
    "Finish today's checklist with optional steps left, once every required step is ticked. " +
    "Finished is final. Someone who manages checklists may finish it for someone who may do " +
    "it, saying why. A person's own act.",
  input: z.object({ ...day, ...forSomeone }),
  output: z.object({ run: z.string(), state: z.literal("done") }),
  risk: "write",
  anyStaff: true,
  humanOnly: true,
  redact: ["forWhy"],
  handler: async (input, ctx) => (await ctx.ops.call("checklist.dayDone", input)) as never,
});

export const history = defineTool({
  description:
    "How each day went, from `from` to `to` (local dates, at most 62 days): every checklist " +
    "done on its own, whether it was done (by whom, for whom, when, late or not, and how many " +
    "steps were ticked not done) or missed (with the steps nobody ticked). Those who manage checklists, a person only.",
  input: z.object({
    from: localDate,
    to: localDate,
    template: z.string().min(1).max(64).optional(),
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
        finishedBy: z.string().nullable(),
        finishedFor: z.string().nullable(),
        steps: z.number(),
        ticked: z.number(),
        notDone: z.number(),
        onBehalf: z.number(),
        missed: z.array(z.string()),
      }),
    ),
    truncated: z.boolean(),
  }),
  risk: "read",
  corePermission: "checklists:write",
  humanOnly: true,
  handler: async (input, ctx) => (await ctx.ops.call("checklist.days", input)) as never,
});
