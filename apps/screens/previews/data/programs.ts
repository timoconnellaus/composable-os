// Dummy data the Programs previews share: one strength and gymnastics gym's bank, programs,
// sessions and logged sets, on the preview's Monday.
import type {
  ProgramsOperations,
  RecordOut,
  Session,
  SetTarget,
} from "@composable-os/pack-programs/client";
import { at, dayAfter, TODAY } from "../../src/fake.ts";

type Out<K extends keyof ProgramsOperations> = ProgramsOperations[K]["output"];
type In<K extends keyof ProgramsOperations> = ProgramsOperations[K]["input"];
type SessionOut = Out<"x.programs.sessionGet">["session"];
type ExerciseOut = Out<"x.programs.sessionGet">["exercises"][number];
type LoggedOut = Out<"x.programs.sessionGet">["logged"][number];
type LastSet = ExerciseOut["last"][number];

/** A plan as the host sends one: a session of the layout, as a plain record. */
const planOf = (s: Session): Record<string, unknown> => ({ ...s });

/** The member the previews show, and their coach. */
export const MEMBER = { id: "p_jordan", name: "Jordan Lee" };
export const COACH = "Sam Rivera";

// --- The bank -------------------------------------------------------------------------------------

interface BankEntry {
  id: string;
  name: string;
  measure: "weight_reps" | "reps" | "time" | "hold";
  theme: string;
  level: string;
  cues?: string;
  video?: string;
  easier?: string[];
  harder?: string[];
}

const BANK: BankEntry[] = [
  {
    id: "ex_squat",
    name: "Back squat",
    measure: "weight_reps",
    theme: "strength",
    level: "intermediate",
    cues: "Brace before you descend. Knees track over toes.",
    video: "https://video.example.com/back-squat",
    easier: ["ex_goblet"],
  },
  {
    id: "ex_goblet",
    name: "Goblet squat",
    measure: "weight_reps",
    theme: "strength",
    level: "beginner",
    harder: ["ex_squat"],
  },
  {
    id: "ex_rdl",
    name: "Romanian deadlift",
    measure: "weight_reps",
    theme: "strength",
    level: "intermediate",
    cues: "Soft knees, push the hips back, bar close to the legs.",
  },
  {
    id: "ex_lunge",
    name: "Walking lunge",
    measure: "weight_reps",
    theme: "strength",
    level: "beginner",
  },
  {
    id: "ex_swing",
    name: "Kettlebell swing",
    measure: "weight_reps",
    theme: "conditioning",
    level: "beginner",
  },
  {
    id: "ex_plank",
    name: "Plank",
    measure: "hold",
    theme: "strength",
    level: "beginner",
    harder: ["ex_hollow"],
  },
  {
    id: "ex_hollow",
    name: "Hollow body hold",
    measure: "hold",
    theme: "skill",
    level: "intermediate",
    cues: "Lower back pressed into the floor, arms by the ears.",
    easier: ["ex_plank"],
  },
  {
    id: "ex_wallplank",
    name: "Wall plank",
    measure: "hold",
    theme: "handstands",
    level: "beginner",
    harder: ["ex_ctw"],
  },
  {
    id: "ex_ctw",
    name: "Chest-to-wall handstand",
    measure: "hold",
    theme: "handstands",
    level: "intermediate",
    cues: "Push tall through the shoulders, ribs in.",
    video: "https://video.example.com/chest-to-wall",
    easier: ["ex_wallplank"],
    harder: ["ex_kickup"],
  },
  {
    id: "ex_kickup",
    name: "Freestanding kick-up",
    measure: "reps",
    theme: "handstands",
    level: "advanced",
    easier: ["ex_ctw"],
  },
  {
    id: "ex_heelpull",
    name: "Heel pulls off the wall",
    measure: "reps",
    theme: "handstands",
    level: "advanced",
  },
  {
    id: "ex_pike",
    name: "Pike push-up",
    measure: "reps",
    theme: "handstands",
    level: "beginner",
    harder: ["ex_elevpike"],
  },
  {
    id: "ex_elevpike",
    name: "Elevated pike push-up",
    measure: "reps",
    theme: "handstands",
    level: "intermediate",
    easier: ["ex_pike"],
  },
  {
    id: "ex_pullup",
    name: "Pull-up",
    measure: "reps",
    theme: "strength",
    level: "intermediate",
    easier: ["ex_bandpull"],
  },
  {
    id: "ex_bandpull",
    name: "Band-assisted pull-up",
    measure: "reps",
    theme: "strength",
    level: "beginner",
    harder: ["ex_pullup"],
  },
  { id: "ex_row", name: "Rower sprint", measure: "time", theme: "conditioning", level: "beginner" },
  { id: "ex_hip", name: "90/90 hip switch", measure: "reps", theme: "mobility", level: "beginner" },
];

