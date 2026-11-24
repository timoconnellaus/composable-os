// The Rostering pack's headless entry (stage 45 step 7; ADR 0418): functions and hooks over the
// typed client, no markup. A client app imports it as `@composable-os/pack-rostering/client` and
// hands it its client; the rostering blocks (web and native) render what it returns. Web and
// native share this logic, not their screens (ADR 0403).
//
// As every pack's entry: the operations are typed from the pack's own tool schemas, it takes the
// client and the app's `useQuery` and `useMutation` as arguments (no React or TanStack import),
// and it holds no rules. Who may roster, who handles pay, who is qualified, whether a shift
// clashes, whether a take is allowed, what a pay period totals, and how long each day is in the
// business's zone are the host's: a block shows the host's answer (`me`, the roster, a refusal),
// never works one out. The plain functions below only format what the host gave.
//
// Who sees what is the host's too: a team member's client may hold the rosterers' hooks (an
// ordinary staff role holds every pack tool), but a block asks `useMe()` first and shows the
// rosterers' and pay screens only when the host says `rosters` or `pays`, so it never fetches what
// the viewer may not see. What someone writes about their time off, why a period was reopened,
// why a shift was not worked, and pay figures (a person's own hours too) are kept in the app's
// cache no longer than they are on screen (`gcTime: 0`), and what was sent is forgotten once the
// call is over (`forgetAfter`).
// A checklist (step 4b, ADR 0650) is the same: what someone wrote on a step, why it was not done
// and why it was ticked for them are on screen only, and never sent in a query's key.
import {
  type ClientHolding,
  forgetAfter,
  type PackClient,
  packHooks,
  type UseMutation,
  type UseQuery,
} from "@composable-os/client";
import type { z } from "@composable-os/sdk";
import type {
  assign,
  away,
  awayFor,
  awayList,
  back,
  candidates,
  check,
  checklist,
  checklistCorrect,
  checklistDone,
  checklistRuns,
  exportPeriod,
  feed,
  feedRevoke,
  feedRotate,
  follow,
  lock,
  markNotWorked,
  me,
  mine,
  myAway,
  myPay,
  myPayPeriods,
  offer,
  offers,
  patterns,
  payBases,
  payBasis,
  people,
  periods,
  periodTotals,
  planCheck,
  qualifications,
  qualify,
  reopen,
  setPattern,
  take,
  tick,
  uncovered,
  week,
  withdraw,
} from "../tools.ts";

export { forgetAfter };

type Io<T extends { input: z.ZodType; output: z.ZodType }> = {
  input: z.input<T["input"]>;
  output: z.output<T["output"]>;
};

/** The operations this entry calls, as the generated client types them. */
export type RosteringOperations = {
  "x.rostering.me": { kind: "query" } & Io<typeof me>;
  "x.rostering.week": { kind: "query" } & Io<typeof week>;
  "x.rostering.mine": { kind: "query" } & Io<typeof mine>;
  "x.rostering.offers": { kind: "query" } & Io<typeof offers>;
  "x.rostering.offer": { kind: "mutation" } & Io<typeof offer>;
  "x.rostering.withdraw": { kind: "mutation" } & Io<typeof withdraw>;
  "x.rostering.take": { kind: "mutation" } & Io<typeof take>;
  "x.rostering.away": { kind: "mutation" } & Io<typeof away>;
  "x.rostering.back": { kind: "mutation" } & Io<typeof back>;
  "x.rostering.myAway": { kind: "query" } & Io<typeof myAway>;
  "x.rostering.myPayPeriods": { kind: "query" } & Io<typeof myPayPeriods>;
  "x.rostering.myPay": { kind: "query" } & Io<typeof myPay>;
  "x.rostering.assign": { kind: "mutation" } & Io<typeof assign>;
  "x.rostering.check": { kind: "query" } & Io<typeof check>;
  "x.rostering.candidates": { kind: "query" } & Io<typeof candidates>;
  "x.rostering.follow": { kind: "mutation" } & Io<typeof follow>;
  "x.rostering.people": { kind: "query" } & Io<typeof people>;
  "x.rostering.patterns": { kind: "query" } & Io<typeof patterns>;
  "x.rostering.setPattern": { kind: "mutation" } & Io<typeof setPattern>;
  "x.rostering.planCheck": { kind: "query" } & Io<typeof planCheck>;
  "x.rostering.qualify": { kind: "mutation" } & Io<typeof qualify>;
  "x.rostering.qualifications": { kind: "query" } & Io<typeof qualifications>;
  "x.rostering.awayFor": { kind: "mutation" } & Io<typeof awayFor>;
  "x.rostering.awayList": { kind: "query" } & Io<typeof awayList>;
  "x.rostering.uncovered": { kind: "query" } & Io<typeof uncovered>;
  "x.rostering.markNotWorked": { kind: "mutation" } & Io<typeof markNotWorked>;
  "x.rostering.payBasis": { kind: "mutation" } & Io<typeof payBasis>;
  "x.rostering.payBases": { kind: "query" } & Io<typeof payBases>;
  "x.rostering.periods": { kind: "query" } & Io<typeof periods>;
  "x.rostering.periodTotals": { kind: "query" } & Io<typeof periodTotals>;
  "x.rostering.lock": { kind: "mutation" } & Io<typeof lock>;
  "x.rostering.reopen": { kind: "mutation" } & Io<typeof reopen>;
  "x.rostering.export": { kind: "query" } & Io<typeof exportPeriod>;
  "x.rostering.feed": { kind: "query" } & Io<typeof feed>;
  "x.rostering.feedRotate": { kind: "mutation" } & Io<typeof feedRotate>;
  "x.rostering.feedRevoke": { kind: "mutation" } & Io<typeof feedRevoke>;
  "x.rostering.checklist": { kind: "query" } & Io<typeof checklist>;
  "x.rostering.tick": { kind: "mutation" } & Io<typeof tick>;
  "x.rostering.checklistDone": { kind: "mutation" } & Io<typeof checklistDone>;
  "x.rostering.checklistRuns": { kind: "query" } & Io<typeof checklistRuns>;
  "x.rostering.checklistCorrect": { kind: "mutation" } & Io<typeof checklistCorrect>;
};

