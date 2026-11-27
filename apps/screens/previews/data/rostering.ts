// Dummy data the Rostering previews share: a small gym's team and its week (Monday 2 March 2026),
// with time off, offers, checklists and pay periods. Sam Rivera reads it: a coach who also
// rosters and handles pay, so the rosterers' screens show too.
import type { RosteringOperations } from "@composable-os/pack-rostering/client";
import { type Answers, at, dayAfter, TIME_ZONE, TODAY } from "../../src/fake.ts";

type Out<K extends keyof RosteringOperations> = RosteringOperations[K]["output"];
type Shift = Out<"x.rostering.week">["shifts"][number];
type Warning = NonNullable<Shift["warnings"]>[number];
type Run = NonNullable<Out<"x.rostering.checklist">["run"]>;
type Tick = NonNullable<Run["steps"][number]["tick"]>;

const CLASS = "bookings.class";
const DUTY = "rostering.dutyshift";

// --- The team ---------------------------------------------------------------------------------------

export const team = [
  { account: "acc_sam", name: "Sam Rivera" },
  { account: "acc_alex", name: "Alex Chen" },
  { account: "acc_priya", name: "Priya Shah" },
  { account: "acc_jordan", name: "Jordan Lee" },
  { account: "acc_maya", name: "Maya Patel" },
  { account: "acc_chris", name: "Chris Okafor" },
  { account: "acc_ella", name: "Ella Novak" },
] as const;
type Account = (typeof team)[number]["account"];
const nameOf = (account: Account) => team.find((p) => p.account === account)?.name ?? "";

const kinds = {
  hiit: { object: "bookings.classtype", id: "ct_hiit", name: "HIIT", objectLabel: "Class type" },
  spin: { object: "bookings.classtype", id: "ct_spin", name: "Spin", objectLabel: "Class type" },
  yoga: { object: "bookings.classtype", id: "ct_yoga", name: "Yoga", objectLabel: "Class type" },
  strength: {
    object: "bookings.classtype",
    id: "ct_strength",
    name: "Strength",
    objectLabel: "Class type",
  },
  open: { object: "rostering.duty", id: "dt_open", name: "Open-up", objectLabel: "Duty" },
  desk: { object: "rostering.duty", id: "dt_desk", name: "Front desk", objectLabel: "Duty" },
  close: { object: "rostering.duty", id: "dt_close", name: "Close-down", objectLabel: "Duty" },
} as const;
type KindKey = keyof typeof kinds;
const kindRef = (k: KindKey) => ({ object: kinds[k].object, id: kinds[k].id, name: kinds[k].name });

export const me: Out<"x.rostering.me"> = {
  account: "acc_sam",
  name: "Sam Rivera",
  rosters: true,
  pays: true,
  zone: TIME_ZONE,
  today: TODAY,
  cutoffMinutes: 120,
  uncoveredDays: 14,
};

export const people: Out<"x.rostering.people"> = {
  people: team.map((p) => ({ ...p })),
  kinds: Object.values(kinds).map((k) => ({ ...k })),
  truncated: false,
};

// --- The week ---------------------------------------------------------------------------------------

function warning(code: Warning["code"], id: string, account: Account | null, message: string) {
  return { code, object: CLASS, id, account, message };
}

let n = 0;
function shift(
  day: number,
  start: string,
  end: string,
  title: string,
  kind: KindKey,
  place: string,
  who: Account | null | { visiting: string },
  extra: Partial<Shift> = {},
): Shift {
  n += 1;
  const date = dayAfter(day);
  const id = `sh_${n}`;
  const duty = kinds[kind].object === "rostering.duty";
  const visiting = who !== null && typeof who === "object";
  const account = who === null || visiting ? null : who;
  return {
    object: duty ? DUTY : CLASS,
    id,
    title,
    kind: kindRef(kind),
    startsAt: at(start, date),
    endsAt: at(end, date),
    zone: TIME_ZONE,
    place,
    uncovered: who === null,
    noAccount: visiting,
    account,
    name: visiting ? who.visiting : account ? nameOf(account) : null,
    mine: account === "acc_sam",
    offer: null,
    warnings: who === null ? [warning("uncovered", id, null, `Nobody is on ${title}.`)] : [],
    checklist: null,
    ...extra,
    // A warning is about this shift: its id is the shift's.
    ...(extra.warnings ? { warnings: extra.warnings.map((w) => ({ ...w, id })) } : {}),
  };
}

