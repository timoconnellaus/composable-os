// Bookings' routine mail (ADR 0590): the member emails the host sends without a person's
// approval. Each kind is about one booking; the host sends it to the booking's Person, each of
// their live guardians (ADR 0540), or for a visitor's paid drop-in the order's own address
// (ADR 0560), never anyone the pack names. The words are these: the host fills each slot from the
// booking and its class, checks every value it puts in (a class title or a member's name that
// holds a link, an address or markup is held for a person), and links only to the gym's own site
// (Settings → Routine email). The automations (automations.ts) say which kind and message, about
// which booking, and pass only the choices, moments and flags declared here. An admin can turn
// any kind off.
//
// Text and push (ADR 0670): each booking kind also has a text's words and a push's, which go only
// on the channels a human admin switches on for it. A text or push is pointless once the class has
// started (`until`), and the timetable screen of the app is what a push opens. A member may turn
// off reminders and waiting list news; the rest are essential (their email always goes). A
// cancellation is urgent: it may go during quiet hours when the class starts before they end.
import type { RoutineMailSpec, RoutineSlotSpec } from "@composable-os/sdk";

/** What every message reads of the booking's class, and the link to the member's bookings. */
const CLASS_SLOTS = {
  class: { field: "class.title" },
  when: { field: "class.startsAt", format: "datetime", zone: "class.timezone" },
  room: { field: "class.room.name", optional: true },
  link: { link: "bookingsUrl" },
  // For texts and pushes, which have less room: the day, the time, and a title of at most 40
  // characters (a longer one holds only the text or push that shows it).
  day: { field: "class.startsAt", format: "date", zone: "class.timezone" },
  time: { field: "class.startsAt", format: "time", zone: "class.timezone" },
  short: { field: "class.title", max: 40 },
} satisfies Record<string, RoutineSlotSpec>;

/** What every booking kind says of its text and push (ADR 0670). */
const PHONE = {
  channels: ["email", "text", "push"],
  until: "class.startsAt",
  open: { screen: "timetable" },
} as const;

/** The last line of every email. */
const SIGN_IN = "You can see your bookings when you sign in[: {link}].";

/** The booking's class on the member's calendar. */
const CALENDAR = {
  start: "class.startsAt",
  end: "class.endsAt",
  title: "class.title",
  location: "class.room.name",
  link: "link",
} as const;

