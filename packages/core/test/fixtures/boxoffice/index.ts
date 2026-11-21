// A box office: the fixture extension for the `sellable` behaviour (stage 27, ADR 0435), used by
// the host's tests (packages/core/test/sellable.test.ts, apps/runner/test/payments.test.ts) and
// installed over MCP by the orders end-to-end spec, which is how a running app gets something to
// sell. It is not shipped. It declares the three behaviours ticketing stands on:
//
//   - an event with places (`capacity`);
//   - a ticket type that is for sale (`sellable`) with a sale window, a most per order and a
//     deposit, whose places are drawn from its event's (`capacity` with a pool), and which grants
//     one ticket per place bought;
//   - a ticket (`states`: valid, used, void) with the host's unguessable code.
//
// The relations name the extension by its id. Tests install it under a fresh id by rewriting
// `boxoffice.` (boxOfficeManifest in packages/core/test/sellable-fixtures.ts).
import { defineExtension } from "@composable-os/sdk";

export default defineExtension({
  id: "boxoffice",
  version: "1.0.0",
  contractVersion: 1,
  label: "Box office",
  description: "A fixture: events, ticket types for sale, and the tickets a paid order grants.",
  permissions: {},
  objects: {
    event: {
      label: "Event",
      plural: "Events",
      icon: "calendar",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name", required: true },
        startsAt: { type: "datetime", label: "Starts" },
        places: { type: "number", label: "Places" },
      },
      capacity: { places: "places" },
    },
    tickettype: {
      label: "Ticket type",
      plural: "Ticket types",
      icon: "ticket",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name", required: true },
        event: { type: "relation", label: "Event", to: "boxoffice.event", required: true },
        price: { type: "currency", label: "Price" },
        places: { type: "number", label: "Places" },
        onSaleFrom: { type: "datetime", label: "On sale from" },
        onSaleUntil: { type: "datetime", label: "On sale until" },
        maxPerOrder: { type: "number", label: "Most per order" },
        depositAmount: { type: "currency", label: "Deposit" },
        balanceDue: { type: "date", label: "Balance due" },
      },
      capacity: { places: "places", pool: "event", show: "exact" },
      sellable: {
        price: "price",
        saleWindow: { from: "onSaleFrom", until: "onSaleUntil" },
        maxPerOrder: "maxPerOrder",
        deposit: { amount: "depositAmount", balanceDue: "balanceDue" },
        grants: {
          object: "ticket",
          set: {
            name: "line.title",
            ticketType: "item",
            event: "item.event",
            holder: "order.person",
            email: "order.email",
            orderId: "order",
            code: "code",
          },
          void: "void",
        },
      },
    },
    ticket: {
      label: "Ticket",
      plural: "Tickets",
      icon: "ticket-check",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name", required: true },
        code: { type: "text", label: "Code", readOnly: true },
        ticketType: {
          type: "relation",
          label: "Ticket type",
          to: "boxoffice.tickettype",
          required: true,
        },
        event: { type: "relation", label: "Event", to: "boxoffice.event", required: true },
        holder: { type: "relation", label: "Holder", to: "person" },
        email: { type: "email", label: "Email" },
        orderId: { type: "text", label: "Order" },
        state: {
          type: "select",
          label: "State",
          options: [
            { value: "valid", label: "Valid" },
            { value: "used", label: "Used" },
            { value: "void", label: "Void" },
          ],
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
    },
  },
});