export const shifts: Shift[] = [
  // Monday (today)
  shift(0, "05:45", "06:30", "Open-up", "open", "Main floor", "acc_jordan", {
    checklist: { name: "Opening checks", state: "done" },
  }),
  shift(0, "06:30", "07:15", "Morning HIIT", "hiit", "Studio 1", "acc_sam"),
  shift(0, "09:00", "13:00", "Front desk", "desk", "Reception", "acc_sam", {
    checklist: { name: "Front desk", state: "in_progress" },
  }),
  shift(0, "12:15", "13:00", "Lunchtime Yoga", "yoga", "Studio 2", "acc_priya"),
  shift(0, "18:00", "18:45", "Evening Spin", "spin", "Bike room", "acc_alex"),
  shift(0, "21:00", "21:45", "Close-down", "close", "Main floor", "acc_chris", {
    checklist: { name: "Closing checks", state: "not_started" },
  }),
  // Tuesday
  shift(1, "06:30", "07:15", "Morning HIIT", "hiit", "Studio 1", "acc_alex"),
  shift(1, "09:00", "13:00", "Front desk", "desk", "Reception", "acc_ella"),
  shift(1, "12:15", "13:00", "Strength Foundations", "strength", "Weights room", "acc_sam"),
  shift(1, "17:00", "21:00", "Front desk", "desk", "Reception", "acc_chris"),
  shift(1, "18:00", "18:45", "Evening Spin", "spin", "Bike room", null),
  shift(1, "21:00", "21:45", "Close-down", "close", "Main floor", "acc_chris", {
    checklist: { name: "Closing checks", state: null },
  }),
  // Wednesday
  shift(2, "05:45", "06:30", "Open-up", "open", "Main floor", "acc_jordan", {
    checklist: { name: "Opening checks", state: null },
  }),
  shift(2, "06:30", "07:15", "Morning HIIT", "hiit", "Studio 1", "acc_sam", {
    offer: { id: "of_mine", to: null, from: "acc_sam" },
  }),
  shift(2, "12:15", "13:00", "Lunchtime Yoga", "yoga", "Studio 2", "acc_priya"),
  shift(2, "17:30", "18:30", "Strength Foundations", "strength", "Weights room", "acc_chris", {
    warnings: [
      warning("not_qualified", "", "acc_chris", "Chris Okafor is not marked for Strength."),
    ],
  }),
  shift(2, "18:30", "19:15", "Evening Spin", "spin", "Bike room", "acc_alex"),
  // Thursday
  shift(3, "06:30", "07:15", "Morning HIIT", "hiit", "Studio 1", "acc_alex"),
  shift(3, "09:00", "13:00", "Front desk", "desk", "Reception", "acc_maya", {
    warnings: [warning("unavailable", "", "acc_maya", "Maya Patel said she is away then.")],
  }),
  shift(3, "12:15", "13:00", "Lunchtime Yoga", "yoga", "Studio 2", "acc_priya", {
    offer: { id: "of_yoga", to: null, from: "acc_priya" },
  }),
  shift(3, "18:00", "18:45", "Evening Spin", "spin", "Bike room", "acc_sam"),
  shift(3, "21:00", "21:45", "Close-down", "close", "Main floor", "acc_jordan", {
    checklist: { name: "Closing checks", state: null },
  }),
  // Friday
  shift(4, "05:45", "06:30", "Open-up", "open", "Main floor", "acc_sam", {
    checklist: { name: "Opening checks", state: "not_started" },
  }),
  shift(4, "06:30", "07:15", "Morning HIIT", "hiit", "Studio 1", "acc_chris"),
  shift(4, "12:15", "13:00", "Strength Foundations", "strength", "Weights room", "acc_sam"),
  shift(4, "18:00", "18:45", "Evening Spin", "spin", "Bike room", null, {
    offer: { id: "of_spin", to: null, from: null },
  }),
  shift(4, "21:00", "21:45", "Close-down", "close", "Main floor", "acc_chris", {
    offer: { id: "of_close", to: "acc_sam", from: "acc_chris" },
    checklist: { name: "Closing checks", state: null },
  }),
  // Saturday
  shift(5, "08:00", "09:00", "Weekend Bootcamp", "hiit", "Car park", "acc_alex", {
    offer: { id: "of_boot", to: null, from: "acc_alex" },
  }),
  shift(5, "09:30", "10:30", "Yoga Flow", "yoga", "Studio 2", "acc_priya"),
  shift(5, "10:00", "14:00", "Front desk", "desk", "Reception", "acc_ella"),
  // Sunday
  shift(6, "09:00", "10:00", "Slow Flow Yoga", "yoga", "Studio 2", { visiting: "Hana Ito" }),
  shift(6, "10:30", "11:15", "Sunday Spin", "spin", "Bike room", "acc_jordan"),
];