export const bookingsRoutineMail = {
  confirmation: {
    label: "Booking confirmations",
    description:
      "When a booking becomes booked: made by the member, a parent or staff, a drop-in paid " +
      "for, moved in from the waiting list, or moved by staff to another class. To the member " +
      "and their parents or guardians, with an add-to-calendar file.",
    about: "booking",
    ...PHONE,
    slots: {
      ...CLASS_SLOTS,
      oldClass: { field: "movedFrom.class.title", optional: true },
      oldWhen: {
        field: "movedFrom.class.startsAt",
        format: "datetime",
        zone: "movedFrom.class.timezone",
        optional: true,
      },
    },
    messages: {
      booked: {
        subject: "Booked: {class}",
        text: [
          "You are booked into {class} on {when}[, in {room}].",
          "",
          "The attached file adds it to your calendar.",
          SIGN_IN,
        ].join("\n"),
        textMessage: "Booked: {class}, {day} at {time}.",
        push: { title: "Booked for {day}", body: "{class} at {time}." },
        guardian: {
          subject: "Booked: {class} ({member})",
          text: [
            "{member} is booked into {class} on {when}[, in {room}].",
            "",
            "The attached file adds it to your calendar.",
            SIGN_IN,
          ].join("\n"),
          textMessage: "{member} is booked into {class}, {day} at {time}.",
          push: { title: "Booked for {day}", body: "{member}: {short} at {time}." },
        },
        calendar: CALENDAR,
      },
      paid: {
        subject: "Booked and paid: {class}",
        text: [
          "Payment received: you are booked into {class} on {when}[, in {room}].",
          "",
          "The attached file adds it to your calendar.",
          SIGN_IN,
        ].join("\n"),
        textMessage: "Paid and booked: {class}, {day} at {time}.",
        push: { title: "Paid and booked for {day}", body: "{class} at {time}." },
        guardian: {
          subject: "Booked and paid: {class} ({member})",
          text: [
            "Payment received: {member} is booked into {class} on {when}[, in {room}].",
            "",
            "The attached file adds it to your calendar.",
            SIGN_IN,
          ].join("\n"),
          textMessage: "Paid: {member} is booked into {short}, {day} at {time}.",
          push: { title: "Paid and booked for {day}", body: "{member}: {short} at {time}." },
        },
        calendar: CALENDAR,
      },
      promoted: {
        subject: "You're in: {class}",
        text: [
          "A place came free and you are now booked into {class} on {when}[, in {room}], moved in from the waiting list. It used one class from your membership or pass.",
          "",
          "The attached file adds it to your calendar.",
          SIGN_IN,
        ].join("\n"),
        textMessage: "A place came free: you are booked into {class}, {day} at {time}.",
        push: { title: "You're in, {day}", body: "{class} at {time}." },
        guardian: {
          subject: "You're in: {class} ({member})",
          text: [
            "A place came free and {member} is now booked into {class} on {when}[, in {room}], moved in from the waiting list. It used one class from their membership or pass.",
            "",
            "The attached file adds it to your calendar.",
            SIGN_IN,
          ].join("\n"),
          textMessage: "A place came free: {member} is booked into {short}, {day} at {time}.",
          push: { title: "In from the waiting list", body: "{member}: {short} at {time}." },
        },
        calendar: CALENDAR,
      },
      moved: {
        subject: "Booking moved: {class}",
        text: [
          "The gym moved your booking[ from {oldClass}][ on {oldWhen}] to {class} on {when}[, in {room}].",
          "",
          "The attached files take the old class off your calendar and add the new one.",
          SIGN_IN,
        ].join("\n"),
        textMessage: "Your booking moved to {class}, {day} at {time}.",
        push: { title: "Booking moved to {day}", body: "{class} at {time}." },
        guardian: {
          subject: "Booking moved: {class} ({member})",
          text: [
            "The gym moved {member}'s booking[ from {oldClass}][ on {oldWhen}] to {class} on {when}[, in {room}].",
            "",
            "The attached files take the old class off your calendar and add the new one.",
            SIGN_IN,
          ].join("\n"),
          textMessage: "{member}'s booking moved to {short}, {day} at {time}.",
          push: { title: "Booking moved to {day}", body: "{member}: {short} at {time}." },
        },
        calendar: [
          {
            uid: "movedFrom",
            start: "movedFrom.class.startsAt",
            end: "movedFrom.class.endsAt",
            title: "movedFrom.class.title",
            location: "movedFrom.class.room.name",
            cancelled: true,
            update: true,
          },
          { ...CALENDAR, update: true },
        ],
      },
    },
  },

  waitingList: {
    label: "Waiting list news",
    description:
      "When a place came free but the first person waiting could not be moved in (nothing they " +
      "hold could pay for it), and when a place is given back after the waiting list has " +
      "stopped. To each person waiting and their parents or guardians.",
    about: "booking",
    essential: false,
    ...PHONE,
    slots: {
      ...CLASS_SLOTS,
      why: {
        choice: {
          noUsesLeft: "there are no classes left on the membership or pass for that week",
          notLive: "no membership or pass covers the class's date (ended, or paused)",
          notCovered: "the membership or pass does not cover this class",
          other: "nothing held could pay for it",
        },
      },
    },
    messages: {
      passedOver: {
        subject: "A place came free: {class}",
        text: [
          "A place came free on {class} on {when}, but we could not move you in: {why}.",
          "You are still on the waiting list, and will be moved in when the next place comes free if it can be paid for then.",
          "",
          SIGN_IN,
        ].join("\n"),
        textMessage:
          "A place came free on {short}, {day} at {time}, but we could not move you in: {why}.",
        push: { title: "A place came free", body: "{short} at {time}: we could not move you in." },
        guardian: {
          subject: "A place came free: {class} ({member})",
          text: [
            "A place came free on {class} on {when}, but we could not move {member} in: {why}.",
            "{member} is still on the waiting list, and will be moved in when the next place comes free if it can be paid for then.",
            "",
            SIGN_IN,
          ].join("\n"),
          textMessage:
            "A place came free on {short}, {day} at {time}, but we could not move {member} in. The email says why.",
          push: { title: "A place came free", body: "{member}: we could not move them in." },
        },
      },
      placeFree: {
        subject: "A place is free: {class}",
        text: [
          "A place is free on {class} on {when}. The waiting list has stopped for this class, so whoever books it first gets it.",
          "Book it now if you still want it.",
          "",
          SIGN_IN,
        ].join("\n"),
        textMessage: "A place is free on {class}, {day} at {time}. Whoever books it first gets it.",
        push: { title: "A place is free", body: "{short} at {time}: whoever books first gets it." },
        guardian: {
          subject: "A place is free: {class} ({member})",
          text: [
            "A place is free on {class} on {when}. The waiting list has stopped for this class, so whoever books it first gets it.",
            "Book it for {member} now if they still want it.",
            "",
            SIGN_IN,
          ].join("\n"),
          textMessage:
            "A place is free on {short}, {day} at {time}. Book it for {member} if they still want it.",
          push: { title: "A place is free", body: "{short} at {time}, for {member}." },
        },
      },
    },
  },

  change: {
    label: "Class changes",
    description:
      "When staff change a scheduled class's time, day, end or room (a coach swap sends " +
      "nothing). To everyone booked or waiting and their parents or guardians, with an updated " +
      "add-to-calendar file for those booked.",
    about: "booking",
    ...PHONE,
    slots: {
      ...CLASS_SLOTS,
      before: { at: true, zone: "class.timezone", optional: true },
      ends: { field: "class.endsAt", format: "time", zone: "class.timezone", optional: true },
      stays: {
        choice: {
          booking: "booking stays",
          waiting: "place on the waiting list stays",
        },
      },
      moved: { flag: true },
      notMoved: { flag: true },
      endChanged: { flag: true },
      roomChanged: { flag: true },
      keep: { flag: true },
    },
    messages: {
      changed: {
        subject: "Class changed: {class}",
        text: [
          "[{moved}{class}][{moved} on {before}][{moved} has moved to {when}.][{notMoved}{class} on {when} has changed.]",
          "[{endChanged}It now ends at {ends}.]",
          "[{roomChanged}It is now in {room}.]",
          "Your {stays} as it is. If the change does not suit, cancel it when you sign in.",
          "",
          "[{keep}The attached file updates it in your calendar.]",
          SIGN_IN,
        ].join("\n"),
        textMessage: "Class changed: {class}, now {day} at {time}. The email has the details.",
        push: { title: "Class changed", body: "{short}: now {day} at {time}." },
        guardian: {
          subject: "Class changed: {class} ({member})",
          text: [
            "[{moved}{class}][{moved} on {before}][{moved} has moved to {when}.][{notMoved}{class} on {when} has changed.]",
            "[{endChanged}It now ends at {ends}.]",
            "[{roomChanged}It is now in {room}.]",
            "{member}'s {stays} as it is. If the change does not suit, cancel it when you sign in.",
            "",
            "[{keep}The attached file updates it in your calendar.]",
            SIGN_IN,
          ].join("\n"),
          textMessage:
            "{member}'s class changed: {short}, now {day} at {time}. The email has the details.",
          push: { title: "Class changed", body: "{member}: {short} has changed." },
        },
        calendar: { ...CALENDAR, update: true, if: "keep" },
      },
    },
  },

  cancellation: {
    label: "Class cancellations",
    description:
      "When the gym cancels a class (staff, a closure, or a series ended). To everyone whose " +
      "booking it cancelled and their parents or guardians: the reason, that nothing was used " +
      "or that a paid drop-in's money goes back once approved, with a file that takes it off " +
      "their calendar.",
    about: "booking",
    // A cancellation close to the class may go during quiet hours (ADR 0676).
    urgent: true,
    ...PHONE,
    slots: {
      ...CLASS_SLOTS,
      reason: { field: "class.cancelledReason", max: 200, optional: true },
      money: {
        choice: {
          refund:
            "The money paid for it goes back to the card it was paid with, once the gym approves the refund: you will get an email when it has been made.",
          unpaid: "Nothing was charged.",
          membership: "Nothing was used from your membership or pass.",
        },
        guardian: {
          refund:
            "The money paid for it goes back to the card it was paid with, once the gym approves the refund.",
          membership: "Nothing was used from their membership or pass.",
        },
      },
    },
    messages: {
      cancelled: {
        subject: "Cancelled by the gym: {class}",
        text: [
          "The gym has cancelled {class} on {when}.",
          "[The reason: {reason}]",
          "{money}",
          "",
          "The attached file takes it off your calendar.",
          SIGN_IN,
        ].join("\n"),
        textMessage: "Cancelled by the gym: {class}, {day} at {time}. The email has the details.",
        push: { title: "Class cancelled", body: "{short}, {day} at {time}." },
        guardian: {
          subject: "Cancelled by the gym: {class} ({member})",
          text: [
            "The gym has cancelled {class} on {when}, which {member} was booked into.",
            "[The reason: {reason}]",
            "{money}",
            "",
            "The attached file takes it off your calendar.",
            SIGN_IN,
          ].join("\n"),
          textMessage:
            "Cancelled by the gym: {short}, {day} at {time}, which {member} was booked into.",
          push: { title: "Class cancelled", body: "{member}: {short} at {time}." },
        },
        calendar: { ...CALENDAR, cancelled: true, update: true },
      },
    },
  },

  reminder: {
    label: "Class reminders",
    description:
      "Before each scheduled class (3 hours by default: the class type's reminder, else the " +
      "organisation's). To everyone booked and their parents or guardians, and a visitor who " +
      "paid for a place staff have not yet confirmed.",
    about: "booking",
    essential: false,
    ...PHONE,
    slots: CLASS_SLOTS,
    messages: {
      reminder: {
        subject: "Reminder: {class}",
        text: [
          "A reminder: you are booked into {class} on {when}[, in {room}].",
          "If you cannot come, cancel when you sign in, so someone waiting can have the place.",
          "",
          SIGN_IN,
        ].join("\n"),
        textMessage:
          "Reminder: {class}, {day} at {time}. Can't come? Cancel when you sign in, so someone waiting gets the place.",
        push: { title: "Reminder for {day}", body: "{class} at {time}." },
        guardian: {
          subject: "Reminder: {class} ({member})",
          text: [
            "A reminder: {member} is booked into {class} on {when}[, in {room}].",
            "If they cannot come, cancel when you sign in, so someone waiting can have the place.",
            "",
            SIGN_IN,
          ].join("\n"),
          textMessage: "Reminder: {member} is booked into {short}, {day} at {time}.",
          push: { title: "Reminder for {day}", body: "{member}: {short} at {time}." },
        },
      },
    },
  },

  dropIn: {
    label: "Drop-in payments and refunds",
    description:
      "When a visitor pays for a class that staff still have to confirm, and when a paid " +
      "drop-in's refund has been made. About the order: to the address that paid it, never " +
      "anyone else.",
    // About the order (the coordinator's D3): a payer's notice goes to the address that paid.
    about: "order",
    slots: {
      what: {
        each: {
          object: "booking",
          via: "dropInOrder",
          max: 1,
          line: "{class} on {when}",
          slots: {
            class: { field: "class.title" },
            when: { field: "class.startsAt", format: "datetime", zone: "class.timezone" },
          },
        },
      },
      link: { link: "bookingsUrl" },
    },
    messages: {
      held: {
        subject: "Payment received",
        text: [
          "Payment received for {what}. Your place is held: the gym confirms it shortly, and you will get an email when it has.",
          "",
          SIGN_IN,
        ].join("\n"),
      },
      refunded: {
        subject: "Refund made",
        text: [
          "Your refund for {what} has been made to the card you paid with. Banks can take a few days to show it.",
          "",
          SIGN_IN,
        ].join("\n"),
      },
    },
  },
  // Feedback after a class (stage 29 step 5, decision 4; ADR 0723): a follow-up, which a member
  // may stop with one tap (ADR 0675), carrying a personal link to the form the gym chose
  // (`feedbackForm`). The host makes the link for the booking's Person about this booking, good
  // for a week, and sends it at most once a month to a member; a child's goes to their guardian,
  // never to the child's own address. The same link is "Needs your attention" in the app.
  feedback: {
    label: "Feedback after a class",
    description:
      "A few hours after a member is ticked as come (3 by default), when a feedback form is " +
      "chosen in the settings: a short email asking how the class was, with a link to the form " +
      "that works once and for a week. At most once a month to a member; a child's goes to their " +
      "parent or guardian. Members can stop these emails with one tap.",
    about: "booking",
    purpose: "follow_up",
    slots: {
      class: { field: "class.title" },
      day: { field: "class.startsAt", format: "date", zone: "class.timezone" },
      form: { formLink: { object: "forms.form", setting: "feedbackForm", days: 7, once: 30 } },
    },
    messages: {
      ask: {
        subject: "How was {class}?",
        text: [
          "Thank you for coming to {class} on {day}. How was it?",
          "",
          "Tell us here (it takes a minute; the link works once, for a week):",
          "{form}",
        ].join("\n"),
        guardian: {
          subject: "How was {class}? ({member})",
          text: [
            "Thank you for bringing {member} to {class} on {day}. How was it?",
            "",
            "Tell us here (it takes a minute; the link works once, for a week):",
            "{form}",
          ].join("\n"),
        },
      },
    },
  },
} satisfies Record<string, RoutineMailSpec>;