const byId = new Map(BANK.map((e) => [e.id, e]));
const nameOf = (id: string) => byId.get(id)?.name ?? id;

const exerciseRecord = (e: BankEntry): RecordOut => ({
  object: "programs.exercise",
  id: e.id,
  title: e.name,
  values: {
    name: e.name,
    measure: e.measure,
    theme: e.theme,
    level: e.level,
    video: e.video ?? null,
    cues: e.cues ?? null,
    easier: e.easier ?? null,
    harder: e.harder ?? null,
  },
});

const sortedBank = [...BANK].sort((a, b) => a.name.localeCompare(b.name));

/** The bank as `record.list` of exercises answers it: searched by name, or by ids. */
export function bankPage(input: In<"record.list">): Out<"record.list"> {
  const filter = input.filter as { field?: string; op?: string; value?: unknown } | undefined;
  let list = sortedBank;
  if (filter?.field === "name" && typeof filter.value === "string") {
    const words = filter.value.toLowerCase();
    list = list.filter((e) => e.name.toLowerCase().includes(words));
  } else if (filter?.field === "id" && Array.isArray(filter.value)) {
    const ids = new Set(filter.value);
    list = list.filter((e) => ids.has(e.id));
  }
  return { items: list.map(exerciseRecord), nextCursor: null };
}

// --- Sets -----------------------------------------------------------------------------------------

const reps = (n: number, load?: number, rest?: number, repsMax?: number): SetTarget => ({
  kind: "reps",
  reps: n,
  ...(repsMax ? { repsMax } : {}),
  ...(load !== undefined ? { load } : {}),
  ...(rest ? { rest } : {}),
});
const hold = (seconds: number, rest?: number): SetTarget => ({
  kind: "hold",
  seconds,
  ...(rest ? { rest } : {}),
});
const time = (seconds: number, rest?: number): SetTarget => ({
  kind: "time",
  seconds,
  ...(rest ? { rest } : {}),
});
const times = (n: number, set: SetTarget): SetTarget[] => Array.from({ length: n }, () => set);

// --- Plans ----------------------------------------------------------------------------------------

export const lowerBodyA: Session = {
  name: "Lower body A",
  focus: "Heavy squats, then posterior chain",
  day: 1,
  warmup: { text: "5 minutes easy on the rower, then leg swings and 90/90 hip switches." },
  blocks: [
    {
      label: "A",
      items: [
        {
          kind: "all",
          label: "A1",
          exercises: [
            {
              exercise: "ex_squat",
              sets: times(4, reps(5, 82.5, 150)),
              note: "Same weight as last week if the bar slowed on set 4.",
            },
          ],
        },
      ],
    },
    {
      label: "B",
      items: [
        {
          kind: "all",
          label: "B1",
          exercises: [{ exercise: "ex_rdl", sets: times(3, reps(8, 60, 90)) }],
        },
        {
          kind: "all",
          label: "B2",
          exercises: [{ exercise: "ex_lunge", sets: times(3, reps(10, 16, 60)) }],
        },
      ],
    },
    {
      label: "C",
      rounds: 3,
      notes: [
        {
          text: "Move straight from one to the other, rest at the end of the round.",
          members: true,
        },
      ],
      items: [
        {
          kind: "all",
          label: "C1",
          exercises: [{ exercise: "ex_swing", sets: times(3, reps(15, 24)) }],
        },
        {
          kind: "all",
          label: "C2",
          exercises: [{ exercise: "ex_plank", sets: times(3, hold(45, 60)) }],
        },
      ],
    },
  ],
};