const days = Array.from({ length: 7 }, (_, i) => ({ date: dayAfter(i), hours: 24 }));

/** The week as someone who rosters reads it (with warnings). */
export const week: Out<"x.rostering.week"> = { shifts, zone: TIME_ZONE, days, truncated: false };

/** Sam's own shifts. */
export const mine: Out<"x.rostering.mine"> = {
  shifts: shifts.filter((s) => s.mine).map((s) => ({ ...s, warnings: null })),
  zone: TIME_ZONE,
  days,
  truncated: false,
};

/** The shift the assign panel and the web checklist open. */
export const tuesdaySpin = shifts.find(
  (s) => s.uncovered && s.startsAt.startsWith(dayAfter(1)),
) as Shift;
export const frontDesk = shifts.find((s) => s.title === "Front desk" && s.mine) as Shift;

export const candidates: Out<"x.rostering.candidates"> = {
  current: { account: null, name: null },
  pattern: { account: "acc_alex", name: "Alex Chen", own: true },
  people: [
    {
      account: "acc_sam",
      name: "Sam Rivera",
      eligible: true,
      noProfile: false,
      warnings: [],
      clash: null,
    },
    {
      account: "acc_jordan",
      name: "Jordan Lee",
      eligible: true,
      noProfile: false,
      warnings: [],
      clash: null,
    },
    {
      account: "acc_alex",
      name: "Alex Chen",
      eligible: false,
      noProfile: false,
      warnings: [
        warning("unavailable", tuesdaySpin.id, "acc_alex", "Alex Chen said he is away then."),
      ],
      clash: null,
    },
    {
      account: "acc_ella",
      name: "Ella Novak",
      eligible: false,
      noProfile: false,
      warnings: [
        warning("not_qualified", tuesdaySpin.id, "acc_ella", "Ella Novak is not marked for Spin."),
      ],
      clash: null,
    },
    {
      account: "acc_chris",
      name: "Chris Okafor",
      eligible: false,
      noProfile: false,
      warnings: [],
      clash: {
        object: DUTY,
        id: "sh_desk_tue",
        title: "Front desk",
        startsAt: at("17:00", dayAfter(1)),
        endsAt: at("21:00", dayAfter(1)),
      },
    },
    {
      account: "acc_maya",
      name: "Maya Patel",
      eligible: false,
      noProfile: true,
      warnings: [],
      clash: null,
    },
  ],
  truncated: false,
};

// --- Offers -----------------------------------------------------------------------------------------

function summaryOf(s: Shift) {
  return { object: s.object, id: s.id, title: s.title, startsAt: s.startsAt, endsAt: s.endsAt };
}
const byOffer = (id: string) => shifts.find((s) => s.offer?.id === id) as Shift;

export const offers: Out<"x.rostering.offers"> = {
  open: [
    {
      id: "of_close",
      shift: summaryOf(byOffer("of_close")),
      from: "acc_chris",
      fromName: "Chris Okafor",
      to: "acc_sam",
      state: "open",
      madeAt: at("08:12"),
      takenBy: null,
      takenAt: null,
      closesAt: at("19:00", dayAfter(4)),
      unavailable: false,
    },
    {
      id: "of_boot",
      shift: summaryOf(byOffer("of_boot")),
      from: "acc_alex",
      fromName: "Alex Chen",
      to: null,
      state: "open",
      madeAt: at("19:40", dayAfter(-1)),
      takenBy: null,
      takenAt: null,
      closesAt: at("06:00", dayAfter(5)),
      unavailable: false,
    },
    {
      id: "of_spin",
      shift: summaryOf(byOffer("of_spin")),
      from: null,
      fromName: null,
      to: null,
      state: "open",
      madeAt: at("07:55"),
      takenBy: null,
      takenAt: null,
      closesAt: at("16:00", dayAfter(4)),
      unavailable: false,
    },
    {
      id: "of_sun",
      shift: {
        object: CLASS,
        id: "sh_sun2",
        title: "Sunday Spin",
        startsAt: at("10:30", dayAfter(13)),
        endsAt: at("11:15", dayAfter(13)),
      },
      from: "acc_jordan",
      fromName: "Jordan Lee",
      to: null,
      state: "open",
      madeAt: at("09:05"),
      takenBy: null,
      takenAt: null,
      closesAt: at("08:30", dayAfter(13)),
      unavailable: true,
    },
  ],
  mine: [
    {
      id: "of_mine",
      shift: summaryOf(byOffer("of_mine")),
      from: "acc_sam",
      fromName: "Sam Rivera",
      to: null,
      state: "open",
      madeAt: at("21:10", dayAfter(-2)),
      takenBy: null,
      takenAt: null,
      closesAt: at("04:30", dayAfter(2)),
    },
  ],
};

