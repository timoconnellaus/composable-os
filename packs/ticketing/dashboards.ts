// The Ticket sales dashboard (stage 27, step 4): revenue and tickets sold by event and by day, and
// the places left. Read-only SQL over the rec_* views; revenue is the order lines the host priced,
// of orders paid in full or by deposit. Each widget opens the records it counted.
import type { DashboardDeclaration } from "@composable-os/sdk";

const SOLD = "o.state IN ('paid', 'part_paid')";
const PAID_IN = "o.paid_at >= :paid_from AND o.paid_at < :paid_to";
const LINES = `FROM rec_order_line l JOIN rec_order o ON o.id = l.order_id
  JOIN rec_x_ticketing_tickettype tt ON tt.id = l.record_id
  JOIN rec_x_ticketing_event e ON e.id = tt.event
  WHERE l.object_type = 'ticketing.tickettype' AND ${SOLD} AND ${PAID_IN}`;

export const ticketSales: DashboardDeclaration = {
  title: "Ticket sales",
  description: "Revenue and tickets sold by event and by day, and the places each event has left.",
  filters: [{ type: "dateRange", id: "paid", label: "Paid", default: "this_quarter" }],
  widgets: [
    {
      id: "revenue",
      type: "kpi",
      title: "Revenue",
      description: "Line totals of ticket orders paid in full or by deposit in the period.",
      sql: `SELECT coalesce(sum(l.line_total), 0) / 100.0 AS value ${LINES}`,
      mapping: { value: "value" },
      options: { compare: true, format: "currency" },
      layout: { w: 4, h: 1 },
    },
    {
      id: "sold",
      type: "kpi",
      title: "Tickets sold",
      description: "Tickets on orders paid in full or by deposit in the period.",
      sql: `SELECT coalesce(sum(l.quantity), 0) AS value ${LINES}`,
      mapping: { value: "value" },
      options: { compare: true },
      layout: { w: 4, h: 1 },
    },
    {
      id: "unused",
      type: "kpi",
      title: "Valid tickets not yet used",
      description: "Tickets that are valid and not checked in, for every event.",
      sql: "SELECT count(*) AS value FROM rec_x_ticketing_ticket t WHERE t.state = 'valid'",
      mapping: { value: "value" },
      options: { compare: false },
      clickThrough: {
        object: "ticketing.ticket",
        filter: { field: "state", op: "eq", value: "valid" },
      },
      layout: { w: 4, h: 1 },
    },
    {
      id: "by-event",
      type: "bar",
      title: "Sold by event",
      description: "Tickets sold and revenue per event in the period.",
      sql: `SELECT e.id AS event_id, e.name AS event, sum(l.quantity) AS tickets,
  sum(l.line_total) / 100.0 AS revenue ${LINES}
GROUP BY e.id, e.name ORDER BY tickets DESC LIMIT 20`,
      mapping: { x: "event", y: ["tickets"] },
      clickThrough: {
        object: "ticketing.ticket",
        filter: { field: "event", op: "eq", value: { $row: "event_id" } },
      },
      layout: { w: 6, h: 2 },
    },
    {
      id: "by-day",
      type: "line",
      title: "Sold by day",
      description: "Tickets sold per day in the period, by when the order was paid.",
      sql: `SELECT substr(o.paid_at, 1, 10) AS day, sum(l.quantity) AS tickets ${LINES}
GROUP BY day ORDER BY day`,
      mapping: { x: "day", y: ["tickets"] },
      layout: { w: 6, h: 2 },
    },
    {
      id: "places",
      type: "table",
      title: "Places left",
      description:
        "Each event on sale: its places, how many are taken or held, and how many are left.",
      // Places are the host's counters (rec_capacity), not columns of the event's own view.
      sql: `SELECT e.id AS id, e.name AS event, e.starts_at AS starts, c.places AS places,
  c.taken AS taken, c.held AS held, c.available AS available
FROM rec_x_ticketing_event e
LEFT JOIN rec_capacity c ON c.object_type = 'ticketing.event' AND c.record_id = e.id
WHERE e.status = 'on_sale' ORDER BY e.starts_at LIMIT 50`,
      mapping: { columns: ["event", "starts", "places", "taken", "held", "available"] },
      clickThrough: {
        object: "ticketing.event",
        filter: { field: "id", op: "eq", value: { $row: "id" } },
      },
      layout: { w: 12, h: 2 },
    },
  ],
};

export const ticketingDashboards = { ticketSales };