export const upperBodyA: Session = {
  name: "Upper body A",
  focus: "Pulling strength and pressing",
  day: 3,
  blocks: [
    {
      label: "A",
      items: [
        {
          kind: "levels",
          label: "A1",
          levels: [
            {
              mode: "one",
              level: 1,
              exercise: { exercise: "ex_bandpull", sets: times(4, reps(8, undefined, 120)) },
            },
            {
              mode: "one",
              level: 2,
              exercise: { exercise: "ex_pullup", sets: times(4, reps(5, undefined, 120)) },
            },
          ],
        },
      ],
    },
    {
      label: "B",
      items: [
        {
          kind: "all",
          label: "B1",
          exercises: [{ exercise: "ex_pike", sets: times(3, reps(8, undefined, 90, 10)) }],
        },
        {
          kind: "all",
          label: "B2",
          exercises: [{ exercise: "ex_hollow", sets: times(3, hold(30, 60)) }],
        },
      ],
    },
  ],
};

export const conditioning: Session = {
  name: "Conditioning",
  focus: "Short intervals",
  day: 5,
  blocks: [
    {
      label: "A",
      rounds: 6,
      items: [
        {
          kind: "all",
          label: "A1",
          exercises: [{ exercise: "ex_row", sets: times(6, time(30, 90)) }],
        },
      ],
    },
    {
      label: "B",
      items: [
        {
          kind: "all",
          label: "B1",
          exercises: [{ exercise: "ex_swing", sets: times(3, reps(20, 20)) }],
        },
      ],
    },
  ],
};

export const handstandClass: Session = {
  name: "Handstand Foundations",
  focus: "Line and shoulder push, week 2 of 6",
  day: 1,
  warmup: { text: "Wrist circles, cat-cow, 2 × 30 s shoulder taps in plank." },
  notes: [
    {
      text: "Film one hold from the side if you can: we look at the line next week.",
      members: true,
    },
  ],
  blocks: [
    {
      label: "A",
      items: [
        {
          kind: "levels",
          label: "A1",
          levels: [
            {
              mode: "one",
              level: 1,
              exercise: { exercise: "ex_wallplank", sets: times(3, hold(30, 60)) },
            },
            {
              mode: "one",
              level: 2,
              exercise: {
                exercise: "ex_ctw",
                sets: times(3, hold(40, 75)),
                note: "Hands a palm's width from the wall.",
              },
            },
            {
              mode: "alternatives",
              level: 3,
              exercises: [
                { exercise: "ex_kickup", sets: times(3, reps(5, undefined, 60)) },
                { exercise: "ex_heelpull", sets: times(3, reps(5, undefined, 60)) },
              ],
            },
          ],
        },
      ],
    },
    {
      label: "B",
      rounds: 3,
      items: [
        {
          kind: "all",
          label: "B1",
          exercises: [{ exercise: "ex_hollow", sets: times(3, hold(20, 30)) }],
        },
        {
          kind: "levels",
          label: "B2",
          levels: [
            { mode: "one", level: 1, exercise: { exercise: "ex_pike", sets: times(3, reps(8)) } },
            {
              mode: "one",
              level: 2,
              exercise: { exercise: "ex_elevpike", sets: times(3, reps(6)) },
            },
          ],
        },
      ],
    },
  ],
};

// --- Sessions -------------------------------------------------------------------------------------

const STRENGTH = "Strength Base · 8 weeks";

function session(s: Partial<SessionOut> & Pick<SessionOut, "id" | "name">): SessionOut {
  return {
    date: TODAY,
    week: 3,
    day: 1,
    kind: "personal",
    classType: null,
    assignment: "as_strength",
    programVersion: 2,
    programTitle: STRENGTH,
    classTypeName: null,
    focus: null,
    state: "planned",
    plan: null,
    ...s,
  };
}