// --- Time off ---------------------------------------------------------------------------------------

type Away = Out<"x.rostering.myAway">["items"][number];
function away(a: Partial<Away> & Pick<Away, "id" | "account" | "kind">): Away {
  return {
    name: nameOf(a.account as Account),
    note: null,
    startsAt: null,
    endsAt: null,
    weekdays: [],
    startTime: null,
    endTime: null,
    fromDate: null,
    untilDate: null,
    zone: TIME_ZONE,
    ...a,
  };
}

export const myAway: Out<"x.rostering.myAway"> = {
  items: [
    away({
      id: "aw_1",
      account: "acc_sam",
      kind: "regular",
      note: "Evening course at the college",
      weekdays: ["wed"],
      startTime: "17:00",
      endTime: "20:30",
      fromDate: dayAfter(2),
      untilDate: "2026-06-24",
    }),
    away({
      id: "aw_2",
      account: "acc_sam",
      kind: "leave",
      note: "Family wedding",
      startsAt: at("00:00", "2026-03-16"),
      endsAt: at("23:59", "2026-03-20"),
    }),
    away({
      id: "aw_3",
      account: "acc_sam",
      kind: "other",
      note: "Physio appointment",
      startsAt: at("13:00", "2026-03-27"),
      endsAt: at("15:30", "2026-03-27"),
    }),
    away({
      id: "aw_4",
      account: "acc_sam",
      kind: "leave",
      // After the clocks go forward: midnight in London is 23:00 UTC.
      startsAt: at("23:00", "2026-04-12"),
      endsAt: at("22:59", "2026-04-17"),
    }),
  ],
};

export const awayList: Out<"x.rostering.awayList"> = {
  items: [
    away({
      id: "aw_10",
      account: "acc_maya",
      kind: "leave",
      note: "Long weekend away",
      startsAt: at("00:00", dayAfter(3)),
      endsAt: at("23:59", dayAfter(6)),
    }),
    away({
      id: "aw_11",
      account: "acc_chris",
      kind: "regular",
      note: "School run",
      weekdays: ["tue", "thu"],
      startTime: "07:30",
      endTime: "09:00",
      fromDate: "2026-01-05",
    }),
    away({
      id: "aw_12",
      account: "acc_alex",
      kind: "other",
      note: "Hospital appointment",
      startsAt: at("16:00", dayAfter(1)),
      endsAt: at("20:00", dayAfter(1)),
    }),
    away({
      id: "aw_13",
      account: "acc_ella",
      kind: "other",
      startsAt: at("08:00", dayAfter(5)),
      endsAt: at("09:30", dayAfter(5)),
    }),
    myAway.items[0] as Away,
    away({
      id: "aw_14",
      account: "acc_jordan",
      kind: "leave",
      note: "Moving house",
      startsAt: at("00:00", dayAfter(6)),
      endsAt: at("23:59", dayAfter(9)),
    }),
  ],
};

// --- The regular week -------------------------------------------------------------------------------

type Pattern = Out<"x.rostering.patterns">["patterns"][number];
function pattern(
  id: string,
  title: string,
  kind: KindKey,
  weekdays: string[],
  time: string,
  length: number,
  who: Account | null | { visiting: string },
): Pattern {
  const duty = kinds[kind].object === "rostering.duty";
  const visiting = who !== null && typeof who === "object";
  const account = who === null || visiting ? null : who;
  return {
    object: duty ? "rostering.dutyseries" : "bookings.series",
    id,
    title,
    objectLabel: duty ? "Duty series" : "Class series",
    kind: kindRef(kind),
    weekdays,
    time,
    length,
    firstDate: "2026-01-05",
    lastDate: null,
    zone: TIME_ZONE,
    account,
    name: visiting ? who.visiting : account ? nameOf(account) : null,
    noAccount: visiting,
  };
}

