// Rostering (stage 45 step 4, ADR 0626): who works when. Duties that are not classes (cleaning,
// opening up), the weekly pattern of each (a duty series and its regular person), the dated duty
// shifts the host makes from it, and the roster's tools over every shift on the host: Bookings'
// classes too, when it is installed, through the host's own read. It requires nothing: a business
// with shifts and no classes uses it alone, and a cleaner is not a coach.
//
// Everything that is a rule is the host's, declared here (ADR 0404):
//   - a duty series makes its shifts ahead in local time across clock changes (`recurring`, ADR
//     0500), as far ahead as the duty horizon setting says (8 weeks by default, decision 17); a
//     person or time changed by hand on one date stays that date's own (ADR 0620);
//   - a duty shift is its person's shift (`staffed`, ADR 0621): one staff account is never on two
//     overlapping shifts, classes and duties alike, refused by the database for every writer, and
//     each write answers its warnings (away, not qualified for the duty, nobody on it);
//   - offers, takes, the cut-off, unavailability, qualifications, the notices and who may roster
//     are the host's (ADRs 0622 to 0625), read from this pack's settings (`staffing`);
//   - who is on a duty shift, and a duty series' regular person, are a person's to change
//     (`personApproves`): an assistant's change waits for a person.
// The tools in tools.ts compose the host's tool-only `staffing.*` operations and add no rules.
//
// Who may do what (the permissions are the pack's, ADRs 0600 and 0625):
//   - `rostering:team`: the team role's (a cleaner with no other access): the roster, their own
//     shifts, offers and takes, their unavailability;
//   - `rostering:roster`: the same tools, grantable, for an account with another role (a coach's
//     `bookings.coach`); ordinary staff hold the tools anyway;
//   - `rostering:manage`: restricted, held by admins and by grant only (decision 16, nobody at
//     first): put people on shifts, qualifications, others' unavailability, the uncovered shifts,
//     marking a shift not worked. Its holders are the rosterers the host tells and lets roster
//     (`staffing.rosters`);
//   - `rostering:pay` (step 6, ADR 0627): restricted, held by admins and by grant only: who is
//     counted for pay, the pay periods' totals, lock, reopen and export. Every pay tool is a
//     person's only (`humanOnly`): an assistant never reads or changes pay, whatever is granted.
//     The host holds no rates and no money: hours and counts, which payroll applies rates to.
// The screens (step 7) are this pack's blocks (blocks/) over its headless entry (client/): they
// show what the tools answer and decide nothing. Not yet: the checklist on a duty (step 4b) and
// the calendar feed (step 5).
import { defineExtension } from "@composable-os/sdk";
import {
  assign,
  away,
  awayFor,
  awayList,
  back,
  candidates,
  check,
  exportPeriod,
  follow,
  lock,
  markNotWorked,
  me,
  mine,
  myAway,
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
  uncovered,
  week,
  withdraw,
} from "./tools.ts";

const WEEKDAYS = [
  { value: "mon", label: "Monday" },
  { value: "tue", label: "Tuesday" },
  { value: "wed", label: "Wednesday" },
  { value: "thu", label: "Thursday" },
  { value: "fri", label: "Friday" },
  { value: "sat", label: "Saturday" },
  { value: "sun", label: "Sunday" },
];

const COLOURS = ["slate", "red", "orange", "amber", "green", "teal", "blue", "violet", "pink"].map(
  (value) => ({ value, label: value[0]?.toUpperCase() + value.slice(1) }),
);