const last = (date: string, list: [number | null, number | null, number | null][]): LastSet[] =>
  list.map(([r, seconds, load]) => ({ date, reps: r, seconds, load, rpe: null, level: null }));

const LAST: Record<string, LastSet[]> = {
  ex_squat: last(dayAfter(-7), [
    [5, null, 80],
    [5, null, 80],
    [5, null, 80],
    [4, null, 80],
  ]),
  ex_rdl: last(dayAfter(-7), [
    [8, null, 57.5],
    [8, null, 57.5],
    [8, null, 57.5],
  ]),
  ex_lunge: last(dayAfter(-7), [
    [10, null, 14],
    [10, null, 14],
    [10, null, 14],
  ]),
  ex_swing: last(dayAfter(-3), [
    [20, null, 20],
    [20, null, 20],
    [18, null, 20],
  ]),
  ex_plank: last(dayAfter(-7), [
    [null, 45, null],
    [null, 45, null],
    [null, 40, null],
  ]),
  ex_ctw: last(dayAfter(-7), [
    [null, 30, null],
    [null, 35, null],
    [null, 30, null],
  ]),
  ex_hollow: last(dayAfter(-5), [
    [null, 20, null],
    [null, 20, null],
    [null, 15, null],
  ]),
  ex_pike: last(dayAfter(-7), [
    [8, null, null],
    [8, null, null],
    [7, null, null],
  ]),
};

function exercisesOf(plan: Session): ExerciseOut[] {
  const ids = new Set<string>();
  for (const block of plan.blocks)
    for (const item of block.items) {
      for (const p of item.exercises ?? []) ids.add(p.exercise);
      if (item.kind === "levels")
        for (const l of item.levels)
          for (const p of l.mode === "one" ? [l.exercise] : l.exercises) ids.add(p.exercise);
    }
  return [...ids].map((id) => {
    const e = byId.get(id);
    return {
      id,
      name: e?.name ?? null,
      video: e?.video ?? null,
      cues: e?.cues ?? null,
      measure: e?.measure ?? null,
      last: LAST[id] ?? [],
    };
  });
}

let logCount = 0;
/** A logged set: [item, exercise, set number, reps, seconds, load, rpe, level]. */
function logged(
  item: string,
  exercise: string,
  setNumber: number,
  done: {
    reps?: number;
    seconds?: number;
    load?: number;
    rpe?: number;
    level?: number;
    note?: string;
  },
  target: { reps?: number; seconds?: number; load?: number } = {},
  by?: string,
): LoggedOut {
  logCount += 1;
  return {
    id: `log_${logCount}`,
    item,
    exercise,
    setNumber,
    level: done.level ?? null,
    target: {
      reps: target.reps ?? null,
      seconds: target.seconds ?? null,
      load: target.load ?? null,
    },
    actual: { reps: done.reps ?? null, seconds: done.seconds ?? null, load: done.load ?? null },
    rpe: done.rpe ?? null,
    note: done.note ?? null,
    recordedAs: by ? "staff" : "member",
    recordedByName: by ?? MEMBER.name,
    exerciseName: nameOf(exercise),
  };
}

/** Today's session, half done: the squats folded, the deadlifts started. */
export const lowerToday = session({
  id: "ses_lower_w3",
  name: "Lower body A",
  focus: lowerBodyA.focus ?? null,
  plan: planOf(lowerBodyA),
});
const lowerTodayLogged: LoggedOut[] = [
  logged("A1", "ex_squat", 1, { reps: 5, load: 82.5, rpe: 7 }, { reps: 5, load: 82.5 }),
  logged("A1", "ex_squat", 2, { reps: 5, load: 82.5, rpe: 7 }, { reps: 5, load: 82.5 }),
  logged("A1", "ex_squat", 3, { reps: 5, load: 82.5, rpe: 8 }, { reps: 5, load: 82.5 }),
  logged("A1", "ex_squat", 4, { reps: 5, load: 82.5, rpe: 9 }, { reps: 5, load: 82.5 }),
  logged("B1", "ex_rdl", 1, { reps: 8, load: 60, rpe: 7 }, { reps: 8, load: 60 }),
];