export const patterns: Out<"x.rostering.patterns"> = {
  patterns: [
    pattern("ps_1", "Open-up", "open", ["mon", "wed"], "05:45", 45, "acc_jordan"),
    pattern("ps_2", "Open-up", "open", ["fri"], "05:45", 45, "acc_sam"),
    pattern("ps_3", "Morning HIIT", "hiit", ["mon", "wed"], "06:30", 45, "acc_sam"),
    pattern("ps_4", "Morning HIIT", "hiit", ["tue", "thu"], "06:30", 45, "acc_alex"),
    pattern("ps_5", "Morning HIIT", "hiit", ["fri"], "06:30", 45, "acc_chris"),
    pattern("ps_6", "Front desk", "desk", ["mon", "tue", "thu"], "09:00", 240, "acc_maya"),
    pattern("ps_7", "Lunchtime Yoga", "yoga", ["mon", "wed", "thu"], "12:15", 45, "acc_priya"),
    pattern("ps_8", "Strength Foundations", "strength", ["tue", "fri"], "12:15", 45, "acc_sam"),
    pattern("ps_9", "Evening Spin", "spin", ["mon", "tue", "thu"], "18:00", 45, "acc_alex"),
    pattern("ps_10", "Evening Spin", "spin", ["fri"], "18:00", 45, null),
    pattern("ps_11", "Close-down", "close", ["mon", "tue", "fri"], "21:00", 45, "acc_chris"),
    pattern("ps_12", "Weekend Bootcamp", "hiit", ["sat"], "08:00", 60, "acc_alex"),
    pattern("ps_13", "Yoga Flow", "yoga", ["sat"], "09:30", 60, "acc_priya"),
    pattern("ps_14", "Slow Flow Yoga", "yoga", ["sun"], "09:00", 60, { visiting: "Hana Ito" }),
    pattern("ps_15", "Sunday Spin", "spin", ["sun"], "10:30", 45, "acc_jordan"),
  ],
  truncated: false,
};

// --- Qualifications ---------------------------------------------------------------------------------

const held: Record<Account, KindKey[]> = {
  acc_sam: ["hiit", "spin", "strength", "open", "desk", "close"],
  acc_alex: ["hiit", "spin", "strength", "open"],
  acc_priya: ["yoga", "desk"],
  acc_jordan: ["spin", "open", "close", "desk"],
  acc_maya: ["desk", "close"],
  acc_chris: ["hiit", "open", "close"],
  acc_ella: ["yoga", "desk"],
};

export const qualifications: Out<"x.rostering.qualifications"> = {
  items: team.flatMap((p) =>
    held[p.account].map((k) => ({
      account: p.account,
      name: p.name,
      kind: kindRef(k),
      setBy: "Sam Rivera",
      setAt: at("10:00", "2026-01-05"),
    })),
  ),
};

// --- Checklists -------------------------------------------------------------------------------------

function tick(t: Partial<Tick> & Pick<Tick, "id" | "at">): Tick {
  const done = t.state !== "not_done";
  return {
    state: "done",
    done,
    why: null,
    note: null,
    onBehalfWhy: null,
    withheld: false,
    by: "acc_sam",
    byName: "Sam Rivera",
    for: "acc_sam",
    forName: "Sam Rivera",
    onBehalf: false,
    label: "Ticked by Sam Rivera",
    ...t,
  };
}

