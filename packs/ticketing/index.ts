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
//     nothing else, through the visibility seam;
//   - the door role (`roles`, ADR 0436): check tickets in and read events, ticket types and
//     tickets, and nothing else.
// The tools in tools.ts compose the host's operations and add no rules of their own.
import { defineExtension } from "@composable-os/sdk";
import { checkIn, myTickets, orderStart, salesSummary, undoCheckIn } from "./tools.ts";

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
    operations: ["order.start", "order.get", "query.sql"],
    modules: ["ops"],
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
        venue: { type: "text", label: "Venue" },
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
      },
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
        order: { type: "text", label: "Order" },
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
  tools: { orderStart, myTickets, salesSummary, checkIn, undoCheckIn },
});
