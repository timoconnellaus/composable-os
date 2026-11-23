// The Ticketing automations (stage 27, step 4). The buyer's and the holder's emails are routine
// mail (ADR 0590): fixed emails this pack declares (routine-mail.ts), which the host composes and
// sends to the order's own address or the ticket's holder without a person's approval, unless an
// admin turned the kind off or the host holds one for a person. They go out from the email-send
// connection an admin binds when the pack is installed. One automation moves an event to ended.
// They add no rule of their own: what is paid, what is owed and when is the host's. Each declares
// its steps, so the host renders the summary from them.
import { defineAutomation, formatMoment } from "@composable-os/sdk";

const EVENT = "ticketing.event";
const TICKET = "ticketing.ticket";
const TICKET_TYPE = "ticketing.tickettype";
const DAY_MS = 86_400_000;
/** Most buyers reminded in one run of the daily balance reminders; the rest wait a day. */
export const BALANCE_BATCH = 200;

/** The email-send connection the host sends from (the binding is a person's consent). */
const MAIL = {
  id: "mail",
  gatekeeper: "email-send",
  purpose: "Send buyers their tickets and reminders",
} as const;

interface RecordShape {
  id: string;
  title: string | null;
  values: Record<string, unknown>;
}

const text = (value: unknown): string | null =>
  value === null || value === undefined || value === "" ? null : String(value);

/**
 * When an event starts, as its holders read it: the day and time in the event's own zone, and
 * the zone, so a camp in Bangkok sold from Sydney says Bangkok's time (ADR 0460). The emails
 * write it the same way (the host's `datetime` with the year).
 */
export function eventTimeText(iso: string | null, zone: string | null): string | null {
  if (!iso) return null;
  return formatMoment(iso, zone, "datetime", true) ?? iso;
}

// --- Tickets by email ---------------------------------------------------------------------------

export const ticketsByEmail = defineAutomation({
  label: "Tickets by email",
  description:
    "When an order is first paid (in full, or its deposit), emails the buyer their tickets: " +
    "one line per ticket with its code, and the page where they can show them. Routine email: " +
    "Tickets by email.",
  trigger: {
    type: "fieldChanged",
    object: "order",
    field: "state",
    from: { in: ["pending", "expired"] },
    to: { in: ["paid", "part_paid"] },
  },
  connections: [MAIL],
  steps: [
    {
      name: "findTickets",
      label: "Find the order's tickets",
      reads: [TICKET],
    },
    { name: "sendTickets", label: "Email the buyer their tickets" },
  ],
  async run(event, step, ctx) {
    const orderId = event.record?.id;
    if (!orderId) return { skipped: "no order" };
    const found = await step.do("findTickets", async () => {
      const tickets = await ctx.ops.call<{ items: RecordShape[] }>("record.list", {
        object: TICKET,
        filter: { field: "order", op: "eq", value: orderId },
        limit: 100,
      });
      return { tickets: tickets.items.length };
    });
    // An order of something else: nothing to send. The host sends to the order's own address.
    if (!found.tickets) return { sent: false, tickets: 0 };
    return step.do("sendTickets", async () => {
      const result = await ctx.routineMail.send({
        kind: "tickets",
        record: orderId,
        message: found.tickets === 1 ? "one" : "many",
      });
      return { sent: result.sent > 0, held: result.held > 0, tickets: found.tickets };
    });
  },
});

// --- The day before ------------------------------------------------------------------------------

export const eventReminder = defineAutomation({
  label: "Event reminder",
  description:
    "The day before an event on sale starts, counted in the event's own time zone, emails each " +
    "holder of a valid ticket a reminder with the time (in that zone) and the venue. Routine " +
    "email: Event reminders.",
  trigger: {
    type: "dateRelative",
    object: EVENT,
    field: "startsAt",
    offsetDays: -1,
    zoneField: "timezone",
  },
  conditions: { field: "status", op: "eq", value: "on_sale" },
  connections: [MAIL],
  steps: [
    {
      name: "findHolders",
      label: "Find the holders of valid tickets",
      reads: [TICKET],
    },
    { name: "sendReminders", label: "Email each holder" },
  ],
  async run(event, step, ctx) {
    const eventId = event.record?.id;
    if (!eventId) return { skipped: "no event" };
    const holders = await step.do("findHolders", async () => {
      // One email per holder however many tickets they hold: about their first ticket.
      const byHolder = new Map<string, string[]>();
      let cursor: string | null = null;
      do {
        const page: { items: RecordShape[]; nextCursor: string | null } = await ctx.ops.call(
          "record.list",
          {
            object: TICKET,
            filter: {
              and: [
                { field: "event", op: "eq", value: eventId },
                { field: "state", op: "eq", value: "valid" },
              ],
            },
            limit: 200,
            ...(cursor ? { cursor } : {}),
          },
        );
        for (const ticket of page.items) {
          const holder = text(ticket.values.holder);
          if (!holder) continue;
          byHolder.set(holder, [...(byHolder.get(holder) ?? []), ticket.id]);
        }
        cursor = page.nextCursor;
      } while (cursor);
      return [...byHolder.values()].map((tickets) => ({
        ticket: tickets[0] as string,
        count: tickets.length,
      }));
    });
    if (!holders.length) return { sent: 0 };
    return step.do("sendReminders", async () => {
      let sent = 0;
      for (const holder of holders) {
        const result = await ctx.routineMail.send({
          kind: "eventReminder",
          record: holder.ticket,
          message: holder.count === 1 ? "one" : "many",
          values: { count: holder.count },
        });
        sent += result.sent;
      }
      return { sent };
    });
  },
});