const deskRun: Run = {
  id: "run_desk",
  object: frontDesk.object,
  record: frontDesk.id,
  template: { id: "tpl_desk", name: "Front desk", version: 3 },
  state: "open",
  account: "acc_sam",
  name: "Sam Rivera",
  opens: frontDesk.startsAt,
  closes: frontDesk.endsAt as string,
  tickUntil: at("15:00"),
  madeAt: at("00:00"),
  closedAt: null,
  closedBy: null,
  closedByName: null,
  closedWhy: null,
  steps: [
    {
      position: 0,
      text: "Switch on the lights and the music",
      required: true,
      asksNote: false,
      tick: tick({ id: "tk_1", at: at("09:02") }),
      history: [],
      historyTruncated: false,
      missed: false,
    },
    {
      position: 1,
      text: "Check the first-aid kit is stocked",
      required: true,
      asksNote: true,
      tick: tick({
        id: "tk_2",
        at: at("09:08"),
        note: "Two plasters used; restocked from the store room.",
      }),
      history: [],
      historyTruncated: false,
      missed: false,
    },
    {
      position: 2,
      text: "Wipe down the desk and the card reader",
      required: true,
      asksNote: false,
      tick: tick({
        id: "tk_3",
        at: at("09:15"),
        state: "not_done",
        why: "Out of wipes: more ordered.",
      }),
      history: [],
      historyTruncated: false,
      missed: false,
    },
    {
      position: 3,
      text: "Count the float in the till",
      required: true,
      asksNote: true,
      tick: null,
      history: [],
      historyTruncated: false,
      missed: false,
    },
    {
      position: 4,
      text: "Restock the towels by the changing rooms",
      required: false,
      asksNote: false,
      tick: null,
      history: [],
      historyTruncated: false,
      missed: false,
    },
  ],
  corrections: [],
};

export const deskChecklist: Out<"x.rostering.checklist"> = {
  template: { id: "tpl_desk", name: "Front desk" },
  run: deskRun,
  preview: null,
  opens: deskRun.opens,
  closes: deskRun.closes,
  tickUntil: deskRun.tickUntil,
  canTick: true,
  onBehalf: false,
  forName: null,
  you: "acc_sam",
  youRoster: true,
};

type RunSummary = Out<"x.rostering.checklistRuns">["runs"][number];
function runOf(
  id: string,
  day: number,
  tpl: "open" | "close" | "desk",
  who: Account | null,
  state: RunSummary["state"],
  ticked: number,
  extra: Partial<RunSummary> = {},
): RunSummary {
  const t = {
    open: {
      id: "tpl_open",
      name: "Opening checks",
      title: "Open-up",
      from: "05:45",
      to: "06:30",
      steps: 6,
    },
    close: {
      id: "tpl_close",
      name: "Closing checks",
      title: "Close-down",
      from: "21:00",
      to: "21:45",
      steps: 7,
    },
    desk: {
      id: "tpl_desk",
      name: "Front desk",
      title: "Front desk",
      from: "09:00",
      to: "13:00",
      steps: 5,
    },
  }[tpl];
  const date = dayAfter(day);
  return {
    id,
    object: DUTY,
    record: `sh_r${id}`,
    title: t.title,
    template: { id: t.id, name: t.name },
    state,
    account: who,
    name: who ? nameOf(who) : null,
    opens: at(t.from, date),
    closes: at(t.to, date),
    steps: t.steps,
    ticked,
    onBehalf: 0,
    missed: [],
    corrections: 0,
    ...extra,
  };
}

export const checklistRuns: Out<"x.rostering.checklistRuns"> = {
  zone: TIME_ZONE,
  runs: [
    runOf("r1", -6, "open", "acc_jordan", "done", 6),
    runOf("r2", -5, "open", "acc_chris", "missed", 4, {
      missed: ["Check the fire exits are clear", "Log the pool temperature"],
    }),
    runOf("r3", -4, "open", "acc_sam", "done", 6, { onBehalf: 1, corrections: 1 }),
    runOf("r4", 0, "open", "acc_jordan", "done", 6),
    runOf("r5", -6, "close", "acc_chris", "done", 7),
    runOf("r6", -5, "close", "acc_maya", "done", 6, { missed: ["Empty the lost property box"] }),
    runOf("r7", -3, "close", null, "cancelled", 0),
    runOf("r8", -1, "close", "acc_chris", "done", 7),
    runOf("r9", -6, "desk", "acc_maya", "done", 5),
    runOf("r10", 0, "desk", "acc_sam", "open", 2),
  ],
  truncated: false,
};

// --- Calendar ---------------------------------------------------------------------------------------

export const feedOff: Out<"x.rostering.feed"> = { active: false, createdAt: null };
export const feedMade: Out<"x.rostering.feedRotate"> = {
  path: "/feeds/rostering/c7f2a91e5b4d4e08a3d6.ics",
  createdAt: at("09:30"),
};

/** The calendar's answers: no address until one is made, then one. */
export function calendarAnswers(): Answers<RosteringOperations> {
  let made = false;
  return {
    "x.rostering.feed": () => (made ? { active: true, createdAt: feedMade.createdAt } : feedOff),
    "x.rostering.feedRotate": () => {
      made = true;
      return feedMade;
    },
  };
}

