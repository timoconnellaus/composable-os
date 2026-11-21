// The Ticketing automations (stage 27, step 4). They send the buyer's mail through the email-send
// gatekeeper (a connection an admin binds when the pack is installed, so a person approves what
// the pack may send), move an event to ended, and add no rule of their own: what is paid, what is
// owed and when is the host's. Each declares its steps, so the host renders the summary from them.
import { defineAutomation, type ExtensionContext } from "@composable-os/sdk";

const EVENT = "ticketing.event";
const TICKET = "ticketing.ticket";
const TICKET_TYPE = "ticketing.tickettype";
const DAY_MS = 86_400_000;
/** Most buyers reminded in one run of the daily balance reminders; the rest wait a day. */
export const BALANCE_BATCH = 200;

/** The email-send connection every mail goes through. */
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

/** The pack's settings an admin set (Settings → Extensions), by name. */
async function settings(ctx: ExtensionContext): Promise<Record<string, unknown>> {
  const { items } = await ctx.ops.call<{
    items: { id: string; values: Record<string, unknown> }[];
  }>("extensionSettings.list");
  return items.find((item) => item.id === "ticketing")?.values ?? {};
}

/** A link with `?order=<id>`, or the page alone. */
function withOrder(base: unknown, orderId: string): string | null {
  const url = text(base);
  if (!url) return null;
  return `${url}${url.includes("?") ? "&" : "?"}order=${encodeURIComponent(orderId)}`;
}

/** Sends one email to one buyer through the bound email-send connection. */
async function sendMail(
  ctx: ExtensionContext,
  message: { to: string; subject: string; text: string; related?: string[] },
): Promise<unknown> {
  const gatekeeper = ctx.gatekeeper("email-send");
  const connections = await gatekeeper.connections();
  const resource =
    connections.find((c) => c.id === MAIL.id)?.resources[0]?.bindingName ??
    connections[0]?.resources[0]?.bindingName ??
    "SENDER";
  const result = await gatekeeper.call(MAIL.id, resource, "send", {
    to: [message.to],
    subject: message.subject,
    text: message.text,
    ...(message.related?.length ? { relatedRecords: message.related.slice(0, 20) } : {}),
  });
  return result.value;
}

const money = (minor: number, currency: string) => `${(minor / 100).toFixed(2)} ${currency}`;

/**
 * When an event starts, as its holders read it: the day and time in the event's own zone, and
 * the zone, so a camp in Bangkok sold from Sydney says Bangkok's time (ADR 0460).
 */
export function eventTimeText(iso: string | null, zone: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const timeZone = zone ?? "UTC";
  try {
    const local = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(at);
    return `${local} (${timeZone.replace(/_/g, " ")} time)`;
  } catch {
    return iso;
  }
}

// --- Tickets by email ---------------------------------------------------------------------------

export const ticketsByEmail = defineAutomation({
  label: "Tickets by email",
  description:
    "When an order is first paid (in full, or its deposit), emails the buyer their tickets: " +
    "one line per ticket with its code, and the page where they can show them.",
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
      reads: [TICKET, EVENT],
      calls: ["order.get", "extensionSettings.list"],
    },
    { name: "sendTickets", label: "Email the buyer their tickets" },
  ],
  async run(event, step, ctx) {
    const orderId = event.record?.id;
    if (!orderId) return { skipped: "no order" };
    const found = await step.do("findTickets", async () => {
      const order = await ctx.ops.call<{ email: string | null; state: string }>("order.get", {
        id: orderId,
      });
      const tickets = await ctx.ops.call<{ items: RecordShape[] }>("record.list", {
        object: TICKET,
        filter: { field: "order", op: "eq", value: orderId },
        limit: 100,
      });
      const { ticketsUrl } = await settings(ctx);
      // The events the tickets are for, with when each starts in its own zone.
      const eventIds = [...new Set(tickets.items.map((t) => text(t.values.event)))].filter(
        (id): id is string => Boolean(id),
      );
      const events: string[] = [];
      for (const id of eventIds) {
        const ev = await ctx.ops.call<RecordShape>("record.get", { object: EVENT, id });
        const when = eventTimeText(text(ev.values.startsAt), text(ev.values.timezone));
        const venue = text(ev.values.venue);
        events.push(
          `${text(ev.values.name) ?? "Your event"}${when ? `: ${when}` : ""}${venue ? `, ${venue}` : ""}`,
        );
      }
      return {
        email: order.email,
        events,
        page: withOrder(ticketsUrl, orderId),
        tickets: tickets.items.map((t) => ({
          id: t.id,
          name: text(t.values.name) ?? "Ticket",
          code: text(t.values.code) ?? "",
        })),
      };
    });
    // An order of something else, or with no address: nothing to send.
    if (!found.tickets.length || !found.email) return { sent: false, tickets: 0 };
    return step.do("sendTickets", async () => {
      const lines = found.tickets.map((t) => `${t.name}: ${t.code}`);
      await sendMail(ctx, {
        to: found.email as string,
        subject:
          found.tickets.length === 1 ? "Your ticket" : `Your ${found.tickets.length} tickets`,
        text: [
          "Thank you. Your tickets are below: show the code at the door.",
          ...(found.events.length ? ["", ...found.events] : []),
          "",
          ...lines,
          ...(found.page ? ["", `See them any time: ${found.page}`] : []),
        ].join("\n"),
        related: [orderId, ...found.tickets.map((t) => t.id)],
      });
      return { sent: true, tickets: found.tickets.length };
    });
  },
});