type Name = keyof RosteringOperations & string;
type In<N extends Name> = RosteringOperations[N]["input"];
type Out<N extends Name> = RosteringOperations[N]["output"];

export type Me = Out<"x.rostering.me">;
export type Roster = Out<"x.rostering.week">;
export type RosterShift = Roster["shifts"][number];
export type RosterDay = Roster["days"][number];
export type StaffWarning = NonNullable<RosterShift["warnings"]>[number];
export type Offers = Out<"x.rostering.offers">;
export type OpenOffer = Offers["open"][number];
export type MyOffer = Offers["mine"][number];
export type AwayItem = Out<"x.rostering.myAway">["items"][number];
export type AwayInput = In<"x.rostering.away">;
export type AwayAnswer = Out<"x.rostering.away">;
export type Candidates = Out<"x.rostering.candidates">;
export type Candidate = Candidates["people"][number];
export type People = Out<"x.rostering.people">;
export type Kind = People["kinds"][number];
export type Qualification = Out<"x.rostering.qualifications">["items"][number];
export type Pattern = Out<"x.rostering.patterns">["patterns"][number];
export type PayBases = Out<"x.rostering.payBases">;
export type PayBasisValue = In<"x.rostering.payBasis">["basis"];
export type Periods = Out<"x.rostering.periods">;
export type Period = Periods["periods"][number];
export type PeriodTotals = Out<"x.rostering.periodTotals">;
export type PayExport = Out<"x.rostering.export">;
export type MyPayPeriods = Out<"x.rostering.myPayPeriods">;
export type MyPayPeriod = MyPayPeriods["periods"][number];
export type MyPay = Out<"x.rostering.myPay">;
export type MyPayLine = MyPay["lines"][number];
export type MyPayTotal = MyPay["totals"][number];
export type PlanCheck = Out<"x.rostering.planCheck">;
export type FeedState = Out<"x.rostering.feed">;
export type ShiftChecklist = Out<"x.rostering.checklist">;
export type ChecklistRun = NonNullable<ShiftChecklist["run"]>;
export type ChecklistStep = ChecklistRun["steps"][number];
export type ChecklistTick = NonNullable<ChecklistStep["tick"]>;
export type ChecklistTickInput = In<"x.rostering.tick">;
export type ChecklistRuns = Out<"x.rostering.checklistRuns">;
export type ChecklistRunSummary = ChecklistRuns["runs"][number];
export type ChecklistState = NonNullable<NonNullable<RosterShift["checklist"]>["state"]>;

/** The client of every operation this entry calls (ADR 0453). */
export type RosteringClient = PackClient<RosteringOperations>;

// --- Plain functions (display only) --------------------------------------------------------------

