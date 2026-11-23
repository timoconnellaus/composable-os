// Bookings (stage 31a, build steps 3 to 5 and 7: the spine, spending, the waitlist, and
// attendance, moves and cancelling a class; ADRs 0504, 0520 and 0553): a gym's or studio's
// timetable and the
// bookings members make on it. Staff set a weekly timetable once (series), the host makes each
// week's classes from it, and members book and cancel them on the web and in the app.
//
// Everything that is a rule is the host's, declared here as behaviours (ADR 0404):
//   - a series makes its classes ahead in local time across clock changes (`recurring`, ADR 0500),
//     never less far ahead than the longest booking window a class type sets (`horizonAtLeast`),
//     never on a closure's dates, and never over what staff changed by hand on a class (a coach
//     swapped stays swapped while the series' new room or time still reaches it, ADR 0620);
//   - a class has places (`capacity`), and a booking holds one by its state (`claims`, ADR 0501),
//     refused by the database past the places, for every actor;
//   - one live booking per Person per class (`unique`, ADR 0502);
//   - when a customer may book (from the class type's "opens" days before, else the
//     organisation's; until its "closes" minutes before) and cancel in time (until its "late from"
//     minutes before; late until the start; then not at all), and which class types only staff
//     book, are windows and staff-only rules on the booking's states (ADR 0503), worked out from
//     the class type's own value or the organisation's setting (ADR 0505). A member's "cancel" is
//     a requested move the host resolves to `cancelled` or `late_cancelled` by its clock;
//   - a booking entering `booked` spends a use of its Person's membership or pass and an in-time
//     cancel gives it back (`allowance`, ADRs 0493 and 0494), unless staff booked it paid at the
//     desk (`waived`, ADR 0506). The holders are the Memberships pack's (stage 32b);
//   - a member joins a full class's waitlist, spending nothing; a place given back before the
//     class type's "waitlist stops" time goes to the waitlist in the same batch, and the host
//     moves the first waiter in, spending their use then, or passes them over when nothing they
//     hold can pay (`claims.waitlist`, ADR 0520; step 5);
//   - a visitor, or a member with nothing to spend, pays for one class on the web (a drop-in,
//     decision 8): the host makes the booking held while its order is unpaid, priced from the
//     class type's drop-in price or the organisation's, booked when the payment is verified and
//     released when the order expires; a paid drop-in cancelled in time or by the gym owes the
//     money back, which a person approves (`sellable.moves`, ADR 0560; step 8);
//   - members read the timetable and how many places are left, never who is booked (decision 13);
//   - a coach ticks names from an hour before the class (a window that binds staff, ADR 0551);
//     of two ticks at once one is made (ADR 0437); 30 minutes after a class ends, the host makes
//     its still-booked bookings no-shows, only if someone on it was ticked (`states.after`,
//     ADR 0550). A no-show keeps its use;
//   - staff move a booking to another class by making the new one (`movedFrom`): the old one is
//     moved, its place given back and its use spent again on the new one, in one batch, refused
//     whole when the new class is full or the use cannot be spent (ADRs 0493 and 0551);
//   - staff cancel a class (a person's act, or a person approves an AI's request, ADR 0552), and
//     every booked, waiting and held booking of it is cancelled in the same batch (ADR 0507);
//   - the coach role (`roles`, ADR 0436): the day's classes, their lists, and ticking names;
//   - a class is its coach's shift (`staffed`, stage 45, ADR 0621): one staff account is never
//     on two overlapping shifts, refused by the database for every writer, and a write of a
//     class answers its warnings (the coach away or not qualified, a class with no coach).
// The tools in tools.ts compose the host's operations and add no rules of their own. The messages
// in automations.ts (step 9, ADR 0572) email members and their guardians through the email-send
// gatekeeper on what the host did: booked, moved in, passed over, a place free after the cut-off,
// a class changed or cancelled by the gym, the reminder before a class (a date-relative trigger
// in minutes, ADR 0570) with an add-to-calendar file (ADR 0571), a drop-in's refund made; and
// tell staff of a class whose list was not taken. They write nothing.
import { defineExtension } from "@composable-os/sdk";
import { bookingsAutomations } from "./automations.ts";
import { bookingsDashboards } from "./dashboards.ts";
import { bookingsRoutineMail } from "./routine-mail.ts";
import {
  book,
  bookFor,
  buy,
  cancel,
  cancelClass,
  cancelFor,
  classGet,
  classList,
  day,
  family,
  findPeople,
  leaveWaitlist,
  markAll,
  markAttended,
  markNoShow,
  mine,
  move,
  returnUse,
  roster,
  timetable,
  undoAttended,
} from "./tools.ts";

/** Weekday values a series' `weekdays` uses (ADR 0500). */
const WEEKDAYS = [
  { value: "mon", label: "Monday" },
  { value: "tue", label: "Tuesday" },
  { value: "wed", label: "Wednesday" },
  { value: "thu", label: "Thursday" },
  { value: "fri", label: "Friday" },
  { value: "sat", label: "Saturday" },
  { value: "sun", label: "Sunday" },
];