export default defineExtension({
  id: "rostering",
  version: "0.1.0",
  contractVersion: 1,
  label: "Rostering",
  description:
    "Who works when: duties that are not classes, their weekly pattern and dated shifts, and the " +
    "roster of every shift, with offers, takes and time off.",
  permissions: {
    operations: [
      "staffing.week",
      "staffing.check",
      "staffing.assign",
      "staffing.offer",
      "staffing.withdraw",
      "staffing.take",
      "staffing.offers",
      "staffing.away",
      "staffing.back",
      "staffing.awayList",
      "staffing.qualify",
      "staffing.qualifications",
      "staffing.uncovered",
      "staffing.markNotWorked",
      "staffing.payBasis",
      "staffing.payBases",
      "staffing.payPeriod.list",
      "staffing.payPeriod.totals",
      "staffing.payPeriod.lock",
      "staffing.payPeriod.reopen",
      "staffing.payPeriod.export",
      "staffing.me",
      "staffing.candidates",
      "staffing.people",
      "staffing.patterns",
      "staffing.setPattern",
      "staffing.follow",
      "staffing.planCheck",
    ],
    modules: ["ops"],
  },
  objects: {
    duty: {
      label: "Duty",
      plural: "Duties",
      icon: "clipboard-list",
      titleField: "name",
      description:
        "A kind of work that is not a class: cleaning, opening up. Its shifts are made by duty " +
        "series; who may do it is a qualification.",
      navigation: "settings",
      fields: {
        name: { type: "text", label: "Name", required: true },
        colour: { type: "select", label: "Colour", options: COLOURS },
        lengthMinutes: {
          type: "number",
          label: "Usual length (minutes)",
          min: 5,
          max: 1440,
          step: 1,
          default: 60,
        },
        place: { type: "text", label: "Where" },
        instructions: { type: "longText", label: "What to do" },
        active: { type: "boolean", label: "Active", default: true },
      },
    },
    dutyseries: {
      label: "Duty series",
      plural: "Duty series",
      icon: "calendar-sync",
      titleField: "title",
      titleDefault: { from: ["duty"] },
      description:
        "A duty on chosen weekdays at a local time, from a date, with its regular person. The " +
        "host makes its shifts ahead.",
      navigation: "main",
      navigationOrder: 41,
      fields: {
        title: { type: "text", label: "Title" },
        duty: { type: "relation", label: "Duty", to: "rostering.duty", required: true },
        weekdays: { type: "multiSelect", label: "Weekdays", options: WEEKDAYS, required: true },
        time: {
          type: "text",
          label: "Starts at (local time)",
          description: "HH:MM in the series' time zone, e.g. 18:00.",
          required: true,
        },
        length: {
          type: "number",
          label: "Length (minutes)",
          required: true,
          min: 5,
          max: 1440,
          step: 1,
        },
        firstDate: { type: "date", label: "First date", required: true },
        lastDate: { type: "date", label: "Last date", description: "Empty: ongoing." },
        timezone: { type: "timezone", label: "Time zone" },
        // The pattern's person: a person's to change (an assistant's change waits for a person).
        staff: {
          type: "user",
          label: "Regular person",
          description: "Who works it every week. Empty: each shift is made with nobody on it.",
          personApproves: true,
        },
        state: {
          type: "select",
          label: "State",
          track: "timeline",
          options: [
            { value: "active", label: "Active" },
            { value: "ended", label: "Ended" },
          ],
        },
      },
      states: {
        field: "state",
        initial: "active",
        moves: [{ from: "active", to: "ended", by: ["staff"], final: true }],
      },
      recurring: {
        generates: "shift",
        link: "series",
        rule: {
          weekdays: "weekdays",
          time: "time",
          length: "length",
          from: "firstDate",
          until: "lastDate",
          zone: "timezone",
        },
        into: { starts: "startsAt", ends: "endsAt", zone: "timezone", changed: "changed" },
        copy: { title: "title", duty: "duty", staff: "staff" },
        cancel: "cancelled",
        ended: { field: "state", in: ["ended"] },
        // Eight weeks ahead (decision 17), unless the duty horizon setting says otherwise.
        horizonDays: 56,
        horizonSetting: "dutyHorizonDays",
      },
      indexes: [["state"], ["duty"]],
    },
    shift: {
      label: "Duty shift",
      plural: "Duty shifts",
      icon: "calendar-clock",
      titleField: "title",
      titleDefault: { from: ["duty"] },
      description:
        "One dated duty shift: made by a duty series, or a one-off. Its person works it; nobody " +
        "is ever on two shifts at once.",
      navigation: "main",
      navigationOrder: 40,
      fields: {
        title: { type: "text", label: "Title" },
        duty: { type: "relation", label: "Duty", to: "rostering.duty", required: true },
        series: {
          type: "relation",
          label: "Duty series",
          to: "rostering.dutyseries",
          readOnly: true,
          description: "The series that made it. Empty for a one-off shift.",
        },
        startsAt: { type: "datetime", label: "Starts", required: true },
        endsAt: { type: "datetime", label: "Ends", required: true },
        // Left empty, the organisation's zone (ADR 0460).
        timezone: { type: "timezone", label: "Time zone", required: true },
        // Who works it: a person's to change (ADR 0626). Empty: nobody (uncovered).
        staff: { type: "user", label: "Person", personApproves: true },
        notes: { type: "longText", label: "Notes" },
        state: {
          type: "select",
          label: "State",
          track: "timeline",
          options: [
            { value: "scheduled", label: "Scheduled" },
            { value: "cancelled", label: "Cancelled" },
          ],
        },
        changed: {
          type: "boolean",
          label: "Changed from its series",
          readOnly: true,
          description:
            "Moved, or its state changed, by hand: its series no longer changes it. A person " +
            "changed by hand alone stays this shift's own, and later changes to its series still " +
            "reach the rest.",
        },
      },
      states: {
        field: "state",
        initial: "scheduled",
        moves: [
          { from: "scheduled", to: "cancelled", by: ["staff", "host"] },
          { from: "cancelled", to: "scheduled", by: ["staff"] },
        ],
      },
      // A duty shift is its person's shift (ADR 0621): the time claim, the warnings, offers and
      // takes are the host's, across classes and duties alike.
      staffed: {
        who: { field: "staff" },
        starts: "startsAt",
        ends: "endsAt",
        zone: "timezone",
        kind: "duty",
        live: ["scheduled"],
        place: "duty.place",
        pattern: { link: "series", who: "staff" },
      },
      indexes: [["startsAt"], ["staff"], ["state", "startsAt"], ["series"]],
    },
  },
  views: {
    shifts: {
      label: "Duty shifts",
      object: "rostering.shift",
      sort: { field: "startsAt", direction: "asc" },
      columns: ["title", "startsAt", "endsAt", "staff", "state", "changed"],
    },
    series: {
      label: "Duty series",
      object: "rostering.dutyseries",
      columns: ["title", "duty", "weekdays", "time", "length", "staff", "firstDate", "state"],
    },
  },
  // The roster's numbers (decisions 17 and 21; the uncovered window a guess): a person's to change.
  settings: {
    offerCutoffMinutes: {
      type: "number",
      label: "Offers close (minutes before a shift)",
      description:
        "A shift can be offered and taken in the app until this many minutes before it starts; " +
        "then its offer lapses and whoever rosters reassigns it.",
      default: 60,
      min: 0,
      max: 1440,
      personApproves: true,
    },
    uncoveredDays: {
      type: "number",
      label: "Warn about shifts with nobody on them (days ahead)",
      description:
        "Whoever rosters hears of shifts with nobody on them this many days ahead, every morning " +
        "and at once when one becomes uncovered.",
      default: 14,
      min: 1,
      max: 62,
      personApproves: true,
    },
    dutyHorizonDays: {
      type: "number",
      label: "Duty shifts are made (days ahead)",
      description: "How far ahead each duty series' shifts are made: 56 days is eight weeks.",
      default: 56,
      min: 7,
      max: 120,
      personApproves: true,
    },
    // The pay period (decision 20, ADR 0627): fortnightly by default, from a date the business
    // chooses (until it is set, nothing is totalled), or monthly from a day of the month.
    payPeriod: {
      type: "select",
      label: "Pay period",
      description: "How long each pay period is. Totals are made per period, for payroll.",
      options: [
        { value: "weekly", label: "Weekly" },
        { value: "fortnightly", label: "Fortnightly" },
        { value: "monthly", label: "Monthly" },
      ],
      default: "fortnightly",
      personApproves: true,
    },
    payPeriodStart: {
      type: "text",
      label: "A pay period starts on (weekly or fortnightly)",
      description:
        "The date one pay period starts, YYYY-MM-DD (it fixes the weekday). Until it is set, " +
        "nothing is totalled.",
      personApproves: true,
    },
    payPeriodDay: {
      type: "number",
      label: "A monthly pay period starts on day",
      description: "The day of the month each monthly pay period starts, 1 to 28.",
      default: 1,
      min: 1,
      max: 28,
      personApproves: true,
    },
  },
  // The host's roster rules read these (ADRs 0626 and 0627): who rosters, who handles pay, and
  // the settings above.
  staffing: {
    rosters: "rostering:manage",
    pays: "rostering:pay",
    settings: {
      offerCutoffMinutes: "offerCutoffMinutes",
      uncoveredDays: "uncoveredDays",
      payPeriod: "payPeriod",
      payPeriodStart: "payPeriodStart",
      payPeriodDay: "payPeriodDay",
    },
  },
  // Someone rostered who has no other access (a cleaner): the roster and their own shifts, offers
  // and takes, their time off, nothing else (ADR 0436). No record reads: only its tools.
  roles: {
    team: {
      label: "Rostered team",
      description:
        "Sees the roster and their own shifts, offers and takes shifts, and says when they are " +
        "away. Nothing else: no records, no people, no settings.",
      permissions: ["rostering:team"],
      read: [],
    },
  },
  // The team's tools for an account with another role (a coach), and the rosterers' permission
  // (decision 16: the owner and admins hold it; it is granted to nobody at first).
  grantable: ["rostering:roster", "rostering:manage", "rostering:pay"],
  grantableLabels: {
    "rostering:roster":
      "Rostering: see the roster and their own shifts, offer and take shifts, and say when they " +
      "are away. For a coach or anyone with another role who is rostered.",
    "rostering:manage":
      "Rostering, rosters others: put people on shifts, say who may do which work, record " +
      "others' time off and see everyone's, see shifts with nobody on them, and mark a shift not " +
      "worked. Admins hold it.",
    "rostering:pay":
      "Rostering, pay: say who is counted for pay, see each pay period's hours and shifts, lock, " +
      "reopen and export them for payroll. No rates or money are held. Admins hold it.",
  },
  // Held by admins and by grant only (ADR 0625): a member does not hold the rosterers' tools or
  // pay.
  restricted: ["rostering:manage", "rostering:pay"],
  tools: {
    me,
    week,
    mine,
    offers,
    offer,
    withdraw,
    take,
    away,
    back,
    myAway,
    assign,
    check,
    qualify,
    qualifications,
    awayFor,
    awayList,
    uncovered,
    markNotWorked,
    candidates,
    follow,
    people,
    patterns,
    setPattern,
    planCheck,
    payBasis,
    payBases,
    periods,
    periodTotals,
    lock,
    reopen,
    export: exportPeriod,
  },
});