/** The days of a regular week, Monday first, as the host names them and as a person reads them. */
export const WEEKDAYS = [
  ["mon", "Monday"],
  ["tue", "Tuesday"],
  ["wed", "Wednesday"],
  ["thu", "Thursday"],
  ["fri", "Friday"],
  ["sat", "Saturday"],
  ["sun", "Sunday"],
] as const;
export type Weekday = (typeof WEEKDAYS)[number][0];

/** A `YYYY-MM-DD` date `days` later (or earlier): calendar dates only, no time of day or zone. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The Monday on or before a `YYYY-MM-DD` date (the week a date is in). */
export function weekOf(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return addDays(date, -weekday);
}

/** A `YYYY-MM-DD` date as a person reads it ("Tue 3 Mar"). The date as given, in no zone. */
export function dayLabel(date: string, locale = "en-AU", long = false): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(locale, {
    weekday: long ? "long" : "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** An instant's time of day in a zone ("06:00"). */
export function timeIn(iso: string, zone: string, locale = "en-AU"): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: zone,
  }).format(new Date(iso));
}

/** An instant's local date in a zone (`YYYY-MM-DD`). */
export function dateIn(iso: string, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: zone,
  }).format(new Date(iso));
}

/**
 * A shift's times as a person reads them, in the shift's own zone (or the roster's): "06:00–07:00",
 * with the date first when asked ("Tue 3 Mar, 06:00–07:00"), and the end's date when it ends on
 * another day (across midnight).
 */
export function shiftTime(
  shift: { startsAt: string | null; endsAt: string | null; zone?: string | null },
  zone: string,
  options: { withDate?: boolean; locale?: string } = {},
): string {
  if (!shift.startsAt) return "";
  const z = shift.zone ?? zone;
  const locale = options.locale ?? "en-AU";
  const startDate = dateIn(shift.startsAt, z);
  const start = timeIn(shift.startsAt, z, locale);
  let end = "";
  if (shift.endsAt) {
    const endDate = dateIn(shift.endsAt, z);
    end = `–${endDate !== startDate ? `${dayLabel(endDate, locale)} ` : ""}${timeIn(shift.endsAt, z, locale)}`;
  }
  return `${options.withDate ? `${dayLabel(startDate, locale)}, ` : ""}${start}${end}`;
}

/** Who is on a shift, as the roster shows it. */
export function personOn(shift: RosterShift): string {
  if (shift.uncovered) return "Nobody on it";
  if (shift.noAccount) return `${shift.name ?? "A visiting coach"} (no account)`;
  return shift.mine ? `${shift.name ?? "You"} (you)` : (shift.name ?? "Someone");
}

/**
 * A shift's accessible name: what it is, when, where and who is on it, in one line a screen
 * reader says ("Close-down clean, Tue 3 Mar, 18:00–19:00, Main floor, Sam (you)").
 */