// --- Pay --------------------------------------------------------------------------------------------

type PayPeriod = Out<"x.rostering.periods">["periods"][number];
type Version = PayPeriod["versions"][number];
function version(v: number, lockedAt: string, reopened?: { at: string; why: string }): Version {
  return {
    id: `pv_${lockedAt}_${v}`,
    version: v,
    state: reopened ? "reopened" : "locked",
    lockedBy: "acc_sam",
    lockedByName: "Sam Rivera",
    lockedAt: at("10:00", lockedAt),
    reopenedBy: reopened ? "acc_sam" : null,
    reopenedAt: reopened ? at("11:00", reopened.at) : null,
    reopenReason: reopened?.why ?? null,
  };
}

const fortnights: { start: string; end: string }[] = [
  { start: "2026-02-23", end: "2026-03-08" },
  { start: "2026-02-09", end: "2026-02-22" },
  { start: "2026-01-26", end: "2026-02-08" },
  { start: "2026-01-12", end: "2026-01-25" },
  { start: "2025-12-29", end: "2026-01-11" },
  { start: "2025-12-15", end: "2025-12-28" },
];

export const periods: Out<"x.rostering.periods"> = {
  setting: { period: "fortnightly", start: "2025-12-15", day: 1, zone: TIME_ZONE },
  set: true,
  periods: fortnights.map((f, i) => ({
    ...f,
    zone: TIME_ZONE,
    state: i < 2 ? "open" : "locked",
    ended: i > 0,
    versions:
      i < 2
        ? []
        : i === 3
          ? [
              version(1, "2026-01-26", {
                at: "2026-01-28",
                why: "A missed class list on 20 January",
              }),
              version(2, "2026-01-28"),
            ]
          : [version(1, dayAfter(2, f.end))],
  })),
};

type TotalsRow = Out<"x.rostering.periodTotals">["totals"][number];
type Line = Out<"x.rostering.periodTotals">["lines"][number];
const email = (account: Account) => `${nameOf(account).split(" ")[0]?.toLowerCase()}@example.com`;
function total(
  account: Account,
  basis: TotalsRow["basis"],
  k: KindKey,
  shiftsCount: number,
  minutes: number,
  extra: Partial<TotalsRow> = {},
): TotalsRow {
  return {
    account,
    name: nameOf(account),
    email: email(account),
    basis,
    kind: { object: kinds[k].object, id: kinds[k].id },
    kindName: kinds[k].name,
    shifts: shiftsCount,
    minutes,
    hours: (minutes / 60).toFixed(2),
    notWorked: 0,
    flagged: 0,
    ...extra,
  };
}
function line(
  account: Account,
  date: string,
  start: string,
  end: string,
  title: string,
  k: KindKey,
  place: string,
  extra: Partial<Line> = {},
): Line {
  const minutes = (Date.parse(`${date}T${end}:00Z`) - Date.parse(`${date}T${start}:00Z`)) / 60_000;
  const duty = kinds[k].object === "rostering.duty";
  return {
    account,
    name: nameOf(account),
    email: email(account),
    basis: duty ? "by_time" : "by_class",
    object: duty ? DUTY : CLASS,
    id: `ln_${account}_${date}_${start}`,
    kind: { object: kinds[k].object, id: kinds[k].id },
    kindName: kinds[k].name,
    title,
    place,
    localDate: date,
    localStart: `${date}T${start}`,
    localEnd: `${date}T${end}`,
    shiftMinutes: minutes,
    beforeMinutes: 0,
    afterMinutes: 0,
    countedMinutes: minutes,
    counted: true,
    notWorkedReason: null,
    listTaken: duty ? null : true,
    markedBy: duty ? null : nameOf(account),
    flagged: false,
    ...extra,
  };
}

