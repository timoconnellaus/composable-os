// Dummy data the Daily checklists previews share: one studio's checklists, on the preview's day
// and the fortnight before it.
import type { DailyChecksOperations } from "@composable-os/pack-dailychecks/client";
import { at, dayAfter, TIME_ZONE, TODAY } from "../../src/fake.ts";

type Out<K extends keyof DailyChecksOperations> = DailyChecksOperations[K]["output"];
type Item = Out<"x.dailychecks.today">["items"][number];
type Run = NonNullable<Item["run"]>;
type Step = Run["steps"][number];
type Tick = NonNullable<Step["tick"]>;

/** The viewer: a front-of-house staff member. */
const YOU = { id: "u_1", name: "Maya Patel" };
const PEOPLE: Record<string, string> = { u_1: "Maya Patel", u_2: "Jordan Lee", u_3: "Sam Rivera" };

const templates = {
  opening: {
    id: "tpl_open",
    name: "Opening checks",
    purpose: "Before the first class: the studio safe and ready.",
  },
  clean: {
    id: "tpl_clean",
    name: "Midday clean",
    purpose: "Between the morning and evening classes.",
  },
  closing: {
    id: "tpl_close",
    name: "Closing up",
    purpose: "After the last class, before the doors are locked.",
  },
};

function tick(by: string, time: string, extra: Partial<Tick> = {}): Tick {
  const name = PEOPLE[by] ?? by;
  return {
    id: `tk_${by}_${time}`,
    state: "done",
    done: true,
    why: null,
    note: null,
    onBehalfWhy: null,
    withheld: false,
    by,
    byName: name,
    for: by,
    forName: name,
    onBehalf: false,
    at: at(time),
    label: `Ticked by ${name}`,
    ...extra,
  };
}

function step(
  position: number,
  text: string,
  t: Tick | null = null,
  more: Partial<Step> = {},
): Step {
  return {
    position,
    text,
    required: true,
    asksNote: false,
    tick: t,
    history: [],
    historyTruncated: false,
    missed: false,
    ...more,
  };
}

function run(template: { id: string; name: string }, steps: Step[], more: Partial<Run> = {}): Run {
  return {
    id: `run_${template.id}`,
    object: "checklist.run",
    record: `rec_${template.id}`,
    template: { ...template, version: 3 },
    state: "open",
    account: null,
    name: null,
    opens: at("00:00"),
    closes: at("00:00", dayAfter(1)),
    tickUntil: at("00:00", dayAfter(1)),
    madeAt: at("06:50"),
    closedAt: null,
    closedBy: null,
    closedByName: null,
    closedWhy: null,
    steps,
    corrections: [],
    ...more,
  };
}

function item(
  template: { id: string; name: string; purpose: string | null },
  more: Partial<Item>,
): Item {
  return {
    template,
    date: TODAY,
    who: { kind: "role", value: "front_desk" },
    dueBy: null,
    dueAt: null,
    opens: at("00:00"),
    closes: at("00:00", dayAfter(1)),
    state: "not_started",
    late: false,
    run: null,
    preview: null,
    mayDo: true,
    canTick: true,
    ...more,
  };
}

const opening = item(templates.opening, {
  dueBy: "07:00",
  dueAt: at("07:00"),
  state: "done",
  canTick: false,
  run: run(
    templates.opening,
    [
      step(0, "Lights, music and air on", tick("u_2", "06:12")),
      step(1, "Check the fire exits are clear", tick("u_2", "06:13")),
      step(2, "First-aid kit stocked", tick("u_2", "06:15")),
      step(3, "Fill the water station", tick("u_2", "06:18"), { required: false }),
    ],
    { state: "done", closedAt: at("06:18"), closedBy: "u_2", closedByName: "Jordan Lee" },
  ),
});

const clean = item(templates.clean, {
  dueBy: "14:00",
  dueAt: at("14:00"),
  state: "open",
  run: run(templates.clean, [
    step(0, "Wipe down the bikes", tick("u_1", "09:05")),
    step(
      1,
      "Restock towels",
      tick("u_1", "09:12", {
        state: "not_done",
        done: false,
        why: "Laundry delivery is late, due at 11",
        label: "Ticked by Maya Patel",
      }),
    ),
    step(2, "Mop Studio 1"),
    step(3, "Empty the bins", null, { required: false }),
  ]),
});

const closing = item(templates.closing, {
  dueBy: "21:30",
  dueAt: at("21:30"),
  opens: at("17:00"),
  canTick: false,
  preview: [
    { text: "Lock the bike room", required: true, asksNote: false },
    { text: "Count the till", required: true, asksNote: true },
    { text: "Alarm set", required: true, asksNote: false },
  ],
});

export const today: Out<"x.dailychecks.today"> = {
  zone: TIME_ZONE,
  date: TODAY,
  items: [opening, clean, closing],
  you: YOU.id,
  youManage: false,
};

// --- How each day went, for someone who manages checklists ------------------------------------------

type HistoryDay = Out<"x.dailychecks.history">["days"][number];

function past(
  daysAgo: number,
  template: { id: string; name: string },
  more: Partial<HistoryDay> & { by?: string; time?: string },
): HistoryDay {
  const date = dayAfter(-daysAgo);
  const { by, time, ...rest } = more;
  return {
    run: `run_${template.id}_${date}`,
    template,
    date,
    state: "done",
    dueAt: null,
    late: false,
    finishedAt: time ? at(time, date) : null,
    finishedBy: by ?? null,
    finishedFor: null,
    steps: 4,
    ticked: 4,
    notDone: 0,
    onBehalf: 0,
    missed: [],
    ...rest,
  };
}

const t = {
  opening: { id: templates.opening.id, name: templates.opening.name },
  clean: { id: templates.clean.id, name: templates.clean.name },
  closing: { id: templates.closing.id, name: templates.closing.name },
};

export const history: Out<"x.dailychecks.history"> = {
  zone: TIME_ZONE,
  truncated: false,
  days: [
    past(0, t.clean, { state: "open", ticked: 2 }),
    past(0, t.opening, { by: "Jordan Lee", time: "06:18" }),
    past(1, t.closing, { by: "Sam Rivera", time: "21:24", steps: 3, ticked: 3 }),
    past(1, t.clean, { by: "Maya Patel", time: "13:40", notDone: 1 }),
    past(1, t.opening, { by: "Jordan Lee", time: "07:16", late: true }),
    past(2, t.closing, {
      state: "missed",
      steps: 3,
      ticked: 1,
      missed: ["Count the till", "Alarm set"],
    }),
    past(2, t.clean, { by: "Maya Patel", time: "12:55" }),
    past(2, t.opening, { by: "Maya Patel", finishedFor: "Jordan Lee", time: "06:40", onBehalf: 2 }),
  ],
};