/** A booking's states (spec 31, "Booking states"). Only some are reachable at this step. */
const BOOKING_STATES = [
  { value: "booked", label: "Booked" },
  { value: "pending", label: "Held while paying" },
  { value: "waiting", label: "Waiting" },
  { value: "left", label: "Left the waitlist" },
  { value: "cancelled", label: "Cancelled" },
  { value: "late_cancelled", label: "Cancelled late" },
  { value: "excused", label: "Cancelled, class given back" },
  { value: "attended", label: "Attended" },
  { value: "no_show", label: "No-show" },
  { value: "cancelled_by_us", label: "Cancelled by the gym" },
  { value: "moved", label: "Moved" },
  { value: "expired", label: "Expired" },
];

/** What a class the gym cancels cancels with it: every booking holding a place or a use. */
const FOLLOW_CANCEL = ["booked", "waiting", "pending", "attended", "no_show", "late_cancelled"];

/** A booking that holds or takes a place, and so counts as the Person's one for its class. */
const ACTIVE = ["pending", "booked", "waiting", "attended", "no_show"];

/** When a customer may book, and when a cancel is late, from the class type or the org. */
const opens = {
  at: "class.startsAt",
  daysBefore: { field: "class.classType.opensDays", setting: "opensDays" },
  zone: "class.timezone",
};
const closes = {
  at: "class.startsAt",
  minutesBefore: { field: "class.classType.closesMinutes", setting: "closesMinutes" },
};
const lateFrom = {
  at: "class.startsAt",
  minutesBefore: { field: "class.classType.lateMinutes", setting: "lateMinutes" },
};
/** A class's list opens for ticking an hour before it starts (guess: people arrive early). */
const listOpens = { at: "class.startsAt", minutesBefore: 60 };

// A booking rule is a person's to change (spec 31: "Change the booking rules: a person only"):
// set by the assistant, an MCP client, an automation or extension code, it waits for a person's
// approval (`personApproves`, ADR 0507).
const minutes = (label: string, description: string) => ({
  type: "number" as const,
  label,
  description,
  min: 0,
  max: 10_080,
  step: 1,
  personApproves: true,
});