export const periodTotals: Out<"x.rostering.periodTotals"> = {
  period: {
    start: "2026-02-09",
    end: "2026-02-22",
    zone: TIME_ZONE,
    locked: false,
    preview: true,
    version: null,
  },
  totals: [
    total("acc_alex", "by_class", "hiit", 6, 270),
    total("acc_alex", "by_class", "spin", 6, 225, { notWorked: 1 }),
    total("acc_chris", "by_class", "hiit", 2, 90, { flagged: 1 }),
    total("acc_chris", "by_time", "close", 6, 270),
    total("acc_jordan", "by_time", "open", 4, 180),
    total("acc_maya", "by_time", "desk", 6, 1440),
    total("acc_priya", "by_class", "yoga", 8, 390),
    total("acc_ella", "by_time", "desk", 4, 960),
  ],
  lines: [
    line("acc_alex", "2026-02-10", "06:30", "07:15", "Morning HIIT", "hiit", "Studio 1"),
    line("acc_alex", "2026-02-10", "18:00", "18:45", "Evening Spin", "spin", "Bike room"),
    line("acc_chris", "2026-02-13", "06:30", "07:15", "Morning HIIT", "hiit", "Studio 1", {
      markedBy: "Sam Rivera",
      flagged: true,
    }),
    line("acc_alex", "2026-02-17", "18:00", "18:45", "Evening Spin", "spin", "Bike room", {
      counted: false,
      countedMinutes: 0,
      notWorkedReason: "Class cancelled: power cut",
      listTaken: false,
      markedBy: null,
    }),
    line("acc_maya", "2026-02-16", "09:00", "13:00", "Front desk", "desk", "Reception"),
  ],
  minutes: 3825,
  hours: "63.75",
};

export const payBases: Out<"x.rostering.payBases"> = {
  today: TODAY,
  items: (
    [
      ["acc_alex", "by_class"],
      ["acc_chris", "by_class"],
      ["acc_ella", "by_time"],
      ["acc_jordan", "by_time"],
      ["acc_maya", "by_time"],
      ["acc_priya", "by_class"],
      ["acc_sam", "by_class"],
    ] as const
  ).map(([account, basis]) => ({
    account,
    name: nameOf(account),
    basis,
    history: [{ from: "2025-12-15", basis, setBy: "Sam Rivera", setAt: at("10:00", "2025-12-15") }],
  })),
  truncated: false,
};

// --- My hours ---------------------------------------------------------------------------------------

export const myPayPeriods: Out<"x.rostering.myPayPeriods"> = {
  set: true,
  periods: periods.periods.slice(0, 4).map((p) => ({
    start: p.start,
    end: p.end,
    zone: p.zone,
    state: p.state,
    ended: p.ended,
    version: p.versions.at(-1)?.version ?? null,
  })),
};

export const myPay: Out<"x.rostering.myPay"> = {
  period: {
    start: "2026-02-23",
    end: "2026-03-08",
    zone: TIME_ZONE,
    ended: false,
    locked: false,
    preview: true,
    version: null,
  },
  counted: true,
  basis: "by_class",
  totals: [
    {
      basis: "by_class",
      kind: kindRef("hiit"),
      kindName: "HIIT",
      shifts: 4,
      minutes: 180,
      hours: "3.00",
      notWorked: 0,
      flagged: 0,
    },
    {
      basis: "by_class",
      kind: kindRef("strength"),
      kindName: "Strength",
      shifts: 4,
      minutes: 180,
      hours: "3.00",
      notWorked: 0,
      flagged: 0,
    },
    {
      basis: "by_class",
      kind: kindRef("spin"),
      kindName: "Spin",
      shifts: 2,
      minutes: 90,
      hours: "1.50",
      notWorked: 1,
      flagged: 0,
    },
  ],
  lines: [],
  minutes: 450,
  hours: "7.50",
};

// --- Every answer -----------------------------------------------------------------------------------

/** What the host answers each rostering query with (and the calendar address, once made). */
export const answers: Answers<RosteringOperations> = {
  "x.rostering.me": me,
  "x.rostering.week": week,
  "x.rostering.mine": mine,
  "x.rostering.offers": offers,
  "x.rostering.myAway": myAway,
  "x.rostering.awayList": awayList,
  "x.rostering.people": people,
  "x.rostering.patterns": patterns,
  "x.rostering.qualifications": qualifications,
  "x.rostering.candidates": candidates,
  "x.rostering.checklist": deskChecklist,
  "x.rostering.checklistRuns": checklistRuns,
  "x.rostering.feed": feedOff,
  "x.rostering.feedRotate": feedMade,
  "x.rostering.periods": periods,
  "x.rostering.periodTotals": periodTotals,
  "x.rostering.payBases": payBases,
  "x.rostering.myPayPeriods": myPayPeriods,
  "x.rostering.myPay": myPay,
};
