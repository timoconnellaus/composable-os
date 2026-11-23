// Bookings' routine mail (ADR 0590): the member emails the host sends without a person's
// approval. Each kind is about one booking; the host sends it to the booking's Person, each of
// their live guardians (ADR 0540), or for a visitor's paid drop-in the order's own address
// (ADR 0560), never anyone the pack names. The words are these: the host fills each slot from the
// booking and its class, checks every value it puts in (a class title or a member's name that
// holds a link, an address or markup is held for a person), and links only to the gym's own site
// (Settings → Routine email). The automations (automations.ts) say which kind and message, about
// which booking, and pass only the choices, moments and flags declared here. An admin can turn
// any kind off.
import type { RoutineMailSpec, RoutineSlotSpec } from "@composable-os/sdk";

/** What every message reads of the booking's class, and the link to the member's bookings. */
const CLASS_SLOTS = {
  class: { field: "class.title" },
  when: { field: "class.startsAt", format: "datetime", zone: "class.timezone" },
  room: { field: "class.room.name", optional: true },
  link: { link: "bookingsUrl" },
} satisfies Record<string, RoutineSlotSpec>;

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
        guardian: {
          subject: "Booked: {class} ({member})",
          text: [
            "{member} is booked into {class} on {when}[, in {room}].",
            "",
            "The attached file adds it to your calendar.",
            SIGN_IN,
          ].join("\n"),
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
        guardian: {
          subject: "Booked and paid: {class} ({member})",
          text: [
            "Payment received: {member} is booked into {class} on {when}[, in {room}].",
            "",
            "The attached file adds it to your calendar.",
            SIGN_IN,
          ].join("\n"),
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
        guardian: {
          subject: "You're in: {class} ({member})",
          text: [
            "A place came free and {member} is now booked into {class} on {when}[, in {room}], moved in from the waiting list. It used one class from their membership or pass.",
            "",
            "The attached file adds it to your calendar.",
            SIGN_IN,
          ].join("\n"),
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
        guardian: {
          subject: "Booking moved: {class} ({member})",
          text: [
            "The gym moved {member}'s booking[ from {oldClass}][ on {oldWhen}] to {class} on {when}[, in {room}].",
            "",
            "The attached files take the old class off your calendar and add the new one.",
            SIGN_IN,
          ].join("\n"),
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
        guardian: {
          subject: "A place came free: {class} ({member})",
          text: [
            "A place came free on {class} on {when}, but we could not move {member} in: {why}.",
            "{member} is still on the waiting list, and will be moved in when the next place comes free if it can be paid for then.",
            "",
            SIGN_IN,
          ].join("\n"),
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
        guardian: {
          subject: "A place is free: {class} ({member})",
          text: [
            "A place is free on {class} on {when}. The waiting list has stopped for this class, so whoever books it first gets it.",
            "Book it for {member} now if they still want it.",
            "",
            SIGN_IN,
          ].join("\n"),
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
        guardian: {
          subject: "Reminder: {class} ({member})",
          text: [
            "A reminder: {member} is booked into {class} on {when}[, in {room}].",
            "If they cannot come, cancel when you sign in, so someone waiting can have the place.",
            "",
            SIGN_IN,
          ].join("\n"),
        },
      },
    },
  },

  dropIn: {
    label: "Drop-in payments and refunds",
    description:
      "When a visitor pays for a class that staff still have to confirm, and when a paid " +
      "drop-in's refund has been made. To the order's own address while the place has no " +
      "Person, else to the member.",
    about: "booking",
    slots: CLASS_SLOTS,
    messages: {
      held: {
        subject: "Payment received: {class}",
        text: [
          "Payment received for {class} on {when}. Your place is held: the gym confirms it shortly, and you will get an email when it has.",
          "",
          SIGN_IN,
        ].join("\n"),
        calendar: CALENDAR,
      },
      refunded: {
        subject: "Refund made: {class}",
        text: [
          "Your refund for {class} on {when} has been made to the card you paid with. Banks can take a few days to show it.",
          "",
          SIGN_IN,
        ].join("\n"),
        guardian: {
          subject: "Refund made: {class} ({member})",
          text: [
            "The refund for {class} on {when}, which {member} was booked into, has been made to the card it was paid with. Banks can take a few days to show it.",
            "",
            SIGN_IN,
          ].join("\n"),
        },
      },
    },
  },
} satisfies Record<string, RoutineMailSpec>;