export default defineExtension({
  id: "bookings",
  version: "0.1.0",
  contractVersion: 1,
  label: "Bookings",
  description:
    "A timetable of classes made from weekly series, rooms and coaches, and the bookings members " +
    "make and cancel within the gym's rules. Class types are Programs'.",
  // The class type is Programs' (spec 31): the host installs Bookings only beside Programs.
  requires: ["programs"],
  permissions: {
    // person.get / person.create: a booking's person on a class list, and a walk-in staff book.
    // programs.classtype: a class type's name and booking rules on staff's day view.
    read: ["person", "programs.classtype"],
    write: ["person"],
    // record.*, my.* and state.resolve are not listed: they are granted by object (Bookings'
    // own, and the read and write lists above), and a listed one would reach every object.
    // duplicate.check: a walk-in is checked against the People on file before one is made.
    // waitlist.position: where a waiter stands in the queue (a member: their own only).
    // me.family: the member's own id, and the children staff linked to them (ADR 0540).
    // order.startHeld: a drop-in, the booking made with its order by the host (ADR 0560).
    // The messages (automations.ts): order.get (whether a drop-in was paid), extensionSettings.list
    // (the waiting list's cut-off), notification.send (staff told of a class whose list was not
    // taken); person.link.list, a child's live guardians on staff's screens. routine-mail, the
    // members' email (routine-mail.ts, ADR 0590: the host decides who it goes to and what it
    // says), sent from the email-send connection a person binds to each automation; storage,
    // which class changes are still to be told (several edits within two minutes make one email).
    // agreement.listHealthNotes: the "health note" mark beside a name on a class list (stage 44,
    // decision 18), a yes or no per Person on the class's bookings (the host reads them) and
    // nothing of the form; the host gives it only when a person called the tool themselves.
    operations: [
      "order.startHeld",
      "public.list",
      "public.get",
      "capacity.get",
      "duplicate.check",
      "waitlist.position",
      "me.family",
      "person.link.list",
      "order.get",
      "extensionSettings.list",
      "notification.send",
      "agreement.listHealthNotes",
    ],
    modules: ["ops", "routine-mail", "email-send", "storage"],
  },
  // Bookings' fields on Programs' class type: how it shows, and its booking rules when they
  // differ from the organisation's (Settings → Extensions → Bookings). Empty: the organisation's.
  fields: {
    "programs.classtype": {
      colour: {
        type: "text",
        label: "Colour",
        description: "How its classes show on the timetable, e.g. #2f6fed.",
      },
      opensDays: {
        type: "number",
        label: "Booking opens (days before)",
        description:
          "Members may book this many days before a class, at the same time of day. Empty: the " +
          "organisation's setting.",
        min: 0,
        max: 365,
        step: 1,
        personApproves: true,
      },
      closesMinutes: minutes(
        "Booking closes (minutes before)",
        "Members may book until this many minutes before a class starts (0: until it starts). " +
          "Empty: the organisation's setting.",
      ),
      lateMinutes: minutes(
        "Late cancel from (minutes before)",
        "A cancel this close to the start or closer is late and keeps the class it used. Empty: " +
          "the organisation's setting.",
      ),
      promotionMinutes: minutes(
        "Waitlist stops (minutes before)",
        "Nobody is moved in from the waitlist after this: a place freed later goes to whoever " +
          "books first. Empty: the organisation's setting.",
      ),
      reminderMinutes: {
        ...minutes(
          "Reminder (minutes before)",
          "When members booked into a class are emailed a reminder, at most two days before. " +
            "Empty: the organisation's setting.",
        ),
        // At most two days: the reminder's minute scan reads the classes this far ahead (ADR 0570).
        max: 2_880,
      },
      dropInPrice: {
        type: "number",
        label: "Drop-in price",
        description:
          "What one class costs someone paying for it on the website, in the organisation's " +
          "currency. Empty: the organisation's setting; empty there too, no drop-ins.",
        min: 0,
        max: 100_000,
        step: 0.01,
        personApproves: true,
      },
      staffOnly: {
        type: "boolean",
        label: "Booked by staff only",
        description: "Members cannot book its classes themselves; staff book them in.",
        personApproves: true,
      },
    },
  },
  objects: {
    room: {
      label: "Room",
      plural: "Rooms",
      icon: "door-open",
      titleField: "name",
      description: "Where classes are held.",
      navigation: "settings",
      fields: {
        name: { type: "text", label: "Name", required: true },
        places: {
          type: "number",
          label: "Places",
          description: "The most the room holds: a guide for staff, not a limit on a class.",
          min: 0,
          step: 1,
        },
        notes: { type: "longText", label: "Notes" },
      },
      public: { read: ["name"] },
    },
    coach: {
      label: "Coach",
      plural: "Coaches",
      icon: "user-round",
      titleField: "name",
      description: "Who teaches classes. Name, photo and bio are shown on the timetable.",
      navigation: "settings",
      fields: {
        name: { type: "text", label: "Name", required: true },
        photo: { type: "url", label: "Photo" },
        bio: { type: "longText", label: "Short bio" },
        user: {
          type: "user",
          label: "Staff account",
          description: "Their staff account, if they have one (a visiting coach may not).",
        },
        active: { type: "boolean", label: "Active", default: true },
      },
      // One coach profile per staff account (stage 45, ADR 0621): the host writes the right
      // profile when a shift changes hands, and an account's classes are its profile's.
      unique: [{ fields: ["user"] }],
      public: { read: ["name", "photo", "bio"] },
    },
    series: {
      label: "Series",
      plural: "Series",
      icon: "calendar-sync",
      titleField: "title",
      titleDefault: { from: ["classType"] },
      description:
        "One line of the timetable: a class type on chosen weekdays at a local time, from a " +
        "date. The host makes its classes ahead.",
      navigation: "main",
      navigationOrder: 31,
      fields: {
        title: { type: "text", label: "Title" },
        classType: {
          type: "relation",
          label: "Class type",
          to: "programs.classtype",
          required: true,
        },
        weekdays: { type: "multiSelect", label: "Weekdays", options: WEEKDAYS, required: true },
        time: {
          type: "text",
          label: "Starts at (local time)",
          description: "HH:MM in the series' time zone, e.g. 06:00.",
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
        room: { type: "relation", label: "Room", to: "bookings.room" },
        coach: { type: "relation", label: "Coach", to: "bookings.coach" },
        places: { type: "number", label: "Places", required: true, min: 0, step: 1 },
        firstDate: { type: "date", label: "First date", required: true },
        lastDate: { type: "date", label: "Last date", description: "Empty: ongoing." },
        timezone: { type: "timezone", label: "Time zone" },
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
        generates: "class",
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
        copy: {
          title: "title",
          classType: "classType",
          room: "room",
          coach: "coach",
          places: "places",
        },
        cancel: "cancelled",
        ended: { field: "state", in: ["ended"] },
        closures: { object: "closure", from: "fromDate", until: "untilDate" },
        // The organisation's "opens" setting is at most 56 days; a class 56 days out must exist
        // when its booking opens, so one day more (as horizonAtLeast adds for a class type's).
        horizonDays: 57,
        // Never less than the longest window a class type opens booking (ADR 0500, 0505).
        horizonAtLeast: { object: "programs.classtype", field: "opensDays" },
      },
      indexes: [["state"], ["classType"]],
    },
    class: {
      label: "Class",
      plural: "Classes",
      icon: "calendar-clock",
      titleField: "title",
      titleDefault: { from: ["classType"] },
      description:
        "One dated class: made by a series, or a one-off. Members book its places; its record " +
        "page is its list.",
      navigation: "main",
      navigationOrder: 30,
      fields: {
        title: { type: "text", label: "Title" },
        series: {
          type: "relation",
          label: "Series",
          to: "bookings.series",
          readOnly: true,
          description: "The series that made it. Empty for a one-off class.",
        },
        classType: {
          type: "relation",
          label: "Class type",
          to: "programs.classtype",
          required: true,
        },
        startsAt: { type: "datetime", label: "Starts", required: true },
        // Required (step 7): no-shows are written after it, and a class is cancelled only before.
        endsAt: { type: "datetime", label: "Ends", required: true },
        // Left empty, the organisation's zone (ADR 0460): a class always has one.
        timezone: { type: "timezone", label: "Time zone", required: true },
        room: { type: "relation", label: "Room", to: "bookings.room" },
        coach: { type: "relation", label: "Coach", to: "bookings.coach" },
        // Required: a class is never unlimited by leaving its places empty.
        places: { type: "number", label: "Places", required: true, min: 0, step: 1 },
        notes: { type: "longText", label: "Notes for members" },
        state: {
          type: "select",
          label: "State",
          track: "timeline",
          options: [
            { value: "scheduled", label: "Scheduled" },
            { value: "cancelled", label: "Cancelled" },
            { value: "done", label: "Done" },
          ],
        },
        changed: {
          type: "boolean",
          label: "Changed from its series",
          readOnly: true,
          description:
            "Moved, or its state changed, by hand: its series no longer changes it. A field " +
            "changed by hand alone (another coach that day) stays this class's own, and later " +
            "changes to its series still reach the rest.",
        },
        cancelledReason: {
          type: "longText",
          label: "Why it was cancelled",
          readOnly: true,
          description: "The reason staff gave when they cancelled the class.",
        },
        // A class that is not scheduled cannot be booked by a member (the booking's create rule).
        closed: {
          type: "formula",
          label: "Closed to members",
          expression: 'coalesce(state, "scheduled") != "scheduled"',
        },
      },
      states: {
        field: "state",
        initial: "scheduled",
        moves: [
          // The host cancels a class (a closure, a series ended, each confirmed by a person, ADR
          // 0500), and so does cancelClass: a person's act, or an AI's request a person approves
          // (ADR 0552). No other staff write cancels one. Its bookings follow in the same batch.
          // Only until the class ends (binding the tool's staff write; the host is not bound): a
          // class that happened is not cancelled afterwards, so no-shows never sit on one.
          {
            from: "scheduled",
            to: "cancelled",
            by: ["host"],
            tools: ["cancelClass"],
            window: { until: "endsAt" },
            bindsStaff: true,
            final: true,
          },
          { from: "scheduled", to: "done", by: ["staff", "host"], final: true },
        ],
      },
      // Members see how many places are left (decision 13), never who has them.
      capacity: { places: "places", show: "exact" },
      // A class is a shift its coach works (stage 45, ADR 0621): the host refuses one staff
      // account on two overlapping shifts (two classes, a class and a duty), for every writer, and
      // answers a write with its warnings (the coach away or not qualified, a class with no
      // coach). A coach profile with no account (a visiting coach) covers the class for members
      // and claims nobody's time. A class done still counts (pay reads it); a cancelled one not.
      staffed: {
        who: { field: "coach", account: "user" },
        starts: "startsAt",
        ends: "endsAt",
        zone: "timezone",
        kind: "classType",
        live: ["scheduled", "done"],
        place: "room.name",
        pattern: { link: "series", who: "coach" },
      },
      public: {
        read: [
          "title",
          "classType",
          "startsAt",
          "endsAt",
          "timezone",
          "room",
          "coach",
          "notes",
          "state",
        ],
        when: { field: "state", in: ["scheduled"] },
      },
      // A booking's member reads their class whatever its state (a cancelled one says so).
      customerVia: {
        from: "bookings.booking",
        field: "class",
        read: [
          "title",
          "classType",
          "startsAt",
          "endsAt",
          "timezone",
          "room",
          "coach",
          "notes",
          "state",
        ],
      },
      indexes: [
        ["startsAt"],
        ["state", "startsAt"],
        ["series"],
        ["classType", "startsAt"],
        ["endsAt"],
      ],
    },
    closure: {
      label: "Closure",
      plural: "Closures",
      icon: "calendar-x",
      titleField: "name",
      description:
        "Dates the gym is closed (holidays): no classes are made on them, and classes already " +
        "made are cancelled (a person confirms when any have bookings).",
      navigation: "settings",
      fields: {
        name: { type: "text", label: "Reason", required: true },
        fromDate: { type: "date", label: "From", required: true },
        untilDate: { type: "date", label: "Until", required: true },
      },
    },
    booking: {
      label: "Booking",
      plural: "Bookings",
      icon: "calendar-check",
      titleField: "title",
      titleDefault: { from: ["person"] },
      description: "One person's place in one class.",
      navigation: "main",
      navigationOrder: 32,
      fields: {
        title: { type: "text", label: "Title" },
        class: { type: "relation", label: "Class", to: "bookings.class", required: true },
        // Set on every booking but a guest's drop-in held while unpaid, which is nobody's until the
        // payment is verified (`sellable.moves.guest`: the host keeps it set in every other state).
        person: { type: "relation", label: "Person", to: "person" },
        state: { type: "select", label: "State", track: "timeline", options: BOOKING_STATES },
        holder: {
          type: "text",
          label: "Paid from",
          description:
            "The membership or pass the booking spent a use of (its id). Left empty, the host " +
            "chooses the one whose use would lapse first.",
        },
        classType: {
          type: "relation",
          label: "Class type",
          to: "programs.classtype",
          readOnly: true,
          description: "The class's type, copied by the host: what a membership's limits read.",
        },
        weekday: {
          type: "number",
          label: "Weekday",
          readOnly: true,
          description: "The class's local weekday (1 Monday to 7 Sunday), set by the host.",
        },
        minute: {
          type: "number",
          label: "Local minute",
          readOnly: true,
          description: "The class's local start, in minutes after midnight, set by the host.",
        },
        paidOtherwise: {
          type: "boolean",
          label: "Paid another way",
          readOnly: true,
          description:
            "Paid at the desk (a walk-in staff booked) or as a drop-in on the website: it " +
            "spends no use. Set when it is made.",
        },
        // A drop-in (ADR 0560): what it cost and its order, written by the host at the buy.
        dropInPrice: {
          type: "number",
          label: "Drop-in paid",
          readOnly: true,
          description: "What the drop-in cost, set by the host when it was bought.",
        },
        dropInOrder: {
          type: "text",
          label: "Drop-in order",
          readOnly: true,
          description: "The order that pays for this drop-in, set by the host.",
        },
        bookedBy: {
          type: "user",
          label: "Booked by",
          readOnly: true,
          description: "The staff account that booked it. Empty when the member booked.",
        },
        madeBy: {
          type: "relation",
          label: "Booked by (member)",
          to: "person",
          readOnly: true,
          description:
            "The member who made it, set by the host: the person themselves, or the parent or " +
            "guardian who booked for them. Empty when staff booked. Nobody edits it.",
        },
        movedFrom: {
          type: "relation",
          label: "Moved from",
          to: "bookings.booking",
          readOnly: true,
          description: "The booking this one replaced when staff moved it to this class.",
        },
        note: { type: "longText", label: "Staff note" },
        // Who ticked the name (or marked a no-show), and when (step 7): the coach who was first.
        markedAt: {
          type: "datetime",
          label: "Attendance marked",
          readOnly: true,
          description: "When a coach ticked them as come, or marked them as not come.",
        },
        markedBy: {
          type: "user",
          label: "Marked by",
          readOnly: true,
          description: "The staff account that marked their attendance.",
        },
        markedByName: {
          type: "text",
          label: "Marked by (name)",
          readOnly: true,
          description: "That staff member's name as it was then.",
        },
        // The waitlist's record of what the host did (ADR 0520), for the class list and messages.
        promotedAt: {
          type: "datetime",
          label: "Moved in from the waitlist",
          readOnly: true,
          description: "When the host moved them in from the waitlist.",
        },
        passedOverAt: {
          type: "datetime",
          label: "Passed over",
          readOnly: true,
          description:
            "When a place was free but nothing they hold could pay for it: they stay waiting.",
        },
        passedOverReason: {
          type: "text",
          label: "Why passed over",
          readOnly: true,
          description: "The host's reason (no_uses_left, ended, not_live, not_covered…).",
        },
      },
      states: {
        field: "state",
        initial: "booked",
        create: {
          // A member or staff join a full class's waitlist (ADR 0520: only while it is full,
          // before the cut-off). Held while paying (step 8) is the host's alone.
          in: { waiting: ["staff", "customer", "host"], pending: ["host"] },
          window: { from: opens, until: closes },
          // A class type booked by staff only (staff may book it).
          staffOnly: "class.classType.staffOnly",
          // A class that is not scheduled (cancelled or done): nobody books it, staff included.
          closed: "class.closed",
        },
        // A class the gym cancels (cancelClass, a closure, a series changed, ended or trashed)
        // cancels every booking that holds a place or a use in the same batch: booked, ticked,
        // marked not come and cancelled late included, each use given back once (ADRs 0507, 0553).
        follows: {
          relation: "class",
          when: { cancelled: "cancelled_by_us" },
          from: FOLLOW_CANCEL,
        },
        // A member asks to cancel; the host picks in time or late by its clock (ADR 0503).
        requests: { cancel: ["cancelled", "late_cancelled"] },
        moves: [
          { from: "pending", to: "booked", by: ["host"] },
          { from: "pending", to: "expired", by: ["host"], final: true },
          // The host promotes (taking the waitlist's hold); a member waiting on a class with a
          // free place (after the cut-off, say) takes it themselves, inside the booking window
          // and the staff-only rule, never a place held for the queue (ADR 0520).
          {
            from: "waiting",
            to: "booked",
            by: ["host", "customer"],
            window: { from: opens, until: closes },
            staffOnly: "class.classType.staffOnly",
          },
          { from: "waiting", to: "left", by: ["staff", "customer"], final: true },
          {
            from: "booked",
            to: "cancelled",
            by: ["staff", "customer"],
            final: true,
            window: { until: lateFrom },
            // In time for everyone, staff included (ADR 0507): giving a use back later is a
            // person's own act, the move below.
            bindsStaff: true,
          },
          // Not final: a class the gym cancels afterwards gives the kept use back (ADR 0553).
          {
            from: "booked",
            to: "late_cancelled",
            by: ["staff", "customer"],
            window: { from: lateFrom, until: "class.startsAt" },
          },
          // A person on the staff gives the use back whatever the time, with a reason, through
          // returnUse alone (ADR 0513's `tools`: humanOnly, with its permission).
          { from: "booked", to: "excused", by: ["host"], tools: ["returnUse"], final: true },
          // A coach ticks a name from an hour before the class, and any time after it (a late
          // correction), never days ahead (a window that binds staff, ADR 0551). Unticked, it is
          // booked again; a no-show ticked is attended. Each keeps the use.
          {
            from: "booked",
            to: "attended",
            by: ["staff"],
            window: { from: listOpens },
            bindsStaff: true,
          },
          { from: "attended", to: "booked", by: ["staff"] },
          // Marked by a coach once the class has started; by the host after it (states.after).
          {
            from: "booked",
            to: "no_show",
            by: ["staff", "host"],
            window: { from: "class.startsAt" },
            bindsStaff: true,
          },
          { from: "no_show", to: "attended", by: ["staff"] },
          { from: FOLLOW_CANCEL, to: "cancelled_by_us", by: ["host"], final: true },
          // A move to another class: made only by making the new booking (`movedFrom`), in its
          // batch (ADR 0551), and only before the class starts; after it, giving the use back is a
          // person's act (returnUse).
          {
            from: "booked",
            to: "moved",
            by: ["staff"],
            final: true,
            window: { until: "class.startsAt" },
            bindsStaff: true,
          },
        ],
        // 30 minutes after a class ends, a booking still booked is a no-show, only when someone
        // on the class was marked (its list was taken): a forgotten list makes nobody a no-show
        // (spec 31, decision 11; ADR 0550).
        after: [
          {
            from: "booked",
            to: "no_show",
            at: "class.endsAt",
            minutesAfter: 30,
            ifAnyIn: ["attended", "no_show"],
          },
        ],
      },
      // A class's bookings are the list its coach reads (stage 44, ADR 0643): the host may mark a
      // health note beside each Person on it, asked for by the class's id only.
      healthNotes: { list: "class", person: "person" },
      // Before a booking (stage 44, ADRs 0641 and 0644): checked when a caller makes one booked
      // or waiting, or a waiter takes a free place, for the booking's Person; a drop-in at its
      // order. The host's own moves (promotion, a paid drop-in) are not.
      agreements: {
        point: "booking",
        label: "Before a booking",
        suggests: ["waiver", "health", "guardian"],
        enter: ["booked", "waiting"],
        person: "person",
      },
      // A place on the class while held, booked, attended or a no-show (ADR 0501).
      // Its waitlist (ADR 0520): a place given back before the class type's "waitlist stops"
      // time (else the organisation's) goes to the first waiter, whom the host moves in.
      claims: {
        on: "class",
        held: ["pending"],
        confirmed: ["booked", "attended", "no_show"],
        waitlist: {
          state: "waiting",
          promote: "booked",
          until: {
            at: "class.startsAt",
            minutesBefore: {
              field: "class.classType.promotionMinutes",
              setting: "promotionMinutes",
            },
          },
          promotedAt: "promotedAt",
          passedOverAt: "passedOverAt",
          passedOverReason: "passedOverReason",
        },
      },
      unique: [{ fields: ["person", "class"], states: ACTIVE }],
      // A drop-in (decision 8, ADR 0560): x.bookings.buy has the host make the booking held
      // (`pending`, a place claimed) with its order, priced from the class type's drop-in price,
      // else the organisation's. A verified payment books it; the order expiring or cancelled
      // releases it (`expired`). A paid one cancelled in time, given back by a person, or
      // cancelled by the gym owes its money back, which a person with orders:refund approves
      // (decision 15). A late cancel and a no-show keep it (no fee, no refund).
      sellable: {
        price: "dropInPrice",
        // Stripe's "Fee for Personal Training/Fitness Classes" (in-person group classes); a human
        // admin may override it in Settings -> Orders.
        tax: { code: "txcd_50021003" },
        moves: {
          held: "pending",
          paid: "booked",
          expired: "expired",
          refund: ["cancelled", "excused", "cancelled_by_us"],
          price: { field: "class.classType.dropInPrice", setting: "dropInPrice" },
          title: "class.title",
          order: "dropInOrder",
          // A visitor is matched to no Person until they have paid (ADR 0560): their hold is
          // nobody's, blocks nobody's own booking and says nothing about who has the address.
          guest: true,
          // How much of a class unpaid guest holds may take at once.
          holdCap: { setting: "dropInHoldPercent" },
        },
      },
      // A spender of the Memberships pack's holders (stage 32b's ids, spec 32): booked spends,
      // an in-time cancel, a class the gym cancels and a move give back; a late cancel and a
      // no-show keep it. The period is the class's, and its type and local time are what a
      // membership's limits read (ADRs 0493 and 0494).
      allowance: {
        spends: {
          person: "person",
          holder: "holder",
          spendIn: ["booked"],
          returnIn: ["cancelled", "excused", "cancelled_by_us", "moved"],
          at: "class.startsAt",
          copy: { classType: "class.classType" },
          local: { weekday: "weekday", minute: "minute", zone: "class.timezone" },
          movedFrom: { field: "movedFrom", state: "moved" },
          paidBy: ["memberships.membership", "memberships.pass"],
          waived: "paidOtherwise",
        },
      },
      // A member reads and changes only their own bookings, and a parent or guardian staff linked
      // to a child the child's too (ADR 0540); never anyone else's (decision 13).
      customer: {
        field: "person",
        read: [
          "person",
          "class",
          "state",
          "holder",
          "classType",
          "promotedAt",
          "passedOverAt",
          "passedOverReason",
          "paidOtherwise",
          "dropInPrice",
          "dropInOrder",
        ],
        write: ["class", "state", "holder"],
        // Which class and which holder are chosen when it is made, never after (ADR 0507).
        createOnly: ["class", "holder"],
        // A guardian books, cancels and joins waitlists for a live dependant, under the same
        // windows and rules, and reads their bookings (ADR 0540). The use is the child's: the
        // allowance spends the booking's Person's holders only.
        guardians: { write: true, madeBy: "madeBy" },
      },
      timelineLinks: ["person"],
      indexes: [["class", "state"], ["person", "state"], ["state"]],
    },
  },
  views: {
    todaysClasses: {
      label: "Today's classes",
      object: "bookings.class",
      filter: {
        and: [
          { field: "startsAt", op: "gte", value: { $relative: "today" } },
          { field: "startsAt", op: "lt", value: { $relative: "tomorrow" } },
        ],
      },
      sort: { field: "startsAt", direction: "asc" },
      columns: ["title", "startsAt", "coach", "room", "places", "taken", "available", "state"],
    },
    thisWeeksClasses: {
      label: "This week's classes",
      object: "bookings.class",
      filter: {
        and: [
          { field: "startsAt", op: "gte", value: { $relative: "startOfWeek" } },
          { field: "startsAt", op: "lt", value: { $relative: "startOfNextWeek" } },
        ],
      },
      sort: { field: "startsAt", direction: "asc" },
      columns: ["title", "startsAt", "coach", "room", "taken", "available", "state"],
    },
    activeSeries: {
      label: "Timetable",
      object: "bookings.series",
      filter: { field: "state", op: "eq", value: "active" },
      sort: { field: "time", direction: "asc" },
      columns: ["title", "weekdays", "time", "length", "coach", "room", "places", "firstDate"],
    },
    waitlists: {
      label: "Waiting",
      object: "bookings.booking",
      filter: { field: "state", op: "eq", value: "waiting" },
      sort: { field: "createdAt", direction: "asc" },
      columns: ["title", "class", "person", "createdAt", "passedOverAt", "passedOverReason"],
    },
    lateCancels: {
      label: "Late cancels",
      object: "bookings.booking",
      filter: { field: "state", op: "eq", value: "late_cancelled" },
      sort: { field: "updatedAt", direction: "desc" },
      columns: ["title", "class", "person", "updatedAt"],
    },
    // Step 9's saved views: this month's, by when the booking last changed (became one).
    noShowsThisMonth: {
      label: "No-shows this month",
      object: "bookings.booking",
      filter: {
        and: [
          { field: "state", op: "eq", value: "no_show" },
          { field: "updatedAt", op: "gte", value: { $relative: "startOfMonth" } },
        ],
      },
      sort: { field: "updatedAt", direction: "desc" },
      columns: ["title", "class", "person", "markedByName", "updatedAt"],
    },
    lateCancelsThisMonth: {
      label: "Late cancels this month",
      object: "bookings.booking",
      filter: {
        and: [
          { field: "state", op: "eq", value: "late_cancelled" },
          { field: "updatedAt", op: "gte", value: { $relative: "startOfMonth" } },
        ],
      },
      sort: { field: "updatedAt", direction: "desc" },
      columns: ["title", "class", "person", "updatedAt"],
    },
  },
  recordTabs: {
    // A class's list: who is booked, on its record page.
    classBookings: {
      label: "Bookings",
      on: "bookings.class",
      view: {
        type: "table",
        object: "bookings.booking",
        relation: "class",
        columns: [
          "person",
          "state",
          "holder",
          "paidOtherwise",
          "dropInPrice",
          "bookedBy",
          "promotedAt",
          "passedOverReason",
          "markedAt",
          "markedByName",
          "createdAt",
        ],
        sort: { field: "createdAt", direction: "asc" },
      },
      order: 10,
    },
    seriesClasses: {
      label: "Classes",
      on: "bookings.series",
      view: {
        type: "table",
        object: "bookings.class",
        relation: "series",
        columns: ["startsAt", "coach", "room", "places", "taken", "state", "changed"],
        sort: { field: "startsAt", direction: "asc" },
      },
      order: 10,
    },
    personBookings: {
      label: "Bookings",
      on: "person",
      view: {
        type: "table",
        object: "bookings.booking",
        relation: "person",
        columns: ["class", "state", "holder", "createdAt"],
        sort: { field: "createdAt", direction: "desc" },
      },
      order: 35,
    },
  },
  // The organisation's booking rules, which a class type's own values override. Changed by a
  // person with the extensions permission (Settings → Extensions → Bookings).
  // The members' email (ADR 0590): routine mail the host sends without a person's approval.
  routineMail: bookingsRoutineMail,
  settings: {
    opensDays: {
      type: "number",
      label: "Booking opens (days before)",
      description:
        "Members may book a class this many days before it, at the same time of day. At most " +
        "56, the timetable's horizon; a class type may open further ahead.",
      default: 7,
      min: 0,
      max: 56,
      personApproves: true,
    },
    closesMinutes: {
      type: "number",
      label: "Booking closes (minutes before)",
      description: "Members may book until this many minutes before a class (0: until it starts).",
      default: 0,
      min: 0,
      max: 10_080,
      personApproves: true,
    },
    lateMinutes: {
      type: "number",
      label: "Late cancel from (minutes before)",
      description: "A cancel this close to the start is late: it keeps the class it used.",
      default: 60,
      min: 0,
      max: 10_080,
      personApproves: true,
    },
    promotionMinutes: {
      type: "number",
      label: "Waitlist stops (minutes before)",
      description:
        "Nobody is moved in from the waitlist after this: a place freed later goes to whoever " +
        "books first.",
      default: 120,
      min: 0,
      max: 10_080,
      personApproves: true,
    },
    dropInPrice: {
      type: "number",
      label: "Drop-in price",
      description:
        "What one class costs someone paying for it on the website, in the organisation's " +
        "currency, unless its class type sets its own. Empty: no drop-ins.",
      min: 0,
      max: 100_000,
      personApproves: true,
    },
    dropInHoldPercent: {
      type: "number",
      label: "Places held for unpaid drop-ins (percent)",
      description:
        "At most this share of a class's places (at least one) may be held at once for visitors " +
        "who have not paid yet. More are told to try again shortly.",
      default: 50,
      min: 0,
      max: 100,
      personApproves: true,
    },
    reminderMinutes: {
      type: "number",
      label: "Reminder (minutes before)",
      description:
        "When members booked into a class are emailed a reminder, unless its class type sets " +
        "its own: at most two days (2,880 minutes) before.",
      default: 180,
      min: 0,
      max: 2_880,
      personApproves: true,
    },
    bookingsUrl: {
      type: "text",
      label: "Where members see their bookings",
      description:
        "The page on your site where a signed-in member sees their bookings (https), linked from " +
        "every booking email, when it is on your site (Settings → Routine email). Empty: the emails " +
        "say to sign in.",
      // The link every member email carries: a person's to change, as the booking rules are.
      personApproves: true,
    },
  },
  // The coach role (spec 31, decision 10; ADR 0436): the day's classes and their lists, and ticking
  // names. Nothing else: no money (no holders, no desk payments, no orders), no people beyond the
  // names on a list, no bookings made or cancelled, no settings.
  roles: {
    coach: {
      label: "Coach",
      description:
        "Sees the day's classes and each class's list, and ticks who came (or marks who did " +
        "not). Nothing else: no money, no other people, no booking or cancelling, no settings.",
      permissions: ["bookings:coach"],
      read: ["bookings.class"],
      // Today's classes and lists only (spec 31: "read today's classes and their lists"): a class
      // starting today in its own zone, or running now (past midnight until it ends). Another
      // day's corrections are the desk's.
      today: {
        "bookings.class": { at: "startsAt", until: "endsAt", zone: "timezone" },
        "bookings.booking": { at: "class.startsAt", until: "class.endsAt", zone: "class.timezone" },
      },
    },
  },
  // The front desk's tools (ADR 0600): find people, book anyone (a walk-in too) into any class,
  // cancel for them, move them, give a use back, a class's full list and any day's classes. Any
  // member of staff holds them; an admin grants them to a coach, whose coach role they add to:
  // the coach's own list and ticks stay today's. Not cancelling a class (its own permission, and
  // a person's), not refunds (orders:refund), not people, orders, passes or memberships.
  grantable: ["bookings:desk"],
  grantableLabels: {
    "bookings:desk":
      "Front desk: find people, book anyone (walk-ins too) into any class, cancel or move their " +
      "bookings, give a use back, and see any day's classes and full lists. For a coach who " +
      "also works the desk.",
  },
  tools: {
    timetable,
    classGet,
    book,
    buy,
    cancel,
    leaveWaitlist,
    mine,
    findPeople,
    bookFor,
    cancelFor,
    returnUse,
    day,
    classList,
    roster,
    markAttended,
    undoAttended,
    markNoShow,
    markAll,
    move,
    cancelClass,
    family,
  },
  automations: bookingsAutomations,
  dashboards: bookingsDashboards,
});