export function shiftName(shift: RosterShift, zone: string, locale = "en-AU"): string {
  return [
    shift.title,
    shiftTime(shift, zone, { withDate: true, locale }),
    shift.place,
    personOn(shift),
    shift.offer ? "offered" : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * The roster's shifts by local date, in the order the host's `days` lists them (every date of the
 * range, empty ones too). Each shift is put on its start's date in the roster's zone.
 */
export function shiftsByDay(roster: Pick<Roster, "days" | "shifts" | "zone">): {
  day: RosterDay;
  shifts: RosterShift[];
}[] {
  const byDate = new Map<string, RosterShift[]>(roster.days.map((d) => [d.date, []]));
  for (const shift of roster.shifts) {
    byDate.get(dateIn(shift.startsAt, roster.zone))?.push(shift);
  }
  return roster.days.map((day) => ({ day, shifts: byDate.get(day.date) ?? [] }));
}

/** What a day's length says when the clocks change that day (the host's hours), or null. */
export function clockChange(day: RosterDay): string | null {
  if (day.hours === 24) return null;
  return day.hours < 24
    ? `Clocks go forward: a ${day.hours}-hour day`
    : `Clocks go back: a ${day.hours}-hour day`;
}

/** A warning's short words for a badge. */
export function warningLabel(code: StaffWarning["code"]): string {
  if (code === "unavailable") return "Away";
  if (code === "not_qualified") return "Not qualified";
  return "Nobody on it";
}

/** A time off as a person reads it, in its own zone. */
export function awayWhen(item: AwayItem, locale = "en-AU"): string {
  if (item.kind === "regular") {
    const days = WEEKDAYS.filter(([d]) => item.weekdays.includes(d))
      .map(([, name]) => name)
      .join(", ");
    const range = item.untilDate
      ? `from ${dayLabel(item.fromDate ?? "", locale)} until ${dayLabel(item.untilDate, locale)}`
      : `from ${dayLabel(item.fromDate ?? "", locale)}`;
    return `Every ${days}, ${item.startTime}–${item.endTime}, ${range}`;
  }
  if (!item.startsAt || !item.endsAt) return "";
  return `${shiftTime({ startsAt: item.startsAt, endsAt: item.endsAt }, item.zone, { withDate: true, locale })}`;
}

/** A time off's kind as a person reads it. */
export function awayKind(kind: AwayItem["kind"]): string {
  return kind === "leave" ? "Leave" : kind === "regular" ? "Regular time off" : "Away";
}

/** A pattern's regular week as a person reads it ("Mon, Wed 06:00, 60 minutes"). */
export function patternWhen(p: Pattern): string {
  const days = WEEKDAYS.filter(([d]) => p.weekdays.includes(d))
    .map(([, name]) => name.slice(0, 3))
    .join(", ");
  return [days, p.time, p.length ? `${p.length} minutes` : null].filter(Boolean).join(" ");
}

/**
 * A calendar feed's address, from the host's origin (`https://admin.example.com`) and the path the
 * host gave once (`feedRotate`): the https address to copy into a calendar app, and the webcal one
 * that opens a phone's calendar to subscribe. Never kept: the screen shows it and forgets it.
 */
export function feedAddresses(hostUrl: string, path: string): { https: string; webcal: string } {
  const origin = new URL(hostUrl).origin;
  const https = new URL(path, origin).toString().replace(/^http:/, "https:");
  return { https, webcal: https.replace(/^https:/, "webcal:") };
}

/** How a shift's checklist is going, as a person reads it. */
export function checklistStateLabel(state: ChecklistState | ChecklistRun["state"]): string {
  switch (state) {
    case "not_started":
      return "Not started";
    case "in_progress":
    case "open":
      return "In progress";
    case "done":
      return "Done";
    case "missed":
      return "Missed";
    default:
      return "Cancelled";
  }
}

/** A step's tick as every screen shows it: what was ticked, by whom and for whom. */
export function tickLabel(tick: ChecklistTick): string {
  if (tick.state === "cleared") return tick.label;
  return `${tick.done ? "Done" : "Not done"}: ${tick.label}`;
}

/** A pay basis as a person reads it. */
export function basisLabel(basis: string): string {
  if (basis === "by_time") return "By time (hours)";
  if (basis === "by_class") return "By class (shifts)";
  return "Not counted";
}

// --- Refusals --------------------------------------------------------------------------------------

/** A rule the host's refusal names, each with its own designed state. */
const HOST_RULES = [
  "double_booked",
  "nobody_qualified",
  "not_qualified",
  "no_profile",
  "offer_stale",
  "offer_taken",
  "offer_closed",
  "offer_open",
  "offer_cutoff",
  "own_offer",
  "offered_to_someone_else",
  "unavailable_confirm",
  "shift_not_live",
  "shift_not_started",
  "not_yours",
  "rostering",
  "pay_period_locked",
  "pay_period_held",
  "pay_period_unset",
  "pay_period_open",
  "pay_period_not_locked",
  "pay_period_too_large",
  "roster_changed",
  "recurring_not_generated",
  "recurring_moved",
  "recurring_past",
  "deactivate_confirm",
  "checklist_window",
  "checklist_closed",
  "checklist_not_live",
  "checklist_nobody",
  "checklist_not_yours",
  "checklist_not_your_tick",
  "checklist_nothing_to_clear",
  "checklist_too_many_ticks",
  "checklist_for_why",
  "checklist_note_needed",
  "checklist_why",
  "checklist_incomplete",
  "checklist_open",
  "human_only",
] as const;

/**
 * Every refusal the roster's tools can give a screen, each with its own designed state. `kind`
 * says which state to show; `message` is the host's own words (they name the other shift, who
 * took an offer, the dates a pattern would clash on).
 */
export type RosterRefusalKind =
  | (typeof HOST_RULES)[number]
  | "forbidden"
  | "address_lost"
  | "not_found"
  | "invalid"
  | "network"
  | "other";

export interface RosterRefusal {
  kind: RosterRefusalKind;
  /** The host's words, or ours for a network failure or a refusal with none. */
  message: string;
  /** Who took an offer (`offer_taken`), as the host named them in `message`. */
  takenBy?: string | null;
  /** The dates a pattern change would clash on (`double_booked` of a pattern). */
  dates?: string[];
  /** The other shift (`double_booked`). */
  other?: { title: string; startsAt: string; endsAt: string } | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** The host's details of an error: its own, or a pack tool's that carries the host's inside. */
function hostDetails(error: unknown): Record<string, unknown> | null {
  const details = record(record(error)?.details);
  if (!details) return null;
  if (typeof details.rule === "string") return details;
  const inner = record(details.details);
  return inner && typeof inner.rule === "string" ? inner : null;
}

const KNOWN_RULES: ReadonlySet<string> = new Set(HOST_RULES);
const isHostRule = (rule: string): rule is (typeof HOST_RULES)[number] => KNOWN_RULES.has(rule);

/** The words for a refusal the host gave without its own (it always gives some). */
const FALLBACK = {
  forbidden:
    "You can't do that on the roster. If you think you should, ask whoever runs the roster.",
  not_found: "That is no longer there. It may have been changed or removed: refresh the roster.",
  network: "We could not reach the business just now. Check your connection and try again.",
  other: "That did not work. Try again.",
};

/** What the host's refusal of a roster call was, for the screen's designed state. */
export function rosterRefusal(error: unknown): RosterRefusal {
  const e = record(error);
  if (e?.name === "NetworkError") return { kind: "network", message: FALLBACK.network };
  const outer = record(e?.details);
  // A retried call whose answer the host never keeps (a new calendar address): it was made, but
  // cannot be shown again.
  if (outer?.reason === "idempotency_response_lost") {
    return {
      kind: "address_lost",
      message:
        "A new address was made, but it could not be shown again, and it is never kept. Make a new address: the one just made stops working.",
    };
  }
  const details = hostDetails(error);
  const rule = typeof details?.rule === "string" ? details.rule : null;
  const message = typeof e?.message === "string" && e.message ? e.message : null;
  if (rule && isHostRule(rule)) {
    const kind = rule;
    const out: RosterRefusal = { kind, message: message ?? FALLBACK.other };
    if (kind === "offer_taken") {
      out.takenBy = typeof details?.takenBy === "string" ? details.takenBy : null;
    }
    if (kind === "double_booked") {
      if (Array.isArray(details?.dates)) out.dates = details.dates.map(String);
      const clashes = Array.isArray(details?.clashes) ? details.clashes : [];
      const first = record(record(clashes[0])?.other);
      const other = first ?? record(details?.other);
      if (other && typeof other.title === "string") {
        out.other = {
          title: other.title,
          startsAt: String(other.startsAt ?? ""),
          endsAt: String(other.endsAt ?? ""),
        };
      }
    }
    return out;
  }
  const code = typeof e?.code === "string" ? e.code : null;
  const inner = typeof outer?.code === "string" ? outer.code : null;
  const surface = inner ?? code;
  if (surface === "forbidden") return { kind: "forbidden", message: FALLBACK.forbidden };
  if (surface === "not_found") return { kind: "not_found", message: FALLBACK.not_found };
  if (surface === "invalid_input" || surface === "validation") {
    return { kind: "invalid", message: message ?? "Something entered is not right." };
  }
  return { kind: "other", message: message ?? FALLBACK.other };
}

/** The roster's own copy for a refusal kind that asks the person to do something next. */
export function refusalNext(kind: RosterRefusalKind, rosters: boolean): string | null {
  switch (kind) {
    case "double_booked":
      return "Choose someone else, or settle their other shift first.";
    case "nobody_qualified":
      return rosters
        ? "Mark who may do this kind of work on Qualifications, or put someone on it."
        : "Ask whoever rosters to find someone for it.";
    case "offer_taken":
    case "offer_closed":
    case "offer_stale":
      return "The list of offers has been refreshed.";
    case "offer_cutoff":
      return "Offers close before a shift starts: whoever rosters reassigns it now.";
    case "pay_period_locked":
      return "Reopen the pay period first, saying why, then change the shift.";
    case "roster_changed":
      return "Look over the totals again, then lock it.";
    case "rostering":
    case "forbidden":
      return "The screen has been refreshed to what you may do.";
    case "checklist_closed":
    case "checklist_not_yours":
    case "checklist_not_live":
      return "The checklist has been refreshed.";
    case "checklist_not_your_tick":
      return "Someone else ticked this step: whoever rosters can change it.";
    case "checklist_nothing_to_clear":
      return "That step is not ticked, so there is nothing to clear.";
    case "checklist_window":
      return "A checklist can be ticked from when the shift starts until 2 hours after it ends.";
    default:
      return null;
  }
}

// --- Hooks ---------------------------------------------------------------------------------------

export type { UseMutation, UseQuery } from "@composable-os/client";

/**
 * The operations each hook calls (ADR 0453). A `rostering.team` role's client gets the team's
 * hooks; a coach's role client with the grant `rostering:roster` the same; the staff client all
 * of them (the host still refuses what the account does not hold).
 */
export const ROSTERING_HOOKS_CALL = {
  useMe: ["x.rostering.me"],
  useWeek: ["x.rostering.week"],
  useMine: ["x.rostering.mine"],
  useOffers: ["x.rostering.offers"],
  useOffer: ["x.rostering.offer"],
  useWithdraw: ["x.rostering.withdraw"],
  useTake: ["x.rostering.take"],
  useAway: ["x.rostering.away"],
  useBack: ["x.rostering.back"],
  useMyAway: ["x.rostering.myAway"],
  useMyPayPeriods: ["x.rostering.myPayPeriods"],
  useMyPay: ["x.rostering.myPay"],
  useAssign: ["x.rostering.assign"],
  useCheck: ["x.rostering.check"],
  useCandidates: ["x.rostering.candidates"],
  useFollow: ["x.rostering.follow"],
  usePeople: ["x.rostering.people"],
  usePatterns: ["x.rostering.patterns"],
  useSetPattern: ["x.rostering.setPattern"],
  useQualify: ["x.rostering.qualify"],
  useQualifications: ["x.rostering.qualifications"],
  useAwayFor: ["x.rostering.awayFor"],
  useAwayList: ["x.rostering.awayList"],
  useUncovered: ["x.rostering.uncovered"],
  useMarkNotWorked: ["x.rostering.markNotWorked"],
  usePayBases: ["x.rostering.payBases"],
  usePayBasis: ["x.rostering.payBasis"],
  usePeriods: ["x.rostering.periods"],
  usePeriodTotals: ["x.rostering.periodTotals"],
  useLock: ["x.rostering.lock"],
  useReopen: ["x.rostering.reopen"],
  useExport: ["x.rostering.export"],
  useFeed: ["x.rostering.feed"],
  useFeedRotate: ["x.rostering.feedRotate"],
  useFeedRevoke: ["x.rostering.feedRevoke"],
  useChecklist: ["x.rostering.checklist"],
  useTick: ["x.rostering.tick"],
  useChecklistDone: ["x.rostering.checklistDone"],
  useChecklistRuns: ["x.rostering.checklistRuns"],
  useChecklistCorrect: ["x.rostering.checklistCorrect"],
} as const;

/**
 * Hooks for a React or React Native app:
 * `const rostering = createRosteringHooks({ useQuery, useMutation }, api)`. `api` is the client the
 * screen's user holds: a role client (`roles/rostering.team.ts`, or `roles/bookings.coach.ts`
 * generated with the grant `rostering:roster`) or the staff client. The hooks it cannot back are
 * not there.
 */
export function createRosteringHooks<C extends ClientHolding>(
  react: { useQuery: UseQuery; useMutation: UseMutation },
  client: C,
) {
  return packHooks(client, ROSTERING_HOOKS_CALL, (api: RosteringClient) =>
    allRosteringHooks(react, api),
  );
}

function allRosteringHooks(
  react: { useQuery: UseQuery; useMutation: UseMutation },
  api: RosteringClient,
) {
  const { useQuery, useMutation } = react;
  return {
    /** Who is reading and what the host lets them do (rosters, pays), the zone and today there. */
    useMe() {
      return useQuery(api.query("x.rostering.me", {}));
    },
    /** The roster from..to (local dates); a rosterer's answer carries each shift's warnings. */
    useWeek(input: In<"x.rostering.week">, enabled = true) {
      // A rosterer's roster carries who is away: kept no longer than it is on screen.
      return useQuery({ ...api.query("x.rostering.week", input), enabled, gcTime: 0 });
    },
    /** My own shifts from..to. */
    useMine(input: In<"x.rostering.mine">, enabled = true) {
      return useQuery({ ...api.query("x.rostering.mine", input), enabled });
    },
    /** Offers I could take now, and my own open offers. */
    useOffers() {
      return useQuery(api.query("x.rostering.offers", {}));
    },
    /** Offer a shift (a person's own act). */
    useOffer() {
      return useMutation(api.mutation("x.rostering.offer"));
    },
    /** Withdraw an open offer. */
    useWithdraw() {
      return useMutation(api.mutation("x.rostering.withdraw"));
    },
    /** Take an offered shift; the host may ask to confirm when I said I am away then. */
    useTake() {
      return useMutation(api.mutation("x.rostering.take"));
    },
    /**
     * Say when I cannot work. What I write about it (the note) is not kept once the call is
     * over: call it through `forgetAfter`.
     */
    useAway() {
      return useMutation({ ...api.mutation("x.rostering.away"), gcTime: 0 });
    },
    /** Remove a time off. */
    useBack() {
      return useMutation(api.mutation("x.rostering.back"));
    },
    /** My time off, with my notes: kept no longer than it is on screen. */
    useMyAway(input: In<"x.rostering.myAway"> = {}) {
      return useQuery({ ...api.query("x.rostering.myAway", input), gcTime: 0 });
    },
    /** The pay periods I can see my own hours for: dates and state only. */
    useMyPayPeriods(enabled = true) {
      return useQuery({ ...api.query("x.rostering.myPayPeriods", {}), enabled, gcTime: 0 });
    },
    /**
     * My own hours for one pay period: pay figures, kept no longer than they are on screen. The
     * query's key holds the period's first date only, never a figure.
     */
    useMyPay(input: In<"x.rostering.myPay"> | null) {
      return useQuery({
        ...api.query("x.rostering.myPay", input ?? {}),
        enabled: input !== null,
        gcTime: 0,
      });
    },
    /** A rosterer: put someone (or nobody) on a shift. */
    useAssign() {
      return useMutation(api.mutation("x.rostering.assign"));
    },
    /** A rosterer: what putting someone on a shift would be made with. */
    useCheck(input: In<"x.rostering.check"> | null) {
      return useQuery({
        ...api.query("x.rostering.check", input ?? { object: "", id: "" }),
        enabled: input !== null,
        // A rosterer's warnings say who is away: on this screen only.
        gcTime: 0,
      });
    },
    /** A rosterer: who could be put on a shift, eligible first, with the pattern's person. */
    useCandidates(input: In<"x.rostering.candidates"> | null) {
      return useQuery({
        ...api.query("x.rostering.candidates", input ?? { object: "", id: "" }),
        enabled: input !== null,
        // Who is away is a rosterer's to read, on this screen only.
        gcTime: 0,
      });
    },
    /** A rosterer: a shift back to its pattern's person. */
    useFollow() {
      return useMutation(api.mutation("x.rostering.follow"));
    },
    /** A rosterer: the staff and the kinds of work. */
    usePeople(enabled = true) {
      return useQuery({ ...api.query("x.rostering.people", {}), enabled });
    },
    /** A rosterer: the regular week. */
    usePatterns(enabled = true) {
      return useQuery({ ...api.query("x.rostering.patterns", {}), enabled });
    },
    /** A rosterer: a pattern's person from a date. */
    useSetPattern() {
      return useMutation(api.mutation("x.rostering.setPattern"));
    },
    /** A rosterer: say whether someone may do a kind of work. */
    useQualify() {
      return useMutation(api.mutation("x.rostering.qualify"));
    },
    /** A rosterer: who may do which kind of work. */
    useQualifications(input: In<"x.rostering.qualifications"> = {}, enabled = true) {
      return useQuery({ ...api.query("x.rostering.qualifications", input), enabled });
    },
    /** A rosterer: say someone else is away. The note is forgotten once the call is over. */
    useAwayFor() {
      return useMutation({ ...api.mutation("x.rostering.awayFor"), gcTime: 0 });
    },
    /** A rosterer: everyone's time off, with notes, kept no longer than it is on screen. */
    useAwayList(input: In<"x.rostering.awayList">, enabled = true) {
      return useQuery({ ...api.query("x.rostering.awayList", input), enabled, gcTime: 0 });
    },
    /** A rosterer: shifts with nobody on them. */
    useUncovered(input: In<"x.rostering.uncovered"> = {}, enabled = true) {
      return useQuery({ ...api.query("x.rostering.uncovered", input), enabled });
    },
    /** A rosterer: mark a started shift not worked, with why (forgotten once the call is over). */
    useMarkNotWorked() {
      return useMutation({ ...api.mutation("x.rostering.markNotWorked"), gcTime: 0 });
    },
    /** Pay: who is counted and how (kept no longer than it is on screen). */
    usePayBases(input: In<"x.rostering.payBases">, enabled = true) {
      return useQuery({ ...api.query("x.rostering.payBases", input), enabled, gcTime: 0 });
    },
    /** Pay: say how someone is counted from a date. */
    usePayBasis() {
      return useMutation({ ...api.mutation("x.rostering.payBasis"), gcTime: 0 });
    },
    /** Pay: the periods. */
    usePeriods(input: In<"x.rostering.periods"> = {}, enabled = true) {
      return useQuery({ ...api.query("x.rostering.periods", input), enabled, gcTime: 0 });
    },
    /** Pay: one period's totals and lines (kept no longer than they are on screen). */
    usePeriodTotals(input: In<"x.rostering.periodTotals"> | null) {
      return useQuery({
        ...api.query("x.rostering.periodTotals", input ?? { start: "" }),
        enabled: input !== null,
        gcTime: 0,
      });
    },
    /** Pay: lock a period that has ended. */
    useLock() {
      return useMutation(api.mutation("x.rostering.lock"));
    },
    /** Pay: reopen a locked period with why (forgotten once the call is over). */
    useReopen() {
      return useMutation({ ...api.mutation("x.rostering.reopen"), gcTime: 0 });
    },
    /**
     * Pay: a period's CSV for payroll, fetched when asked and never cached: the screen hands it
     * to the person (a download, a share sheet) and keeps nothing.
     */
    useExport() {
      return useMutation({
        mutationKey: ["x.rostering.export"],
        mutationFn: (input: In<"x.rostering.export">) =>
          api.query("x.rostering.export", input).queryFn(),
        gcTime: 0,
      });
    },
    /** Whether I have a calendar feed (never its address). */
    useFeed() {
      return useQuery(api.query("x.rostering.feed", {}));
    },
    /**
     * A new calendar address (any old one stops working): shown once, as https and webcal on the
     * host this client talks to (its `baseUrl`), never on an address the page was given. Call it
     * through `forgetAfter`, keep the address only on screen, and forget it on leaving.
     */
    useFeedRotate() {
      const rotate = api.mutation("x.rostering.feedRotate");
      return useMutation({
        mutationKey: rotate.mutationKey,
        mutationFn: async (input: In<"x.rostering.feedRotate">) => {
          if (!api.baseUrl)
            throw new Error("This client has no host address to show the calendar on.");
          const made = await rotate.mutationFn(input);
          return { ...feedAddresses(api.baseUrl, made.path), createdAt: made.createdAt };
        },
        gcTime: 0,
      });
    },
    /** Turn my calendar feed off. */
    useFeedRevoke() {
      return useMutation(api.mutation("x.rostering.feedRevoke"));
    },
    /**
     * A shift's checklist, its ticks and notes: its person's and whoever rosters' only, kept no
     * longer than it is on screen.
     */
    useChecklist(input: In<"x.rostering.checklist"> | null) {
      return useQuery({
        ...api.query("x.rostering.checklist", input ?? { object: "", id: "" }),
        enabled: input !== null,
        gcTime: 0,
      });
    },
    /**
     * Tick a step (a person's own act). What is written on it is forgotten once the call is over:
     * call it through `forgetAfter`.
     */
    useTick() {
      return useMutation({ ...api.mutation("x.rostering.tick"), gcTime: 0 });
    },
    /** Mark a checklist done: final. Why, for someone else's, is forgotten once the call is over. */
    useChecklistDone() {
      return useMutation({ ...api.mutation("x.rostering.checklistDone"), gcTime: 0 });
    },
    /** A rosterer: how checklists went, by checklist and date (on screen only). */
    useChecklistRuns(input: In<"x.rostering.checklistRuns"> | null) {
      return useQuery({
        ...api.query("x.rostering.checklistRuns", input ?? { from: "", to: "" }),
        enabled: input !== null,
        gcTime: 0,
      });
    },
    /** A rosterer: a correction beside a closed checklist (forgotten once the call is over). */
    useChecklistCorrect() {
      return useMutation({ ...api.mutation("x.rostering.checklistCorrect"), gcTime: 0 });
    },
  };
}

/** Every hook of this entry. A block takes the ones it calls: `Pick<RosteringHooks, "useWeek">`. */
export type RosteringHooks = ReturnType<typeof allRosteringHooks>;