export const mobilityToday = session({
  id: "ses_mobility",
  name: "Morning mobility",
  programTitle: "Hips and Shoulders",
  assignment: "as_mobility",
  state: "done",
  plan: planOf({
    name: "Morning mobility",
    day: 1,
    blocks: [
      {
        label: "A",
        items: [
          {
            kind: "all",
            label: "A1",
            exercises: [{ exercise: "ex_hip", sets: times(2, reps(10)) }],
          },
        ],
      },
    ],
  }),
});

export const today: Out<"x.programs.today"> = {
  date: TODAY,
  sessions: [
    { ...mobilityToday, exercises: exercisesOf(mobilityToday.plan as unknown as Session) },
    { ...lowerToday, exercises: exercisesOf(lowerBodyA) },
  ],
};

/** The class's session today, as a member reads it, with their first two holds at level 2. */
export const handstandToday = session({
  id: "ses_hs_w2",
  name: "Handstand Foundations",
  kind: "class",
  classType: "ct_handstands",
  classTypeName: "Handstands",
  assignment: "as_hs_class",
  programTitle: "Handstands Term 1",
  week: 2,
  focus: handstandClass.focus ?? null,
  plan: planOf(handstandClass),
});
const handstandLogged: LoggedOut[] = [
  logged("A1", "ex_ctw", 1, { seconds: 40, level: 2, rpe: 7 }, { seconds: 40 }),
  logged("A1", "ex_ctw", 2, { seconds: 35, level: 2, rpe: 8 }, { seconds: 40 }),
];

export const classTypes: Out<"my.list"> = {
  items: [
    {
      object: "bookings.classtype",
      id: "ct_handstands",
      title: "Handstands",
      values: { name: "Handstands", order: 1 },
    },
    {
      object: "bookings.classtype",
      id: "ct_mobility",
      title: "Mobility",
      values: { name: "Mobility", order: 2 },
    },
    {
      object: "bookings.classtype",
      id: "ct_rings",
      title: "Strength and Rings",
      values: { name: "Strength and Rings", order: 3 },
    },
    {
      object: "bookings.classtype",
      id: "ct_open",
      title: "Open Gym",
      values: { name: "Open Gym", order: 4 },
    },
  ],
  nextCursor: null,
};

export const classToday: Out<"x.programs.classToday"> = {
  date: TODAY,
  sessions: [{ ...handstandToday, exercises: exercisesOf(handstandClass) }],
};

// --- Past sessions --------------------------------------------------------------------------------

interface Past {
  session: SessionOut;
  plan: Session;
  logged: LoggedOut[];
}

const pastLogs = (
  plan: Session,
  opts: { skip?: number; level?: Record<string, number>; by?: string; tired?: boolean } = {},
): LoggedOut[] => {
  const out: LoggedOut[] = [];
  let n = 0;
  for (const block of plan.blocks)
    for (const item of block.items) {
      const level = opts.level?.[item.label];
      const chosen =
        item.kind === "levels"
          ? item.levels.find((l) => l.level === (level ?? item.levels[0]?.level))
          : null;
      const list =
        item.kind === "all"
          ? item.exercises
          : chosen
            ? chosen.mode === "one"
              ? [chosen.exercise]
              : chosen.exercises.slice(0, 1)
            : [];
      for (const p of list)
        p.sets.forEach((set, i) => {
          n += 1;
          if (opts.skip && n > opts.skip) return;
          const tired = opts.tired && i === p.sets.length - 1;
          const load = set.load;
          if (set.kind === "reps") {
            out.push(
              logged(
                item.label,
                p.exercise,
                i + 1,
                {
                  reps: tired ? set.reps - 1 : set.reps,
                  ...(load !== undefined ? { load } : {}),
                  ...(chosen ? { level: chosen.level } : {}),
                  rpe: tired ? 9 : 7 + (i % 2),
                },
                { reps: set.reps, ...(load !== undefined ? { load } : {}) },
                opts.by,
              ),
            );
          } else {
            out.push(
              logged(
                item.label,
                p.exercise,
                i + 1,
                {
                  seconds: tired ? set.seconds - 5 : set.seconds,
                  ...(chosen ? { level: chosen.level } : {}),
                },
                { seconds: set.seconds },
                opts.by,
              ),
            );
          }
        });
    }
  return out;
};