// --- The day after -------------------------------------------------------------------------------

export const eventEnded = defineAutomation({
  label: "Event ended",
  description:
    "The day after an event on sale ends, counted in the event's own time zone, moves it to ended.",
  trigger: {
    type: "dateRelative",
    object: EVENT,
    field: "endsAt",
    offsetDays: 1,
    zoneField: "timezone",
  },
  conditions: { field: "status", op: "eq", value: "on_sale" },
  steps: [
    {
      name: "markEnded",
      label: "Move the event to ended",
      writes: [{ object: EVENT, action: "update", count: 1 }],
    },
  ],
  async run(event, step, ctx) {
    const eventId = event.record?.id;
    if (!eventId) return { skipped: "no event" };
    return step.do("markEnded", async () => {
      // Only out of on_sale: if staff moved it meanwhile, the host refuses and nothing changes.
      try {
        await ctx.ops.call("record.update", {
          object: EVENT,
          id: eventId,
          from: "on_sale",
          values: { status: "ended" },
        });
        return { ended: true };
      } catch (error) {
        if ((error as { code?: string }).code === "conflict") return { ended: false };
        throw error;
      }
    });
  },
});

// --- Balance reminders ---------------------------------------------------------------------------

/**
 * Part-paid orders with a ticket on them whose balance falls due in exactly 7 or 1 days, counted
 * in UTC days from the run's period. Read over the host's order views.
 */
export const BALANCE_SQL = `
SELECT o.id AS id, o.email AS email, o.balance AS balance, o.currency AS currency,
  o.balance_due_at AS due
FROM rec_order o
WHERE o.state = 'part_paid' AND o.balance > 0 AND o.email IS NOT NULL
  AND substr(o.balance_due_at, 1, 10) IN (?1, ?2)
  AND EXISTS (SELECT 1 FROM rec_order_line l WHERE l.order_id = o.id AND l.object_type = '${TICKET_TYPE}')
ORDER BY o.balance_due_at, o.id
LIMIT ${BALANCE_BATCH}`;

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The day a schedule run is for (`2026-11-05` or `2026-11-05T09:00`) as epoch ms. */
function periodMs(period: string | undefined): number {
  const parsed = period ? Date.parse(period.length === 10 ? `${period}T00:00:00Z` : period) : NaN;
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

export const balanceReminders = defineAutomation({
  label: "Balance reminders",
  description:
    "Every morning, emails the buyer of a part-paid ticket order whose balance is due in a week " +
    "or tomorrow: how much is owed, when, and the link to pay. Routine email: Balance reminders.",
  trigger: { type: "schedule", cron: "0 9 * * *" },
  connections: [MAIL],
  steps: [
    {
      name: "findDue",
      label: "Find part-paid orders due in a week or tomorrow",
      calls: ["query.sql"],
    },
    { name: "sendReminders", label: "Email each buyer the balance and the link to pay" },
  ],
  async run(event, step, ctx) {
    const due = await step.do("findDue", async () => {
      const today = periodMs(event.period);
      const { rows } = await ctx.ops.call<{ rows: { id: string }[] }>("query.sql", {
        sql: BALANCE_SQL,
        params: [isoDay(today + 7 * DAY_MS), isoDay(today + DAY_MS)],
        maxRows: BALANCE_BATCH,
      });
      return rows.map((row) => row.id);
    });
    if (!due.length) return { sent: 0 };
    return step.do("sendReminders", async () => {
      let sent = 0;
      for (const orderId of due) {
        const result = await ctx.routineMail.send({ kind: "balance", record: orderId });
        sent += result.sent;
      }
      return { sent };
    });
  },
});

export const ticketingAutomations = {
  ticketsByEmail,
  eventReminder,
  eventEnded,
  balanceReminders,
};