// --- The day before ------------------------------------------------------------------------------

export const eventReminder = defineAutomation({
  label: "Event reminder",
  description:
    "The day before an event on sale starts, counted in the event's own time zone, emails each " +
    "holder of a valid ticket a reminder with the time (in that zone) and the venue.",
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
      reads: [TICKET, "person"],
    },
    { name: "sendReminders", label: "Email each holder" },
  ],
  async run(event, step, ctx) {
    const eventId = event.record?.id;
    if (!eventId) return { skipped: "no event" };
    const data = event.record?.data ?? {};
    const holders = await step.do("findHolders", async () => {
      const emails = new Map<string, string[]>();
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
          emails.set(holder, [...(emails.get(holder) ?? []), ticket.id]);
        }
        cursor = page.nextCursor;
      } while (cursor);
      const out: { email: string; tickets: string[] }[] = [];
      for (const [personId, tickets] of emails) {
        const person = await ctx.ops.call<{ primaryEmail?: string | null } | null>("person.get", {
          id: personId,
        });
        if (person?.primaryEmail) out.push({ email: person.primaryEmail, tickets });
      }
      return out;
    });
    if (!holders.length) return { sent: 0 };
    return step.do("sendReminders", async () => {
      const name = text(data.name) ?? "Your event";
      const when = eventTimeText(text(data.startsAt), text(data.timezone));
      const venue = text(data.venue);
      for (const holder of holders) {
        await sendMail(ctx, {
          to: holder.email,
          subject: `Tomorrow: ${name}`,
          text: [
            `${name} is tomorrow${when ? `, starting ${when}` : ""}${venue ? ` at ${venue}` : ""}.`,
            `You have ${holder.tickets.length === 1 ? "a ticket" : `${holder.tickets.length} tickets`}: bring the code.`,
          ].join("\n"),
          related: [eventId, ...holder.tickets],
        });
      }
      return { sent: holders.length };
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
    "or tomorrow: how much is owed, when, and the link to pay.",
  trigger: { type: "schedule", cron: "0 9 * * *" },
  connections: [MAIL],
  steps: [
    {
      name: "findDue",
      label: "Find part-paid orders due in a week or tomorrow",
      calls: ["query.sql", "extensionSettings.list"],
    },
    { name: "sendReminders", label: "Email each buyer the balance and the link to pay" },
  ],
  async run(event, step, ctx) {
    const due = await step.do("findDue", async () => {
      const today = periodMs(event.period);
      const { rows } = await ctx.ops.call<{
        rows: { id: string; email: string; balance: number; currency: string; due: string }[];
      }>("query.sql", {
        sql: BALANCE_SQL,
        params: [isoDay(today + 7 * DAY_MS), isoDay(today + DAY_MS)],
        maxRows: BALANCE_BATCH,
      });
      const { payUrl } = await settings(ctx);
      return rows.map((row) => ({ ...row, link: withOrder(payUrl, row.id) }));
    });
    if (!due.length) return { sent: 0 };
    return step.do("sendReminders", async () => {
      for (const order of due) {
        const day = order.due.slice(0, 10);
        await sendMail(ctx, {
          to: order.email,
          subject: `Balance due ${day}`,
          text: [
            `The balance on your tickets, ${money(order.balance, order.currency)}, is due on ${day}.`,
            order.link
              ? `Pay it here (sign in with this email address): ${order.link}`
              : "Reply to this email to pay it.",
            "You can pay it in one go or in parts.",
          ].join("\n"),
          related: [order.id],
        });
      }
      return { sent: due.length };
    });
  },
});

export const ticketingAutomations = {
  ticketsByEmail,
  eventReminder,
  eventEnded,
  balanceReminders,
};