const lowerWeek2: Session = {
  ...lowerBodyA,
  blocks: lowerBodyA.blocks.map((b) =>
    b.label === "A"
      ? {
          ...b,
          items: [
            {
              kind: "all",
              label: "A1",
              exercises: [{ exercise: "ex_squat", sets: times(4, reps(5, 80, 150)) }],
            },
          ],
        }
      : b,
  ),
};

const PAST: Past[] = [
  {
    session: session({
      id: "ses_cond_w2",
      name: "Conditioning",
      date: dayAfter(-3),
      week: 2,
      day: 5,
      state: "done",
      focus: conditioning.focus ?? null,
      plan: planOf(conditioning),
    }),
    plan: conditioning,
    logged: pastLogs(conditioning, { tired: true }),
  },
  {
    session: session({
      id: "ses_upper_w2",
      name: "Upper body A",
      date: dayAfter(-5),
      week: 2,
      day: 3,
      state: "done",
      focus: upperBodyA.focus ?? null,
      plan: planOf(upperBodyA),
    }),
    plan: upperBodyA,
    logged: pastLogs(upperBodyA, { level: { A1: 2 }, tired: true }),
  },
  {
    session: session({
      id: "ses_lower_w2",
      name: "Lower body A",
      date: dayAfter(-7),
      week: 2,
      day: 1,
      state: "done",
      focus: lowerBodyA.focus ?? null,
      plan: planOf(lowerWeek2),
    }),
    plan: lowerWeek2,
    logged: pastLogs(lowerWeek2, { tired: true, by: COACH }),
  },
  {
    session: session({
      id: "ses_cond_w1",
      name: "Conditioning",
      date: dayAfter(-10),
      week: 1,
      day: 5,
      state: "skipped",
      focus: conditioning.focus ?? null,
      plan: planOf(conditioning),
    }),
    plan: conditioning,
    logged: [],
  },
  {
    session: session({
      id: "ses_upper_w1",
      name: "Upper body A",
      date: dayAfter(-12),
      week: 1,
      day: 3,
      state: "done",
      focus: upperBodyA.focus ?? null,
      plan: planOf(upperBodyA),
    }),
    plan: upperBodyA,
    logged: pastLogs(upperBodyA, { skip: 9 }),
  },
  {
    session: session({
      id: "ses_lower_w1",
      name: "Lower body A",
      date: dayAfter(-14),
      week: 1,
      day: 1,
      state: "done",
      focus: lowerBodyA.focus ?? null,
      plan: planOf(lowerWeek2),
    }),
    plan: lowerWeek2,
    logged: pastLogs(lowerWeek2),
  },
];

const sessionRecord = (s: SessionOut): RecordOut => ({
  object: "programs.session",
  id: s.id,
  title: s.name,
  values: { ...s, person: MEMBER.id },
});

const logRecord = (sessionId: string, date: string | null, l: LoggedOut): RecordOut => ({
  object: "programs.log",
  id: l.id,
  values: {
    session: sessionId,
    date,
    item: l.item,
    exercise: l.exercise,
    level: l.level,
    setNumber: l.setNumber,
  },
});

const pastPage: Out<"my.list"> = {
  items: PAST.map((p) => sessionRecord(p.session)),
  nextCursor: "older_1",
};
const pastSets: Out<"my.list"> = {
  items: PAST.flatMap((p) => p.logged.map((l) => logRecord(p.session.id, p.session.date, l))),
  nextCursor: null,
};

