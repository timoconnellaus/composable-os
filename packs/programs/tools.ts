// The Programs tools. They become operations x.programs.<tool>, run in the sandbox, and reach
// the host only through ctx.ops. None of them holds a rule: what a layout may hold, who may read
// a session or write a log, which moves a session may make and that a move is made once are all
// the host's (the document schema, the customer and signed-in scopes, `states` and `from`). A
// tool composes those, and works out what is asked of it (a session's dates, a set's target from
// its plan, bests over a person's sets).
//
// Called by a customer, a tool runs as that customer (ADR 0414): its calls are my.* and see only
// what the seam shows them. Called by staff, it uses record.* and names the person.
import {
  defineTool,
  type ExtensionContext,
  OpsCallError,
  validateDocument,
  z,
} from "@composable-os/sdk";
import {
  type BankExercise,
  type DraftPlan,
  draftLayout,
  pickExercises,
  readBrief,
  readProgramText,
} from "./authoring.ts";
import {
  LAYOUT_SCHEMA,
  type Layout,
  type Prescription,
  prescriptions,
  type Session,
  type SetTarget,
} from "./layout.ts";

const EXERCISE = "programs.exercise";
const PROGRAM = "programs.program";
const ASSIGNMENT = "programs.assignment";
const SESSION = "programs.session";
const LOG = "programs.log";

/** Sessions written in one call: record.createMany's cap (ADR 0448). */
const SESSIONS_PER_BATCH = 50;
/** The most sets a history or progress reads (pages of 200). */
const SETS_READ_MAX = 2000;

interface RecordShape {
  id: string;
  title?: string | null;
  values: Record<string, unknown>;
}
interface ListShape {
  items: RecordShape[];
  nextCursor?: string | null;
}
type Filter = Record<string, unknown>;

const id = z.string().min(1).max(64);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A date: YYYY-MM-DD");
const text = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);
const num = (value: unknown): number | null =>
  typeof value === "number" ? value : value == null ? null : Number(value);

const isCustomer = (ctx: ExtensionContext) => ctx.caller?.kind === "customer";

/** A page of records: the caller's own (and shared) for a customer, any for staff. */
function list(
  ctx: ExtensionContext,
  object: string,
  input: {
    filter?: Filter;
    sort?: { field: string; direction: "asc" | "desc" };
    limit?: number;
    cursor?: string;
  },
): Promise<ListShape> {
  return ctx.ops.call<ListShape>(isCustomer(ctx) ? "my.list" : "record.list", { object, ...input });
}

function get(ctx: ExtensionContext, object: string, recordId: string): Promise<RecordShape> {
  return ctx.ops.call<RecordShape>(isCustomer(ctx) ? "my.get" : "record.get", {
    object,
    id: recordId,
  });
}

