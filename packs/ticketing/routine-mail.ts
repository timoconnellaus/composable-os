// Ticketing's routine mail (ADR 0590): the buyer's and the holder's emails, which the host sends
// without a person's approval. The tickets and the balance reminder are about an order and go to
// that order's own address once a payment was applied (ADR 0560); the reminder the day before is
// about a ticket and goes to its holder. The host fills every slot from those records, checks
// what it puts in, and links only to the business's own site (Settings → Routine email).
import type { RoutineMailSpec } from "@composable-os/sdk";

export const ticketingRoutineMail = {
  tickets: {
    label: "Tickets by email",
    description:
      "When an order is first paid (in full, or its deposit): the buyer's tickets, one line per " +
      "ticket with its code, and the page where they can show them. To the order's own address.",
    about: "order",
    slots: {
      events: {
        each: {
          object: "ticket",
          via: "order",
          distinct: "event",
          max: 100,
          line: "{event}[: {when}][, {venue}]",
          slots: {
            event: { field: "event.name" },
            when: {
              field: "event.startsAt",
              format: "datetime",
              zone: "event.timezone",
              year: true,
              optional: true,
            },
            venue: { field: "event.venue", optional: true },
          },
        },
      },
      tickets: {
        each: {
          object: "ticket",
          via: "order",
          max: 100,
          line: "{name}: {code}",
          slots: { name: { field: "name" }, code: { field: "code", max: 40 } },
        },
      },
      link: { link: "ticketsUrl", withId: "order" },
    },
    messages: {
      one: {
        subject: "Your ticket",
        text: [
          "Thank you. Your ticket is below: show the code at the door.",
          "",
          "{events}",
          "",
          "{tickets}",
          "",
          "[See it any time: {link}]",
        ].join("\n"),
      },
      many: {
        subject: "Your tickets",
        text: [
          "Thank you. Your tickets are below: show the code at the door.",
          "",
          "{events}",
          "",
          "{tickets}",
          "",
          "[See them any time: {link}]",
        ].join("\n"),
      },
    },
  },

  eventReminder: {
    label: "Event reminders",
    description:
      "The day before an event on sale starts, counted in the event's own time zone: its time " +
      "and venue. To each holder of a valid ticket, once however many tickets they hold.",
    about: "ticket",
    slots: {
      event: { field: "event.name" },
      when: {
        field: "event.startsAt",
        format: "datetime",
        zone: "event.timezone",
        year: true,
        optional: true,
      },
      venue: { field: "event.venue", optional: true },
      count: { count: { max: 1000 } },
    },
    messages: {
      one: {
        subject: "Tomorrow: {event}",
        text: [
          "{event} is tomorrow[, starting {when}][ at {venue}].",
          "You have a ticket: bring the code.",
        ].join("\n"),
      },
      many: {
        subject: "Tomorrow: {event}",
        text: [
          "{event} is tomorrow[, starting {when}][ at {venue}].",
          "You have {count} tickets: bring the code.",
        ].join("\n"),
      },
    },
  },

  balance: {
    label: "Balance reminders",
    description:
      "Every morning, for a part-paid ticket order whose balance is due in a week or tomorrow: " +
      "how much is owed, when, and the page to pay it. To the order's own address.",
    about: "order",
    slots: {
      balance: { field: "balance", format: "money", currency: "currency" },
      due: { field: "balanceDueAt", format: "date", year: true },
      link: { link: "payUrl", withId: "order" },
    },
    messages: {
      due: {
        subject: "Balance due {due}",
        text: [
          "The balance on your tickets, {balance}, is due on {due}.",
          "Pay it when you sign in with this email address[: {link}].",
          "You can pay it in one go or in parts.",
        ].join("\n"),
      },
    },
  },
} satisfies Record<string, RoutineMailSpec>;