/** A list read of sessions or sets, as a member (`my.list`) or a coach (`record.list`) makes it. */
export function listRead(input: In<"my.list">): Out<"my.list"> {
  if (input.object === "programs.log") return pastSets;
  if (input.object === "bookings.classtype") return classTypes;
  if (input.object === "programs.exercise") return bankPage(input);
  if (input.object === "programs.program") return programList;
  if (input.object === "programs.session") {
    // The coach's client view (newest first, today's included); the history's past page.
    const filter = JSON.stringify(input.filter ?? {});
    if (filter.includes('"lte"')) return pastPage;
    return { items: [sessionRecord(lowerToday), ...pastPage.items], nextCursor: null };
  }
  return { items: [], nextCursor: null };
}

/** One session read, today's or a past one. */
export function sessionGet(input: In<"x.programs.sessionGet">): Out<"x.programs.sessionGet"> {
  if (input.sessionId === handstandToday.id)
    return {
      session: handstandToday,
      exercises: exercisesOf(handstandClass),
      logged: handstandLogged,
    };
  if (input.sessionId === mobilityToday.id)
    return {
      session: mobilityToday,
      exercises: exercisesOf(mobilityToday.plan as unknown as Session),
      logged: [],
    };
  const past = PAST.find((p) => p.session.id === input.sessionId);
  if (past)
    return { session: past.session, exercises: exercisesOf(past.plan), logged: past.logged };
  return { session: lowerToday, exercises: exercisesOf(lowerBodyA), logged: lowerTodayLogged };
}

// --- Progress and history -------------------------------------------------------------------------

export const progress: Out<"x.programs.progress"> = {
  exercises: [
    {
      id: "ex_squat",
      name: "Back squat",
      sets: 16,
      first: dayAfter(-14),
      last: TODAY,
      best: { load: 82.5, reps: 5, seconds: null },
    },
    {
      id: "ex_rdl",
      name: "Romanian deadlift",
      sets: 7,
      first: dayAfter(-14),
      last: TODAY,
      best: { load: 60, reps: 8, seconds: null },
    },
    {
      id: "ex_pullup",
      name: "Pull-up",
      sets: 8,
      first: dayAfter(-12),
      last: dayAfter(-5),
      best: { load: null, reps: 6, seconds: null },
    },
    {
      id: "ex_pike",
      name: "Pike push-up",
      sets: 6,
      first: dayAfter(-12),
      last: dayAfter(-5),
      best: { load: null, reps: 10, seconds: null },
    },
    {
      id: "ex_hollow",
      name: "Hollow body hold",
      sets: 6,
      first: dayAfter(-12),
      last: dayAfter(-5),
      best: { load: null, reps: null, seconds: 30 },
    },
    {
      id: "ex_row",
      name: "Rower sprint",
      sets: 6,
      first: dayAfter(-3),
      last: dayAfter(-3),
      best: { load: null, reps: null, seconds: 30 },
    },
    {
      id: "ex_swing",
      name: "Kettlebell swing",
      sets: 9,
      first: dayAfter(-14),
      last: dayAfter(-3),
      best: { load: 24, reps: 20, seconds: null },
    },
  ],
  assignments: [
    { id: "as_strength", title: STRENGTH, sessions: 24, done: 5, skipped: 1, planned: 18 },
    {
      id: "as_mobility",
      title: "Hips and Shoulders",
      sessions: 12,
      done: 7,
      skipped: 0,
      planned: 5,
    },
  ],
  capped: false,
};

const squatSets = (date: string, load: number, list: [number, number][]) =>
  list.map(([r, rpe], i) => ({
    ...logged("A1", "ex_squat", i + 1, { reps: r, load, rpe }, { reps: 5, load }),
    date,
  }));

