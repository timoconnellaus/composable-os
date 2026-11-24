// Ticketing (stage 27): events, the ticket types sold for them, and the tickets a paid order
// grants. Any product can turn it on (`packs` in its product.ts); a product that does not list it
// has none of this.
//
// Everything that is a rule is the host's, declared here as behaviours (ADR 0404):
//   - an event's lifecycle (`states`) and its places, shared by its ticket types (`capacity`);
//   - a ticket type is for sale (`sellable`): its price, sale window, most per order and deposit
//     are fields staff edit, and a paid line grants one ticket per place, with the host's code,
//     in the batch that marks the order paid; a full refund or a cancelled deposit voids them;
//   - a ticket is its holder's (`customer`): they read its event, type, code and state, and
//     nothing else, through the visibility seam, and through it their event's name, times and
//     venue and their ticket type's name, live, whatever the event's state (`customerVia`);
//   - the door role (`roles`, ADR 0436): check tickets in and read events, ticket types and
//     tickets, and nothing else.
// The tools in tools.ts compose the host's operations and add no rules of their own.
import { defineExtension } from "@composable-os/sdk";
import { ticketingAutomations } from "./automations.ts";
import { ticketingDashboards } from "./dashboards.ts";
import { ticketingRoutineMail } from "./routine-mail.ts";
import {
  checkIn,
  eventsOnSale,
  myTickets,
  orderStart,
  salesSummary,
  undoCheckIn,
} from "./tools.ts";