/** Every page, up to `cap` records. */
async function all(
  ctx: ExtensionContext,
  object: string,
  filter: Filter | undefined,
  sort: { field: string; direction: "asc" | "desc" },
  cap: number,
): Promise<{ items: RecordShape[]; capped: boolean }> {
  const items: RecordShape[] = [];
  let cursor: string | undefined;
  do {
    const page = await list(ctx, object, {
      ...(filter ? { filter } : {}),
      sort,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && items.length < cap);
  return { items: items.slice(0, cap), capped: Boolean(cursor) || items.length > cap };
}

/** Staff name the person a call is about; a customer is always themselves, and never names one. */
function personFilter(ctx: ExtensionContext, personId: string | undefined): Filter | null {
  if (isCustomer(ctx)) {
    if (personId)
      throw new OpsCallError(
        "invalid_input",
        "A member never names a person: it is always themselves",
      );
    return null;
  }
  if (!personId) throw new OpsCallError("invalid_input", "Name the person (personId)");
  return { field: "person", op: "eq", value: personId };
}

function addDays(day: string, days: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

const todayUtc = () => new Date().toISOString().slice(0, 10);

const and = (...filters: (Filter | null | undefined)[]): Filter | undefined => {
  const kept = filters.filter((f): f is Filter => Boolean(f));
  return kept.length === 0 ? undefined : kept.length === 1 ? kept[0] : { and: kept };
};

// --- Assign --------------------------------------------------------------------------------------

export const assign = defineTool({
  description:
    "Give a published program to a person or to a class type from a start date: pins the " +
    "program's current published version and makes one dated session per session of its " +
    "layout (week w's session on day d is dated start + 7(w-1) + (d-1)). Editing the program " +
    "later changes none of them; publish a new version and assign again. Refused when the " +
    "program has never been published. Safe to call again with the same program, person or " +
    "class type and start date: it finishes what an interrupted call began.",
  input: z
    .object({
      programId: id,
      personId: id.optional().describe("A person: a client program"),
      classTypeId: id.optional().describe("A class type: a class program"),
      startDate: date,
    })
    .refine((v) => Boolean(v.personId) !== Boolean(v.classTypeId), {
      message: "Name a person or a class type, not both",
    }),
  output: z.object({
    assignmentId: z.string(),
    programVersion: z.number(),
    sessions: z.number(),
    startDate: z.string(),
    endDate: z.string(),
  }),
  // Many sessions in one call.
  risk: "bulk-write",
  async handler(input, ctx) {
    const program = await ctx.ops.call<RecordShape>("record.get", {
      object: PROGRAM,
      id: input.programId,
    });
    let version: { version: number; values: Record<string, unknown> };
    try {
      version = await ctx.ops.call("record.version", { object: PROGRAM, id: input.programId });
    } catch (error) {
      if (error instanceof OpsCallError && error.code === "not_found") {
        throw new OpsCallError(
          "invalid_input",
          "This program has not been published: a person with the publish permission publishes it first",
          { programId: input.programId },
        );
      }
      throw error;
    }
    const layout = version.values.layout as Layout;
    const weeks = layout.weeks.length;
    const endDate = addDays(input.startDate, weeks * 7 - 1);
    const kind = input.personId ? "personal" : "class";
    const programTitle = text(version.values.title) ?? program.title ?? "Program";
    const forWhom = input.personId
      ? text(
          (
            await ctx.ops.call<{ displayName?: string | null }>("person.get", {
              id: input.personId,
            })
          ).displayName,
        )
      : text(
          (
            await ctx.ops.call<RecordShape>("record.get", {
              object: "programs.classtype",
              id: input.classTypeId as string,
            })
          ).title,
        );
    const who = input.personId
      ? { field: "person", value: input.personId }
      : { field: "classType", value: input.classTypeId as string };

    // An earlier call that stopped part-way left its assignment making sessions: finish it.
    const earlier = await ctx.ops.call<ListShape>("record.list", {
      object: ASSIGNMENT,
      filter: {
        and: [
          { field: "program", op: "eq", value: input.programId },
          { field: who.field, op: "eq", value: who.value },
          { field: "startDate", op: "eq", value: input.startDate },
          { field: "programVersion", op: "eq", value: version.version },
          { field: "state", op: "eq", value: "generating" },
        ],
      },
      limit: 1,
    });
    const assignmentId =
      earlier.items[0]?.id ??
      (
        await ctx.ops.call<RecordShape>("record.create", {
          object: ASSIGNMENT,
          values: {
            title: `${programTitle}${forWhom ? ` for ${forWhom}` : ""}`,
            program: input.programId,
            programVersion: version.version,
            kind,
            [who.field]: who.value,
            startDate: input.startDate,
            endDate,
            ...(ctx.caller?.kind === "staff"
              ? { assignedBy: ctx.caller.userId, assignedByName: ctx.caller.name }
              : {}),
          },
        })
      ).id;

    const made = new Set(
      (
        await all(
          ctx,
          SESSION,
          { field: "assignment", op: "eq", value: assignmentId },
          { field: "date", direction: "asc" },
          10_000,
        )
      ).items.map((s) => text(s.values.key)),
    );
    const wanted: Record<string, unknown>[] = [];
    layout.weeks.forEach((week, w) => {
      week.sessions.forEach((session, position) => {
        const key = `${assignmentId}:${w + 1}:${position}`;
        if (made.has(key)) return;
        wanted.push({
          name: session.name,
          assignment: assignmentId,
          program: input.programId,
          programVersion: version.version,
          kind,
          [who.field]: who.value,
          date: addDays(input.startDate, w * 7 + session.day - 1),
          week: w + 1,
          day: session.day,
          position,
          key,
          ...(session.focus ? { focus: session.focus } : {}),
          plan: session,
          programTitle,
          ...(who.field === "classType" && forWhom ? { classTypeName: forWhom } : {}),
        });
      });
    });
    for (let start = 0; start < wanted.length; start += SESSIONS_PER_BATCH) {
      await ctx.ops.call("record.createMany", {
        object: SESSION,
        records: wanted.slice(start, start + SESSIONS_PER_BATCH),
      });
    }
    const sessions = made.size + wanted.length;
    // The "done" state last, from the state it was in (ADR 0437): a second call cannot do it twice.
    try {
      await ctx.ops.call("record.update", {
        object: ASSIGNMENT,
        id: assignmentId,
        from: "generating",
        values: { state: "active", sessionCount: sessions },
      });
    } catch (error) {
      if (!(error instanceof OpsCallError) || error.code !== "conflict") throw error;
    }
    return {
      assignmentId,
      programVersion: version.version,
      sessions,
      startDate: input.startDate,
      endDate,
    };
  },
});

// --- Reading sessions ----------------------------------------------------------------------------

const lastSet = z.object({
  date: z.string().nullable(),
  reps: z.number().nullable(),
  seconds: z.number().nullable(),
  load: z.number().nullable(),
  rpe: z.number().nullable(),
  level: z.number().nullable(),
});
const exerciseOut = z.object({
  id: z.string(),
  name: z.string().nullable(),
  video: z.string().nullable(),
  cues: z.string().nullable(),
  measure: z.string().nullable(),
  last: z
    .array(lastSet)
    .describe("The sets of the last time this person did it, before this session"),
});
const loggedSet = z.object({
  id: z.string(),
  item: z.string().nullable(),
  exercise: z.string().nullable(),
  setNumber: z.number().nullable(),
  level: z.number().nullable(),
  target: z.object({
    reps: z.number().nullable(),
    seconds: z.number().nullable(),
    load: z.number().nullable(),
  }),
  actual: z.object({
    reps: z.number().nullable(),
    seconds: z.number().nullable(),
    load: z.number().nullable(),
  }),
  rpe: z.number().nullable(),
  note: z.string().nullable(),
  recordedAs: z.string().nullable(),
  recordedByName: z.string().nullable(),
  exerciseName: z.string().nullable().describe("The exercise's name, as it was when logged"),
});
const sessionOut = z.object({
  id: z.string(),
  name: z.string().nullable(),
  date: z.string().nullable(),
  week: z.number().nullable(),
  day: z.number().nullable(),
  kind: z.string().nullable(),
  classType: z.string().nullable(),
  assignment: z.string().nullable(),
  programVersion: z.number().nullable(),
  programTitle: z.string().nullable(),
  classTypeName: z.string().nullable(),
  focus: z.string().nullable(),
  state: z.string().nullable(),
  plan: z
    .record(z.string(), z.unknown())
    .nullable()
    .describe("The session of the layout: blocks, items, levels and typed sets"),
});
type SessionOut = z.infer<typeof sessionOut>;

function sessionOf(record: RecordShape): SessionOut {
  const v = record.values;
  return {
    id: record.id,
    name: text(v.name),
    date: text(v.date),
    week: num(v.week),
    day: num(v.day),
    kind: text(v.kind),
    classType: text(v.classType),
    assignment: text(v.assignment),
    programVersion: num(v.programVersion),
    programTitle: text(v.programTitle),
    classTypeName: text(v.classTypeName),
    focus: text(v.focus),
    state: text(v.state),
    plan: (v.plan as Record<string, unknown> | null) ?? null,
  };
}

function loggedOf(record: RecordShape): z.infer<typeof loggedSet> {
  const v = record.values;
  return {
    id: record.id,
    item: text(v.item),
    exercise: text(v.exercise),
    setNumber: num(v.setNumber),
    level: num(v.level),
    target: { reps: num(v.targetReps), seconds: num(v.targetSeconds), load: num(v.targetLoad) },
    actual: { reps: num(v.actualReps), seconds: num(v.actualSeconds), load: num(v.actualLoad) },
    rpe: num(v.rpe),
    note: text(v.note),
    recordedAs: text(v.recordedAs),
    recordedByName: text(v.recordedByName),
    exerciseName: text(v.exerciseName),
  };
}

/**
 * The exercises a session's plan names, from the bank, with the person's last time at each.
 * `person` is whose sets: null for a member (the seam gives them their own), a filter for staff,
 * or `false` when the call is about no one (a coach reading a class): no last times then.
 */
async function exercisesFor(
  ctx: ExtensionContext,
  session: SessionOut,
  person: Filter | null | false,
): Promise<z.infer<typeof exerciseOut>[]> {
  const plan = session.plan as Session | null;
  if (!plan) return [];
  const ids = [
    ...new Set([
      ...(plan.warmup?.exercises ?? []).map((p) => p.exercise),
      ...prescriptions(plan).map((p) => p.prescription.exercise),
    ]),
  ];
  if (!ids.length) return [];
  const bank = await list(ctx, EXERCISE, {
    filter: { field: "id", op: "in", value: ids },
    limit: 200,
  });
  // The person's sets of these exercises before this session, newest first: the last time.
  const earlier =
    person === false
      ? { items: [] as RecordShape[] }
      : await all(
          ctx,
          LOG,
          and(
            { field: "exercise", op: "in", value: ids },
            { field: "session", op: "neq", value: session.id },
            session.date ? { field: "date", op: "lte", value: session.date } : null,
            person,
          ),
          { field: "date", direction: "desc" },
          400,
        );
  return ids.map((exerciseId) => {
    const found = bank.items.find((e) => e.id === exerciseId);
    const mine = earlier.items.filter((l) => l.values.exercise === exerciseId);
    const lastSession = mine[0]?.values.session;
    return {
      id: exerciseId,
      name: text(found?.values.name),
      video: text(found?.values.video),
      cues: text(found?.values.cues),
      measure: text(found?.values.measure),
      last: mine
        .filter((l) => l.values.session === lastSession)
        .sort((a, b) => (num(a.values.setNumber) ?? 0) - (num(b.values.setNumber) ?? 0))
        .map((l) => ({
          date: text(l.values.date),
          reps: num(l.values.actualReps),
          seconds: num(l.values.actualSeconds),
          load: num(l.values.actualLoad),
          rpe: num(l.values.rpe),
          level: num(l.values.level),
        })),
    };
  });
}

const personInput = id.optional().describe("Staff: the person. A member is always themselves.");

export const today = defineTool({
  description:
    "A person's own sessions on a date (default today, UTC: pass the person's local date), " +
    "each with its plan (blocks, items, levels and typed targets), the bank exercises it uses " +
    "and the numbers of the last time they did each. A member sees their own; staff name the " +
    "person. A class type's sessions are programs.classToday. Read-only.",
  input: z.object({ date: date.optional(), personId: personInput }),
  output: z.object({
    date: z.string(),
    sessions: z.array(sessionOut.extend({ exercises: z.array(exerciseOut) })),
  }),
  risk: "read",
  audiences: ["staff", "customer"],
  async handler(input, ctx) {
    const day = input.date ?? todayUtc();
    const person = personFilter(ctx, input.personId);
    const page = await list(ctx, SESSION, {
      filter: and(
        { field: "date", op: "eq", value: day },
        { field: "kind", op: "eq", value: "personal" },
        person,
      ),
      sort: { field: "week", direction: "asc" },
      limit: 50,
    });
    const sessions = [];
    for (const record of page.items) {
      const session = sessionOf(record);
      sessions.push({ ...session, exercises: await exercisesFor(ctx, session, person) });
    }
    return { date: day, sessions };
  },
});

export const sessionGet = defineTool({
  description:
    "One session: its plan, the bank exercises it uses with the person's last numbers at each, " +
    "and the sets logged on it so far. A member reads their own sessions and their class " +
    "types' (where `personId` is never given); staff read any, and name the person for a " +
    "class session's logs. Read-only.",
  input: z.object({ sessionId: id, personId: personInput }),
  output: z.object({
    session: sessionOut,
    exercises: z.array(exerciseOut),
    logged: z.array(loggedSet),
  }),
  risk: "read",
  audiences: ["staff", "customer"],
  async handler(input, ctx) {
    const record = await get(ctx, SESSION, input.sessionId);
    const session = sessionOf(record);
    const owner = sessionPerson(ctx, record, input.personId);
    // A coach reading a class session for no one in particular: every logged set, no last times.
    const person = owner
      ? { field: "person", op: "eq", value: owner }
      : isCustomer(ctx)
        ? null
        : false;
    const logged = await all(
      ctx,
      LOG,
      and({ field: "session", op: "eq", value: input.sessionId }, person || null),
      { field: "setNumber", direction: "asc" },
      400,
    );
    return {
      session,
      exercises: await exercisesFor(ctx, session, person),
      logged: logged.items.map(loggedOf),
    };
  },
});

/**
 * Whose numbers a session is read or logged for: for a member, themselves (the seam already
 * holds them to it, so null); for staff, the session's person, or the person they name on a class
 * session. A personal session is its person's, so naming another is a mistake in the call.
 */
function sessionPerson(
  ctx: ExtensionContext,
  record: RecordShape,
  personId: string | undefined,
): string | null {
  if (isCustomer(ctx)) {
    if (personId) {
      throw new OpsCallError(
        "invalid_input",
        "A member never names a person: it is always themselves",
      );
    }
    return null;
  }
  if (record.values.kind === "class") return personId ?? null;
  const own = text(record.values.person);
  if (personId && personId !== own) {
    throw new OpsCallError(
      "invalid_input",
      "This session is another person's: leave personId out, or name its person",
    );
  }
  return own;
}

export const classToday = defineTool({
  description:
    "A class type's sessions on a date (default today, UTC), with their plans: every level of " +
    "every item, typed targets, and the bank exercises. What a coach runs a class from and a " +
    "member reads before it. Notes for coaches only are left out for members. Read-only.",
  input: z.object({ classTypeId: id, date: date.optional() }),
  output: z.object({
    date: z.string(),
    sessions: z.array(sessionOut.extend({ exercises: z.array(exerciseOut) })),
  }),
  risk: "read",
  audiences: ["staff", "customer"],
  async handler(input, ctx) {
    const day = input.date ?? todayUtc();
    const page = await list(ctx, SESSION, {
      filter: {
        and: [
          { field: "date", op: "eq", value: day },
          { field: "kind", op: "eq", value: "class" },
          { field: "classType", op: "eq", value: input.classTypeId },
        ],
      },
      sort: { field: "week", direction: "asc" },
      limit: 20,
    });
    const sessions = [];
    for (const record of page.items) {
      const session = sessionOf(record);
      // A member's own last numbers on a class's exercises are theirs; a coach's call is about no one.
      sessions.push({
        ...session,
        exercises: await exercisesFor(ctx, session, isCustomer(ctx) ? null : false),
      });
    }
    return { date: day, sessions };
  },
});

// --- Logging -------------------------------------------------------------------------------------

/** The prescription and its set's target that `item` (and `level`) names in a session's plan. */
function targetIn(
  plan: Session,
  item: string,
  exercise: string | undefined,
  level: number | undefined,
  setNumber: number,
): { prescription: Prescription; target: SetTarget | null; level: number | null } {
  const found = prescriptions(plan).filter((p) => p.item === item);
  if (!found.length) {
    throw new OpsCallError("invalid_input", `This session has no item ${item}`, { item });
  }
  const levels = [...new Set(found.map((p) => p.level))];
  // An item's exercises for everyone (level null) are logged with or without the level taken.
  const everyone = found.filter((p) => p.level === null);
  if (levels.some((l) => l !== null) && level === undefined && !everyone.length) {
    throw new OpsCallError("invalid_input", `Item ${item} has levels: say which was taken`, {
      item,
      levels,
    });
  }
  if (level !== undefined && !levels.includes(level)) {
    throw new OpsCallError("invalid_input", `Item ${item} has no level ${level}`, { item, levels });
  }
  const atLevel =
    level === undefined
      ? levels.some((l) => l !== null)
        ? everyone
        : found
      : [...found.filter((p) => p.level === level), ...everyone];
  const match = exercise ? atLevel.filter((p) => p.prescription.exercise === exercise) : atLevel;
  if (!match.length || (!exercise && match.length > 1)) {
    throw new OpsCallError(
      "invalid_input",
      exercise
        ? `Item ${item}${level ? ` at level ${level}` : ""} does not have that exercise`
        : `Item ${item} has more than one exercise: say which`,
      { item, exercises: atLevel.map((p) => p.prescription.exercise) },
    );
  }
  const chosen = match[0] as (typeof match)[number];
  return {
    prescription: chosen.prescription,
    target: chosen.prescription.sets[setNumber - 1] ?? null,
    // An exercise for everyone keeps the level the person took, when they say it.
    level: chosen.level ?? level ?? null,
  };
}

const actual = z.object({
  reps: z.number().int().min(0).max(999).optional(),
  seconds: z.number().int().min(0).max(7200).optional(),
  load: z.number().min(0).max(1000).optional().describe("Kilograms"),
});
const rpe = z
  .number()
  .min(1)
  .max(10)
  .refine((n) => Number.isInteger(n * 2), "In halves: 7 or 7.5")
  .optional()
  .describe("How hard it felt, 1 to 10 in halves");

export const logAdd = defineTool({
  description:
    "Log one set done on a session: the item (A1), the exercise when the item has more than " +
    "one, the level taken when it has levels, which set (1, 2, …), what was done (reps, " +
    "seconds, load) and how hard it felt (RPE). The target is taken from the session's plan, " +
    "and who recorded it is the caller. A member logs on their own sessions and their class " +
    "types'; a coach logs for a client (on a class session, naming them). Nobody logs on a " +
    "session that is not theirs. Returns the set.",
  input: z.object({
    sessionId: id,
    item: z.string().min(1).max(6),
    exerciseId: id.optional(),
    level: z.number().int().min(1).max(5).optional(),
    setNumber: z.number().int().min(1).max(30),
    actual,
    rpe,
    note: z.string().max(500).optional(),
    personId: personInput,
  }),
  output: loggedSet,
  risk: "write",
  audiences: ["staff", "customer"],
  customerFields: {
    [LOG]: [
      "label",
      "exerciseName",
      "session",
      "assignment",
      "exercise",
      "item",
      "setNumber",
      "level",
      "date",
      "targetReps",
      "targetSeconds",
      "targetLoad",
      "recordedAs",
    ],
  },
  async handler(input, ctx) {
    // A member reads only sessions that are theirs or their class types': another's is not found.
    const record = await get(ctx, SESSION, input.sessionId);
    const session = sessionOf(record);
    const person = sessionPerson(ctx, record, input.personId);
    if (!isCustomer(ctx) && !person) {
      throw new OpsCallError("invalid_input", "A class session: name the person (personId)");
    }
    if (!session.plan) throw new OpsCallError("invalid_input", "This session has no plan");
    const { prescription, target, level } = targetIn(
      session.plan as unknown as Session,
      input.item,
      input.exerciseId,
      input.level,
      input.setNumber,
    );
    const values: Record<string, unknown> = {
      label: `${input.item} set ${input.setNumber}`,
      session: input.sessionId,
      assignment: session.assignment,
      exercise: prescription.exercise,
      exerciseName: text((await get(ctx, EXERCISE, prescription.exercise)).values.name),
      item: input.item,
      setNumber: input.setNumber,
      level,
      date: session.date,
      targetReps: target?.kind === "reps" ? target.reps : null,
      targetSeconds: target && target.kind !== "reps" ? target.seconds : null,
      targetLoad: target?.load ?? null,
      actualReps: input.actual.reps ?? null,
      actualSeconds: input.actual.seconds ?? null,
      actualLoad: input.actual.load ?? null,
      rpe: input.rpe ?? null,
      note: input.note ?? null,
      recordedAs: isCustomer(ctx) ? "self" : "staff",
    };
    if (isCustomer(ctx)) {
      // The host makes it the caller's, and refuses a session they cannot see (ADR 0447).
      return loggedOf(await ctx.ops.call<RecordShape>("my.create", { object: LOG, values }));
    }
    const caller = ctx.caller?.kind === "staff" ? ctx.caller : null;
    return loggedOf(
      await ctx.ops.call<RecordShape>("record.create", {
        object: LOG,
        values: {
          ...values,
          person,
          ...(caller ? { recordedBy: caller.userId, recordedByName: caller.name } : {}),
        },
      }),
    );
  },
});

export const logUpdate = defineTool({
  description:
    "Change a logged set's numbers, effort or note. A member changes their own sets only; " +
    "staff any. The target, the exercise and who recorded it stay as they were. Returns the set.",
  input: z.object({
    logId: id,
    actual: actual.optional(),
    rpe,
    note: z.string().max(500).nullable().optional(),
  }),
  output: loggedSet,
  risk: "write",
  audiences: ["staff", "customer"],
  async handler(input, ctx) {
    const values: Record<string, unknown> = {
      ...(input.actual?.reps !== undefined ? { actualReps: input.actual.reps } : {}),
      ...(input.actual?.seconds !== undefined ? { actualSeconds: input.actual.seconds } : {}),
      ...(input.actual?.load !== undefined ? { actualLoad: input.actual.load } : {}),
      ...(input.rpe !== undefined ? { rpe: input.rpe } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    };
    if (!Object.keys(values).length) {
      return loggedOf(await get(ctx, LOG, input.logId));
    }
    return loggedOf(
      await ctx.ops.call<RecordShape>(isCustomer(ctx) ? "my.update" : "record.update", {
        object: LOG,
        id: input.logId,
        values,
      }),
    );
  },
});

export const sessionComplete = defineTool({
  description:
    "Mark one of a person's sessions done or skipped (or back to planned). A member marks their " +
    "own; staff any personal session. A class type's sessions are not marked by members. Made " +
    "from the session's current state, so two marks at once count once. Returns the session.",
  input: z.object({
    sessionId: id,
    state: z.enum(["done", "skipped", "planned"]).default("done"),
  }),
  output: z.object({ changed: z.boolean(), session: sessionOut }),
  risk: "write",
  audiences: ["staff", "customer"],
  customerFields: { [SESSION]: ["state", "completedAt"] },
  async handler(input, ctx) {
    const current = sessionOf(await get(ctx, SESSION, input.sessionId));
    if (current.state === input.state) return { changed: false, session: current };
    const from = current.state ?? "planned";
    const marked =
      input.state === "planned" ? { completedAt: null } : { completedAt: new Date().toISOString() };
    const caller = ctx.caller?.kind === "staff" ? ctx.caller : null;
    try {
      const after = await ctx.ops.call<RecordShape>(
        isCustomer(ctx) ? "my.update" : "record.update",
        {
          object: SESSION,
          id: input.sessionId,
          from,
          values: {
            state: input.state,
            ...marked,
            ...(caller
              ? input.state === "planned"
                ? { completedBy: null, completedByName: null }
                : { completedBy: caller.userId, completedByName: caller.name }
              : {}),
          },
        },
      );
      return { changed: true, session: sessionOf(after) };
    } catch (error) {
      if (!(error instanceof OpsCallError) || error.code !== "conflict") throw error;
      // Marked by someone else meanwhile: report the session as it is now.
      return { changed: false, session: sessionOf(await get(ctx, SESSION, input.sessionId)) };
    }
  },
});

// --- History and progress ------------------------------------------------------------------------

const best = z.object({
  load: z.number().nullable().describe("Heaviest load in one set"),
  reps: z.number().nullable().describe("Most reps in one set"),
  seconds: z.number().nullable().describe("Longest time in one set"),
});

/** Bests over sets: the heaviest, the most reps, the longest. */
function bestOf(sets: RecordShape[]): z.infer<typeof best> {
  const max = (field: string) => {
    const values = sets.map((s) => num(s.values[field])).filter((n): n is number => n !== null);
    return values.length ? Math.max(...values) : null;
  };
  return { load: max("actualLoad"), reps: max("actualReps"), seconds: max("actualSeconds") };
}

export const history = defineTool({
  description:
    "Every set a person logged of one exercise, oldest first (date, set, level, target and " +
    "what was done, effort), and their bests at it (heaviest load, most reps, longest time). " +
    "A member reads their own; staff name the person. At most 2,000 sets; `capped` says when " +
    "there were more. Read-only.",
  input: z.object({
    exerciseId: id,
    personId: personInput,
    from: date.optional(),
    until: date.optional(),
  }),
  output: z.object({
    exercise: z.object({ id: z.string(), name: z.string().nullable() }),
    sets: z.array(loggedSet.extend({ date: z.string().nullable() })),
    best,
    capped: z.boolean(),
  }),
  risk: "read",
  audiences: ["staff", "customer"],
  async handler(input, ctx) {
    const person = personFilter(ctx, input.personId);
    const exercise = await get(ctx, EXERCISE, input.exerciseId);
    const sets = await all(
      ctx,
      LOG,
      and(
        { field: "exercise", op: "eq", value: input.exerciseId },
        person,
        input.from ? { field: "date", op: "gte", value: input.from } : null,
        input.until ? { field: "date", op: "lte", value: input.until } : null,
      ),
      { field: "date", direction: "asc" },
      SETS_READ_MAX,
    );
    return {
      exercise: { id: exercise.id, name: text(exercise.values.name) },
      sets: sets.items.map((s) => ({ ...loggedOf(s), date: text(s.values.date) })),
      best: bestOf(sets.items),
      capped: sets.capped,
    };
  },
});

export const progress = defineTool({
  description:
    "A person's training at a glance: for each exercise they logged, how many sets, the first " +
    "and last date, and their bests; and for each of their assignments, sessions planned, done " +
    "and skipped. Optionally only one assignment. A member reads their own; staff name the " +
    "person. Worked out over at most 2,000 sets (`capped`). Read-only.",
  input: z.object({ personId: personInput, assignmentId: id.optional() }),
  output: z.object({
    exercises: z.array(
      z.object({
        id: z.string(),
        name: z.string().nullable(),
        sets: z.number(),
        first: z.string().nullable(),
        last: z.string().nullable(),
        best,
      }),
    ),
    assignments: z.array(
      z.object({
        id: z.string(),
        title: z.string().nullable(),
        sessions: z.number(),
        done: z.number(),
        skipped: z.number(),
        planned: z.number(),
      }),
    ),
    capped: z.boolean(),
  }),
  risk: "read",
  audiences: ["staff", "customer"],
  async handler(input, ctx) {
    const person = personFilter(ctx, input.personId);
    const only = input.assignmentId
      ? { field: "assignment", op: "eq", value: input.assignmentId }
      : null;
    const sets = await all(
      ctx,
      LOG,
      and(person, only),
      { field: "date", direction: "asc" },
      SETS_READ_MAX,
    );
    const byExercise = new Map<string, RecordShape[]>();
    for (const set of sets.items) {
      const exercise = text(set.values.exercise);
      if (exercise) byExercise.set(exercise, [...(byExercise.get(exercise) ?? []), set]);
    }
    const ids = [...byExercise.keys()];
    const names = new Map<string, string | null>();
    for (let start = 0; start < ids.length; start += 200) {
      const page = await list(ctx, EXERCISE, {
        filter: { field: "id", op: "in", value: ids.slice(start, start + 200) },
        limit: 200,
      });
      for (const e of page.items) names.set(e.id, text(e.values.name));
    }
    const assignments = await all(
      ctx,
      ASSIGNMENT,
      and(
        person,
        { field: "kind", op: "eq", value: "personal" },
        input.assignmentId ? { field: "id", op: "eq", value: input.assignmentId } : null,
      ),
      { field: "startDate", direction: "asc" },
      100,
    );
    const summaries = [];
    for (const assignment of assignments.items) {
      const sessions = await all(
        ctx,
        SESSION,
        { field: "assignment", op: "eq", value: assignment.id },
        { field: "date", direction: "asc" },
        1000,
      );
      const count = (state: string) =>
        sessions.items.filter((s) => s.values.state === state).length;
      summaries.push({
        id: assignment.id,
        title: text(assignment.values.title),
        sessions: sessions.items.length,
        done: count("done"),
        skipped: count("skipped"),
        planned: count("planned"),
      });
    }
    return {
      exercises: ids.map((exerciseId) => {
        const mine = byExercise.get(exerciseId) ?? [];
        return {
          id: exerciseId,
          name: names.get(exerciseId) ?? null,
          sets: mine.length,
          first: text(mine[0]?.values.date),
          last: text(mine.at(-1)?.values.date),
          best: bestOf(mine),
        };
      }),
      assignments: summaries,
      capped: sets.capped,
    };
  },
});

// --- Drafting and importing (step 6) ---------------------------------------------------------------

/** The bank, as the authoring functions read it. */
async function bankOf(ctx: ExtensionContext): Promise<BankExercise[]> {
  const rows = await all(ctx, EXERCISE, undefined, { field: "name", direction: "asc" }, 2000);
  return rows.items.map((e) => ({
    id: e.id,
    name: text(e.values.name) ?? "",
    measure: text(e.values.measure),
    theme: text(e.values.theme),
    level: text(e.values.level),
  }));
}

const workingCopy = z.object({
  programId: z.string(),
  title: z.string(),
  weeks: z.number(),
  sessions: z.number(),
  published: z.literal(false).describe("Always false: a person publishes it"),
});

export const draft = defineTool({
  description:
    'Draft a program from a brief ("12 weeks of handstand strength, 3 sessions a week") as a ' +
    "working copy for a coach to edit: weeks of sessions of blocks of exercises taken only from " +
    "the bank, with default sets. The assistant reads the brief with the extract model role when " +
    "the deployment has AI, and the numbers and words in it otherwise. It never publishes: a " +
    "person with the publish permission does, after editing. Returns the new program.",
  input: z.object({
    brief: z.string().trim().min(3).max(2000),
    title: z.string().trim().min(1).max(200).optional(),
    kind: z.enum(["class", "client", "course"]).default("client"),
  }),
  output: workingCopy.extend({
    exercises: z.array(z.object({ id: z.string(), name: z.string() })),
  }),
  risk: "write",
  async handler(input, ctx) {
    const bank = await bankOf(ctx);
    if (!bank.length) {
      throw new OpsCallError("invalid_input", "The exercise bank is empty: add exercises first");
    }
    const floor = readBrief(input.brief);
    let plan: DraftPlan = floor;
    try {
      // A model role, never a model id: the deployment decides which model reads it.
      const read = await ctx.ai.extract(input.brief, {
        weeks: "How many weeks the program runs, a whole number",
        sessionsPerWeek: "How many sessions a week, a whole number from 1 to 7",
        focus: "The themes, body areas or moves it is about, as a comma-separated list",
      });
      const weeks = Number(read.weeks);
      const perWeek = Number(read.sessionsPerWeek);
      const focus = typeof read.focus === "string" ? read.focus.toLowerCase().split(/[,;]/) : [];
      plan = {
        weeks: Number.isInteger(weeks) && weeks >= 1 && weeks <= 52 ? weeks : floor.weeks,
        sessionsPerWeek:
          Number.isInteger(perWeek) && perWeek >= 1 && perWeek <= 7
            ? perWeek
            : floor.sessionsPerWeek,
        focus: [...new Set([...focus.map((f) => f.trim()).filter(Boolean), ...floor.focus])],
      };
    } catch {
      // No AI on this deployment, or it failed: the brief's own numbers and words.
    }
    const chosen = pickExercises(bank, plan.focus).slice(0, 12);
    const layout = draftLayout(plan, chosen);
    const title = input.title ?? `Draft: ${input.brief.slice(0, 60)}`;
    const created = await ctx.ops.call<RecordShape>("record.create", {
      object: PROGRAM,
      values: {
        title,
        kind: input.kind,
        guidance: `Drafted from the brief: ${input.brief}`.slice(0, 5000),
        layout,
      },
    });
    return {
      programId: created.id,
      title,
      weeks: layout.weeks.length,
      sessions: layout.weeks.reduce((n, w) => n + w.sessions.length, 0),
      published: false as const,
      exercises: chosen.map((e) => ({ id: e.id, name: e.name })),
    };
  },
});

/** JSON with every object's keys in order: the same content gives the same text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined && v !== null)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Two 53-bit string hashes (cyrb53) as hex: whether a program still holds what was written. */
function contentHash(text: string): string {
  const one = (seed: number) => {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < text.length; i += 1) {
      const c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
  };
  return `${one(1)}${one(2)}`;
}

/** What a text import writes of a program, as one hash: what it last wrote, kept beside it. */
function importedHashOf(values: Record<string, unknown>): string {
  return contentHash(
    canonical({
      title: values.title,
      kind: values.kind,
      guidance: values.guidance,
      layout: values.layout,
    }),
  );
}

export const importText = defineTool({
  description:
    "Turn pasted program shorthand, or a document's text, into a working copy with structured " +
    "targets: Title:, Kind:, Guidance:, Week:, Session: (a weekday names its day), Focus:, " +
    "Warm-up: with - lines, Block A: with its rounds, items A1: with an exercise (for everyone), " +
    'with level lines 1: to 5: ("+" done together, "|" alternatives), or with both, * notes for ' +
    "coaches and TV: notes shown to members. Exercises are matched to the bank by name. Every " +
    "line it could not read is listed with why, for the coach to fix; nothing is guessed. With " +
    "a key (the text's name in its source), running it again changes the same program: updated " +
    "while it still holds what the import last wrote, unchanged when the text is the same, and a " +
    "conflict, left alone, when someone has edited it since. dryRun reads and checks the text " +
    "and says what would happen, writing nothing. Never publishes. Returns the program and the " +
    "unread lines.",
  input: z.object({
    text: z.string().min(1).max(200_000),
    title: z.string().trim().min(1).max(200).optional(),
    kind: z
      .enum(["class", "client", "course"])
      .optional()
      .describe("Left out: what a Kind: line says, else class"),
    key: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("The text's import key (its file name in the source): one program per key"),
    dryRun: z.boolean().default(false).describe("Read and check only; write nothing"),
  }),
  output: workingCopy.extend({
    programId: z.string().nullable().describe("Null only for a dry run that would create one"),
    outcome: z.enum(["created", "updated", "unchanged", "conflict", "invalid"]),
    items: z.number(),
    unread: z.array(z.object({ line: z.number(), text: z.string(), reason: z.string() })),
    faults: z
      .array(z.object({ path: z.string(), message: z.string() }))
      .describe("Where the layout breaks the schema (a dry run's check; a write is refused)"),
  }),
  risk: "write",
  async handler(input, ctx) {
    const bank = await bankOf(ctx);
    const read = readProgramText(input.text, bank);
    const title = input.title ?? read.title ?? "Imported program";
    const values: Record<string, unknown> = {
      title,
      kind: input.kind ?? read.kind ?? "class",
      // Null when the text has none, so an update clears what an earlier text said.
      guidance: read.guidance,
      layout: read.layout,
    };
    const sessions = read.layout.weeks.flatMap((w) => w.sessions);
    const summary = {
      title,
      weeks: read.layout.weeks.length,
      sessions: sessions.length,
      items: sessions.reduce((n, s) => n + s.blocks.reduce((m, b) => m + b.items.length, 0), 0),
      published: false as const,
      unread: read.unread,
    };
    const checked = validateDocument(LAYOUT_SCHEMA, read.layout);
    const faults = checked.ok
      ? []
      : checked.issues.map((i) => ({ path: ["layout", ...i.path].join("."), message: i.message }));
    const hash = importedHashOf(values);
    const existing = input.key
      ? (
          await ctx.ops.call<ListShape>("record.list", {
            object: PROGRAM,
            filter: { field: "importKey", op: "eq", value: input.key },
            limit: 1,
          })
        ).items[0]
      : undefined;
    // Someone edited it since the import wrote it: never overwritten.
    const edited =
      existing !== undefined &&
      importedHashOf(existing.values) !== text(existing.values.importedHash);
    const outcome = existing
      ? edited
        ? "conflict"
        : hash === text(existing.values.importedHash)
          ? "unchanged"
          : "updated"
      : "created";
    const answer = (programId: string | null, said: typeof outcome | "invalid") => ({
      ...summary,
      programId,
      outcome: said,
      faults,
    });
    if (input.dryRun) return answer(existing?.id ?? null, faults.length ? "invalid" : outcome);
    if (existing && outcome !== "updated") return answer(existing.id, outcome);
    const imported = input.key ? { importKey: input.key, importedHash: hash } : {};
    if (existing) {
      await ctx.ops.call<RecordShape>("record.update", {
        object: PROGRAM,
        id: existing.id,
        values: { ...values, importedHash: hash },
      });
      return answer(existing.id, "updated");
    }
    const created = await ctx.ops.call<RecordShape>("record.create", {
      object: PROGRAM,
      values: { ...values, ...imported },
    });
    return answer(created.id, "created");
  },
});