export const squatHistory: Out<"x.programs.history"> = {
  exercise: { id: "ex_squat", name: "Back squat" },
  sets: [
    ...squatSets(dayAfter(-14), 77.5, [
      [5, 6],
      [5, 7],
      [5, 7],
      [5, 8],
    ]),
    ...squatSets(dayAfter(-7), 80, [
      [5, 7],
      [5, 7],
      [5, 8],
      [4, 9],
    ]),
    ...squatSets(TODAY, 82.5, [
      [5, 7],
      [5, 7],
      [5, 8],
      [5, 9],
    ]),
  ],
  best: { load: 82.5, reps: 5, seconds: null },
  capped: false,
};

/** History of any exercise: the squat's in full, others from their bests. */
export function historyOf(input: In<"x.programs.history">): Out<"x.programs.history"> {
  if (input.exerciseId === "ex_squat") return squatHistory;
  return {
    exercise: { id: input.exerciseId, name: nameOf(input.exerciseId) },
    sets: [],
    best: { load: null, reps: null, seconds: null },
    capped: false,
  };
}

// --- The builder ----------------------------------------------------------------------------------

export const PROGRAM_ID = "prg_hs";

/** The week the builder opens on: one class session, short enough to read in one picture. */
const builderSession: Session = {
  name: "Handstand Foundations",
  focus: "Line and shoulder push",
  day: 1,
  blocks: [
    {
      label: "A",
      items: [
        {
          kind: "levels",
          label: "A1",
          levels: [
            {
              mode: "one",
              level: 1,
              exercise: { exercise: "ex_wallplank", sets: times(3, hold(30, 60)) },
            },
            {
              mode: "one",
              level: 2,
              exercise: {
                exercise: "ex_ctw",
                sets: times(3, hold(40, 75)),
                note: "Hands a palm's width from the wall.",
              },
            },
          ],
        },
      ],
    },
    {
      label: "B",
      rounds: 3,
      items: [
        {
          kind: "all",
          label: "B1",
          exercises: [{ exercise: "ex_hollow", sets: times(3, hold(20, 30)) }],
        },
      ],
    },
  ],
};

export const handstandProgram: Out<"record.get"> = {
  object: "programs.program",
  id: PROGRAM_ID,
  title: "Handstands Term 1",
  values: {
    title: "Handstands Term 1",
    kind: "class",
    guidance: "Six weeks. Members choose the level they take at each item.",
    publishedVersion: 2,
    layout: {
      weeks: [
        { label: "Week 1: line", sessions: [builderSession] },
        { label: "Week 2", sessions: [handstandClass] },
        { label: "Week 3", sessions: [handstandClass] },
        { label: "Week 4: test", sessions: [handstandClass] },
      ],
    },
  },
};

export const programList: Out<"record.list"> = {
  items: [
    {
      object: "programs.program",
      id: "prg_strength",
      title: "Strength Base",
      values: { title: "Strength Base", publishedVersion: 2 },
    },
    {
      object: "programs.program",
      id: PROGRAM_ID,
      title: "Handstands Term 1",
      values: { title: "Handstands Term 1", publishedVersion: 4 },
    },
    {
      object: "programs.program",
      id: "prg_hips",
      title: "Hips and Shoulders",
      values: { title: "Hips and Shoulders", publishedVersion: 1 },
    },
    {
      object: "programs.program",
      id: "prg_rings",
      title: "Rings Strength (draft)",
      values: { title: "Rings Strength (draft)", publishedVersion: null },
    },
  ],
  nextCursor: null,
};

export const versions: Out<"record.versions"> = {
  items: [
    {
      version: 2,
      current: true,
      publishedAt: at("17:40", dayAfter(-16)),
      publishedBy: COACH,
      note: "Level 3 kick-ups from week 2",
      bytes: 18_400,
    },
    {
      version: 1,
      current: false,
      publishedAt: at("10:05", dayAfter(-30)),
      publishedBy: COACH,
      note: "First version",
      bytes: 17_900,
    },
  ],
};

export const coachMe: Out<"user.me"> = {
  id: "u_sam",
  name: COACH,
  role: "coach",
  granted: ["programs:coach"],
  permissions: ["records:read", "records:write", "records:publish", "programs:coach"],
};