export default defineExtension({
  id: "ticketing",
  version: "0.1.0",
  contractVersion: 1,
  label: "Ticketing",
  description:
    "Events, ticket types for sale and the tickets a paid order grants, with check-in at the " +
    "door. Buyers are people; tickets are theirs to see.",
  permissions: {
    // order.start: a buyer's order, priced and held by the host. order.get: whether a ticket's
    // order still has a balance owing, at check-in. query.sql: revenue per ticket type for the
    // sales summary. person.get (read person): the holder's name a check-in reports.
    read: ["person"],
    // public.list and capacity.get: the events on sale and their places, for the public.
    // extensionSettings.list: the pages the blocks link to. routine-mail: the buyer's and the
    // holder's email (routine-mail.ts, ADR 0590), sent by the host from the email-send
    // connection an admin binds to each automation.
    // order.settings.get: the currency the sales summary's amounts are in (staff).
    operations: [
      "order.start",
      "order.get",
      "query.sql",
      "public.list",
      "capacity.get",
      "extensionSettings.list",
      "order.settings.get",
    ],
    modules: ["ops", "routine-mail", "email-send"],
  },
  objects: {
    event: {
      label: "Event",
      plural: "Events",
      icon: "calendar",
      titleField: "name",
      description: "Something tickets are sold for: a camp, a workshop, a night.",
      navigation: "main",
      navigationOrder: 10,
      fields: {
        name: { type: "text", label: "Name", required: true },
        startsAt: { type: "datetime", label: "Starts" },
        endsAt: { type: "datetime", label: "Ends" },
        // Where the event's clock is (ADR 0460): its days and times are this zone's, for buyers,
        // holders, the emails and the reminders. Left empty, the deployment's zone.
        timezone: {
          type: "timezone",
          label: "Time zone",
          required: true,
          description:
            "The event's own time zone, e.g. Asia/Bangkok for a camp in Thailand. Its dates are " +
            "shown, and its reminders sent, on this zone's days. Empty: this deployment's zone.",
        },
        venue: { type: "text", label: "Venue" },
        // Where the event is, for tax at checkout (ADR 0479): admission is taxed where the event
        // is held, so the payment provider is given this address, not the buyer's. Staff only.
        taxCountry: {
          type: "text",
          label: "Country (for tax)",
          description:
            "Two letters, e.g. AU. Needed to sell tickets while tax at checkout is on: tickets " +
            "are taxed where the event is held.",
        },
        taxRegion: { type: "text", label: "State or region (for tax)" },
        taxPostcode: { type: "text", label: "Postcode (for tax)" },
        taxCity: { type: "text", label: "City (for tax)" },
        taxAddress: { type: "text", label: "Street address (for tax)" },
        description: { type: "longText", label: "Description" },
        image: { type: "url", label: "Image" },
        status: {
          type: "select",
          label: "Status",
          track: "timeline",
          options: [
            { value: "draft", label: "Draft" },
            { value: "on_sale", label: "On sale" },
            { value: "ended", label: "Ended" },
            { value: "cancelled", label: "Cancelled" },
          ],
        },
        places: {
          type: "number",
          label: "Places",
          description:
            "How many people the event holds across all its ticket types. Empty: no limit " +
            "beyond each ticket type's own.",
        },
      },
      states: {
        field: "status",
        initial: "draft",
        moves: [
          { from: "draft", to: "on_sale", by: ["staff"] },
          { from: "on_sale", to: "draft", by: ["staff"] },
          { from: "on_sale", to: "ended", by: ["staff"], final: true },
          { from: ["draft", "on_sale"], to: "cancelled", by: ["staff"], final: true },
        ],
      },
      capacity: { places: "places" },
      // The public reads an event while it is on sale (ADR 0438): what its page shows.
      public: {
        read: ["name", "startsAt", "endsAt", "timezone", "venue", "description", "image", "status"],
        when: { field: "status", in: ["on_sale"] },
      },
      // A ticket's holder reads its event whatever the event's state (ADR 0439): an ended
      // event's name, times and venue are what a ticket is looked at for.
      customerVia: {
        from: "ticketing.ticket",
        field: "event",
        read: ["name", "startsAt", "endsAt", "timezone", "venue", "status"],
      },
      indexes: [["status", "startsAt"], ["startsAt"]],
    },
    tickettype: {
      label: "Ticket type",
      plural: "Ticket types",
      icon: "ticket",
      titleField: "name",
      description:
        "One kind of ticket for an event, with its own price and places: a package, a room " +
        "type. One ticket is one person.",
      navigation: "settings",
      fields: {
        event: { type: "relation", label: "Event", to: "ticketing.event", required: true },
        name: { type: "text", label: "Name", required: true },
        description: { type: "longText", label: "Description" },
        price: { type: "currency", label: "Price", required: true },
        places: {
          type: "number",
          label: "Places",
          description: "How many of this ticket type there are. Empty: only the event's limit.",
        },
        onSaleFrom: { type: "datetime", label: "On sale from" },
        onSaleUntil: { type: "datetime", label: "On sale until" },
        maxPerOrder: {
          type: "number",
          label: "Most per order",
          description: "The most one order may hold. Empty: 10.",
        },
        depositAmount: {
          type: "currency",
          label: "Deposit",
          description: "Set with a balance due date to let buyers pay a deposit now.",
        },
        balanceDue: { type: "date", label: "Balance due" },
      },
      capacity: { places: "places", pool: "event", show: "low", lowAt: 10 },
      // Where agreement may be needed (stage 44, ADR 0641): nothing is attached by default, so a
      // ticket sells as before until the business attaches a document (a waiver) to "event". The
      // buyer agrees for themselves (ADR 0644).
      agreements: { point: "event", label: "Buying a ticket", suggests: ["waiver"] },
      sellable: {
        price: "price",
        saleWindow: { from: "onSaleFrom", until: "onSaleUntil" },
        maxPerOrder: "maxPerOrder",
        deposit: { amount: "depositAmount", balanceDue: "balanceDue" },
        grants: {
          object: "ticket",
          set: {
            name: "line.title",
            tickettype: "item",
            event: "item.event",
            holder: "order.person",
            order: "order",
            code: "code",
          },
          void: "void",
        },
        // Tax at checkout (ADR 0479), only once a human admin turns it on: Stripe's "Admission to
        // Amusement, Entertainment & Recreation Venues – Participant", taxed at the event's place.
        // Which code fits the company's events is its accountant's call; an admin may change it
        // in Settings → Orders.
        tax: {
          code: "txcd_50010001",
          place: {
            via: "event",
            country: "taxCountry",
            region: "taxRegion",
            postcode: "taxPostcode",
            city: "taxCity",
            line1: "taxAddress",
          },
        },
        // In the finance reports (ADR 0792): earned when the event starts.
        finance: {
          category: { key: "tickets", label: "Tickets" },
          earned: "at_date",
          at: "event.startsAt",
        },
      },
      // A ticket type is public while its event is on sale; its places are capacity.get's.
      public: {
        read: [
          "event",
          "name",
          "description",
          "price",
          "onSaleFrom",
          "onSaleUntil",
          "maxPerOrder",
          "depositAmount",
          "balanceDue",
        ],
        when: { via: "event", field: "status", in: ["on_sale"] },
      },
      // A ticket's holder reads the name of its ticket type, whatever its event's state. Reading
      // it is not buying it: a customer buys only what they may read as the public (ADR 0439).
      customerVia: { from: "ticketing.ticket", field: "tickettype", read: ["name"] },
      indexes: [["event"]],
    },
    ticket: {
      label: "Ticket",
      plural: "Tickets",
      icon: "ticket-check",
      titleField: "name",
      description:
        "One person's ticket, granted by the host when its order was paid, with a code that " +
        "is checked at the door.",
      navigation: "main",
      navigationOrder: 11,
      fields: {
        name: { type: "text", label: "Name", required: true },
        code: {
          type: "text",
          label: "Code",
          readOnly: true,
          description:
            "Made by the host when the ticket is granted. The QR code carries only this.",
        },
        tickettype: {
          type: "relation",
          label: "Ticket type",
          to: "ticketing.tickettype",
          required: true,
        },
        event: { type: "relation", label: "Event", to: "ticketing.event", required: true },
        holder: { type: "relation", label: "Holder", to: "person" },
        // Which order granted it, set by the host's grant (ADR 0590, the fourth review): never
        // written by a caller, or a ticket could be moved to another buyer's order and mailed.
        order: {
          type: "text",
          label: "Order",
          readOnly: true,
          description: "The order that granted this ticket, set by the host.",
        },
        state: {
          type: "select",
          label: "State",
          track: "timeline",
          options: [
            { value: "valid", label: "Valid" },
            { value: "used", label: "Used" },
            { value: "void", label: "Void" },
          ],
        },
        usedAt: { type: "datetime", label: "Checked in at" },
        usedBy: { type: "user", label: "Checked in by" },
        usedByName: {
          type: "text",
          label: "Checked in by (name)",
          description: "The name of whoever checked the ticket in, as it was then.",
        },
      },
      states: {
        field: "state",
        initial: "valid",
        moves: [
          { from: "valid", to: "used", by: ["staff"] },
          { from: "used", to: "valid", by: ["staff"] },
          { from: ["valid", "used"], to: "void", by: ["staff", "host"], final: true },
        ],
      },
      // The holder reads their ticket's event, type, code and state, and changes nothing.
      customer: { field: "holder", read: ["event", "tickettype", "code", "state"], write: [] },
      timelineLinks: ["holder"],
      indexes: [["code"], ["event", "state"], ["holder"], ["order"]],
    },
  },
  views: {
    onSale: {
      label: "On sale",
      object: "ticketing.event",
      filter: { field: "status", op: "eq", value: "on_sale" },
      sort: { field: "startsAt", direction: "asc" },
      columns: ["name", "startsAt", "venue", "places", "taken", "available"],
    },
    thisWeek: {
      label: "This week's events",
      object: "ticketing.event",
      filter: {
        and: [
          { field: "startsAt", op: "gte", value: { $relative: "startOfWeek" } },
          { field: "startsAt", op: "lt", value: { $relative: "startOfNextWeek" } },
        ],
      },
      sort: { field: "startsAt", direction: "asc" },
      columns: ["name", "startsAt", "venue", "status", "taken"],
    },
    unusedTickets: {
      label: "Unused tickets",
      object: "ticketing.ticket",
      filter: { field: "state", op: "eq", value: "valid" },
      sort: { field: "createdAt", direction: "desc" },
      columns: ["name", "event", "tickettype", "holder", "code", "createdAt"],
    },
  },
  dashboards: ticketingDashboards,
  // A buyer's tickets on their Person page; check-ins post to their timeline through the
  // ticket's tracked state and its holder link, and orders through the host (ADR 0429).
  recordTabs: {
    personTickets: {
      label: "Tickets",
      on: "person",
      view: {
        type: "table",
        object: "ticketing.ticket",
        relation: "holder",
        columns: ["name", "event", "tickettype", "state", "usedAt", "code"],
        sort: { field: "createdAt", direction: "desc" },
      },
      order: 30,
    },
  },
  settings: {
    ticketsUrl: {
      type: "text",
      label: "Where buyers see their tickets",
      description:
        "The page on your site or app where a signed-in buyer sees their tickets. Linked from the " +
        "tickets email, with ?order=<id>, when it is on your site (Settings → Routine email).",
      // The link in every buyer's email: a person's to change.
      personApproves: true,
    },
    payUrl: {
      type: "text",
      label: "Where buyers pay a balance",
      description:
        "The page where a signed-in buyer pays what is owed on an order. Linked from the balance " +
        "reminders, with ?order=<id>, when it is on your site (Settings → Routine email).",
      personApproves: true,
    },
  },
  // The buyer's and the holder's email (ADR 0590): routine mail the host sends on its own.
  routineMail: ticketingRoutineMail,
  // What a journey can start or stop on (stage 53, ADR 0802), about a ticket's holder: the host
  // records the last time each had each, in the write's batch.
  journeySignals: {
    ticketBought: {
      label: "Ticket bought",
      description: "A ticket is granted to its holder when its order is paid.",
      object: "ticket",
    },
    checkedIn: {
      label: "Checked in at an event",
      description: "A ticket is checked in at the door.",
      object: "ticket",
      enters: ["used"],
      from: ["valid"],
    },
  },
  automations: ticketingAutomations,
  roles: {
    door: {
      label: "Door",
      description:
        "Checks tickets in at the door and sees events, ticket types and tickets. Nothing " +
        "else: no people, orders, leads or settings.",
      permissions: ["ticketing:checkin"],
      read: ["ticketing.event", "ticketing.tickettype", "ticketing.ticket"],
    },
  },
  tools: { eventsOnSale, orderStart, myTickets, salesSummary, checkIn, undoCheckIn },
});
