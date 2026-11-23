// The Ticketing tools. They become operations x.ticketing.<tool>, run in the sandbox, and reach
// the host only through ctx.ops. None of them holds a rule: prices, the sale window, the most per
// order, places, who may see a ticket and that a ticket is used once are all the host's. A tool
// asks, and reports what the host answered.
import { defineTool, type ExtensionContext, OpsCallError, z } from "@composable-os/sdk";

const EVENT = "ticketing.event";
const TICKET_TYPE = "ticketing.tickettype";
const TICKET = "ticketing.ticket";

interface RecordShape {
  id: string;
  title: string | null;
  values: Record<string, unknown>;
}

interface ListShape {
  items: RecordShape[];
  nextCursor?: string | null;
  /** On a sellable object's records (a ticket type): the currency its prices are in. */
  currency?: string | null;
}

const text = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);
const num = (value: unknown): number | null =>
  typeof value === "number" ? value : value == null ? null : Number(value);

// --- On sale -------------------------------------------------------------------------------------

const availability = z.object({
  status: z.enum(["available", "low", "sold_out"]),
  available: z.number().nullable().optional().describe("Places left, when the type says so"),
});

const currency = z
  .string()
  .nullable()
  .describe(
    "The currency the prices are in (ISO 4217): the deployment's one currency, from the host. " +
      "Null until an admin sets it, and until then nothing can be bought.",
  );

/** An event's own time zone: its days and times are this zone's (ADR 0460). */
const timeZone = z
  .string()
  .nullable()
  .describe(
    "The event's IANA time zone, e.g. Asia/Bangkok: show its start and end, and count its days, " +
      "in this zone. Null only for an event made before events had one.",
  );

export const eventsOnSale = defineTool({
  description:
    "The events on sale now, soonest first, each with its ticket types (name, price and its " +
    "currency, sale window, most per order, deposit) and whether places are left. Prices and " +
    "deposits are in the major unit of `currency` (45.5 is 45.50). For an event page or a list " +
    "of events. Only what the public may read: an event that is not on sale is not here. " +
    "Read-only.",
  input: z.object({
    event: z.string().min(1).max(64).optional().describe("Only this event"),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  output: z.object({
    events: z.array(
      z.object({
        id: z.string(),
        name: z.string().nullable(),
        startsAt: z.string().nullable().describe("When it starts (ISO 8601, UTC)"),
        endsAt: z.string().nullable(),
        timeZone,
        venue: z.string().nullable(),
        description: z.string().nullable(),
        image: z.string().nullable(),
        availability,
        ticketTypes: z.array(
          z.object({
            id: z.string(),
            name: z.string().nullable(),
            description: z.string().nullable(),
            price: z.number().nullable(),
            currency,
            onSaleFrom: z.string().nullable(),
            onSaleUntil: z.string().nullable(),
            maxPerOrder: z.number().nullable(),
            deposit: z.number().nullable(),
            balanceDue: z.string().nullable(),
            availability,
          }),
        ),
      }),
    ),
  }),
  risk: "read",
  audiences: ["customer", "public"],
  async handler(input, ctx) {
    // The seam decides which events and which fields: the public scope shows an event only
    // while it is on sale, and a ticket type only while its event is (ADR 0438).
    const events = await ctx.ops.call<ListShape>("public.list", {
      object: EVENT,
      ...(input.event ? { filter: { field: "id", op: "eq", value: input.event } } : {}),
      sort: { field: "startsAt", direction: "asc" },
      limit: input.limit,
    });
    const places = async (object: string, id: string) => {
      const view = await ctx.ops.call<{
        status: "available" | "low" | "sold_out";
        available?: number | null;
      }>("capacity.get", { object, id });
      return {
        status: view.status,
        ...(view.available === undefined ? {} : { available: view.available }),
      };
    };
    const out = [];
    for (const event of events.items) {
      const types = await ctx.ops.call<ListShape>("public.list", {
        object: TICKET_TYPE,
        filter: { field: "event", op: "eq", value: event.id },
        limit: 50,
      });
      const v = event.values;
      out.push({
        id: event.id,
        name: text(v.name),
        startsAt: text(v.startsAt),
        endsAt: text(v.endsAt),
        timeZone: text(v.timezone),
        venue: text(v.venue),
        description: text(v.description),
        image: text(v.image),
        availability: await places(EVENT, event.id),
        ticketTypes: await Promise.all(
          types.items.map(async (type) => ({
            id: type.id,
            name: text(type.values.name),
            description: text(type.values.description),
            price: num(type.values.price),
            // What currency the prices are in is the host's to say, beside them (ADR 0435).
            currency: types.currency ?? null,
            onSaleFrom: text(type.values.onSaleFrom),
            onSaleUntil: text(type.values.onSaleUntil),
            maxPerOrder: num(type.values.maxPerOrder),
            deposit: num(type.values.depositAmount),
            balanceDue: text(type.values.balanceDue),
            availability: await places(TICKET_TYPE, type.id),
          })),
        ),
      });
    }
    return { events: out };
  },
});

// --- Buying -------------------------------------------------------------------------------------

const orderLine = z.object({
  id: z.string(),
  ticketTypeId: z.string(),
  title: z.string(),
  quantity: z.number(),
  unitPrice: z.number(),
  total: z.number(),
});

const orderOutput = z.object({
  id: z.string(),
  state: z.string(),
  currency: z.string(),
  total: z.number().describe("In the currency's minor unit (cents)"),
  paid: z.number(),
  balance: z.number(),
  pay: z.string(),
  deposit: z.number().nullable(),
  balanceDueAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  lines: z.array(orderLine),
  token: z
    .string()
    .nullable()
    .describe("A guest's key to this order, shown once (order.checkout and order.view take it)"),
});

interface HostOrder {
  id: string;
  state: string;
  currency: string;
  total: number;
  paid: number;
  balance: number;
  pay: string;
  deposit: number | null;
  balanceDueAt: string | null;
  expiresAt: string | null;
  lines: {
    id: string;
    recordId: string;
    title: string;
    quantity: number;
    unitPrice: number;
    total: number;
  }[];
  token?: string | null;
}

export const orderStart = defineTool({
  description:
    "Start an order for tickets: one or more ticket types and how many of each, paid in full or " +
    "by deposit when every ticket type offers one. A signed-in customer buys as themselves; a " +
    "guest gives their email address. The host prices the order from the ticket types, refuses " +
    "a ticket type outside its sale window, over its most per order or without enough places " +
    "left (with details naming the rule), and holds the places while the order is unpaid. " +
    "Nothing is paid here: the buyer then calls order.checkout with the order's id (and a " +
    "guest's token) to pay on the provider's page. Amounts are in the minor unit.",
  input: z.object({
    lines: z
      .array(
        z.object({
          ticketTypeId: z.string().min(1).max(64).describe("The ticket type (its record id)"),
          quantity: z.number().int().min(1).max(100).default(1),
        }),
      )
      .min(1)
      .max(20),
    pay: z.enum(["full", "deposit"]).default("full"),
    email: z
      .string()
      .trim()
      .max(320)
      .optional()
      .describe("A guest's email address. A signed-in customer passes none."),
    agreements: z
      .array(z.record(z.string(), z.unknown()))
      .max(20)
      .optional()
      .describe(
        "A guest only: their acceptances of what is due, passed on to the host as they are (each " +
          "{ versionId, typedName, signature?, answers? }); the host checks and records them. A " +
          "signed-in member agrees first.",
      ),
  }),
  output: orderOutput,
  risk: "write",
  audiences: ["customer", "public"],
  async handler(input, ctx) {
    const order = await ctx.ops.call<HostOrder>("order.start", {
      lines: input.lines.map((line) => ({
        object: TICKET_TYPE,
        id: line.ticketTypeId,
        quantity: line.quantity,
      })),
      pay: input.pay,
      ...(input.email === undefined ? {} : { email: input.email }),
      ...(input.agreements === undefined ? {} : { agreements: input.agreements }),
    });
    return {
      id: order.id,
      state: order.state,
      currency: order.currency,
      total: order.total,
      paid: order.paid,
      balance: order.balance,
      pay: order.pay,
      deposit: order.deposit ?? null,
      balanceDueAt: order.balanceDueAt ?? null,
      expiresAt: order.expiresAt ?? null,
      lines: order.lines.map((line) => ({
        id: line.id,
        ticketTypeId: line.recordId,
        title: line.title,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        total: line.total,
      })),
      token: order.token ?? null,
    };
  },
});

// --- A customer's tickets -------------------------------------------------------------------------

export const myTickets = defineTool({
  description:
    "The signed-in customer's own tickets: each with its event (id, name, start, end, venue " +
    "and state, as they are now, whether or not the event is still on sale), its ticket type " +
    "(id and name), its code and its state (valid, used or void). Only the caller's tickets " +
    "exist here; a code that is not theirs finds nothing. Filter by event or by code. Read-only.",
  input: z.object({
    event: z.string().min(1).max(64).optional().describe("Only tickets for this event"),
    code: z.string().trim().min(1).max(64).optional().describe("Only the ticket with this code"),
    state: z.enum(["valid", "used", "void"]).optional(),
    cursor: z.string().max(1000).optional(),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  output: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        event: z.string().nullable(),
        ticketType: z.string().nullable(),
        code: z.string().nullable(),
        state: z.string().nullable(),
        eventName: z.string().nullable(),
        startsAt: z.string().nullable().describe("When the event starts (ISO 8601, UTC)"),
        endsAt: z.string().nullable(),
        timeZone,
        venue: z.string().nullable(),
        eventStatus: z
          .string()
          .nullable()
          .describe("The event's state now: draft, on_sale, ended or cancelled"),
        ticketTypeName: z.string().nullable(),
      }),
    ),
    nextCursor: z.string().nullable(),
  }),
  risk: "read",
  audiences: ["customer"],
  async handler(input, ctx) {
    const conditions = [
      ...(input.event ? [{ field: "event", op: "eq", value: input.event }] : []),
      ...(input.code ? [{ field: "code", op: "eq", value: input.code }] : []),
      ...(input.state ? [{ field: "state", op: "eq", value: input.state }] : []),
    ];
    // The host's seam gives a customer their own tickets and the fields the ticket declares for
    // them, and nothing else: no filter here decides whose tickets these are.
    const page = await ctx.ops.call<ListShape>("my.list", {
      object: TICKET,
      ...(conditions.length === 0
        ? {}
        : { filter: conditions.length === 1 ? conditions[0] : { and: conditions } }),
      limit: input.limit,
      ...(input.cursor ? { cursor: input.cursor } : {}),
    });
    // Their tickets' events and ticket types, as they are now: the seam lets a holder read the
    // fields those objects declare for them (customerVia, ADR 0439), whatever the event's state,
    // and only for records one of their own tickets points to.
    const pointed = async (object: string, field: string) => {
      const ids = [...new Set(page.items.map((t) => text(t.values[field])).filter(Boolean))];
      if (!ids.length) return new Map<string, Record<string, unknown>>();
      const found = await ctx.ops.call<ListShape>("my.list", {
        object,
        filter: { field: "id", op: "in", value: ids },
        limit: ids.length,
      });
      return new Map(found.items.map((item) => [item.id, item.values]));
    };
    const events = await pointed(EVENT, "event");
    const types = await pointed(TICKET_TYPE, "tickettype");
    return {
      items: page.items.map((ticket) => {
        const eventId = text(ticket.values.event);
        const typeId = text(ticket.values.tickettype);
        const event = (eventId && events.get(eventId)) || {};
        const type = (typeId && types.get(typeId)) || {};
        return {
          id: ticket.id,
          event: eventId,
          ticketType: typeId,
          code: text(ticket.values.code),
          state: text(ticket.values.state),
          eventName: text(event.name),
          startsAt: text(event.startsAt),
          endsAt: text(event.endsAt),
          timeZone: text(event.timezone),
          venue: text(event.venue),
          eventStatus: text(event.status),
          ticketTypeName: text(type.name),
        };
      }),
      nextCursor: page.nextCursor ?? null,
    };
  },
});

// --- Sales ----------------------------------------------------------------------------------------

export const salesSummary = defineTool({
  description:
    "How one event is selling, per ticket type: places sold (taken), held by orders being paid, " +
    "remaining (null when unlimited), and revenue (the line totals of orders paid in full or by " +
    "deposit, in the currency's minor unit), with the event's totals and the currency. Prices " +
    "are in the major unit. For the dashboard and for questions such as 'how are sales going'. " +
    "Read-only.",
  input: z.object({ eventId: z.string().min(1).max(64) }),
  output: z.object({
    event: z.object({ id: z.string(), name: z.string().nullable(), status: z.string().nullable() }),
    currency,
    ticketTypes: z.array(
      z.object({
        id: z.string(),
        name: z.string().nullable(),
        price: z.number().nullable(),
        sold: z.number(),
        held: z.number(),
        remaining: z.number().nullable(),
        revenue: z.number(),
      }),
    ),
    totals: z.object({
      sold: z.number(),
      held: z.number(),
      remaining: z.number().nullable(),
      revenue: z.number(),
    }),
  }),
  risk: "read",
  async handler(input, ctx) {
    const event = await ctx.ops.call<RecordShape>("record.get", {
      object: EVENT,
      id: input.eventId,
    });
    const types = await ctx.ops.call<ListShape>("record.list", {
      object: TICKET_TYPE,
      filter: { field: "event", op: "eq", value: event.id },
      sort: { field: "name", direction: "asc" },
      limit: 200,
    });
    const revenue = new Map<string, number>();
    if (types.items.length) {
      // Revenue from the order lines the host snapshotted: paid in full, or by deposit.
      const ids = types.items.map((t) => t.id);
      const result = await ctx.ops.call<{ rows: { id: string; revenue: number | null }[] }>(
        "query.sql",
        {
          sql:
            "SELECT l.record_id AS id, SUM(l.line_total) AS revenue FROM rec_order_line l " +
            "JOIN rec_order o ON o.id = l.order_id WHERE l.object_type = ? " +
            `AND o.state IN ('paid', 'part_paid') AND l.record_id IN (${ids.map(() => "?").join(", ")}) ` +
            "GROUP BY l.record_id",
          params: [TICKET_TYPE, ...ids],
        },
      );
      for (const row of result.rows) revenue.set(row.id, Number(row.revenue ?? 0));
    }
    const ticketTypes = types.items.map((type) => ({
      id: type.id,
      name: text(type.values.name),
      price: num(type.values.price),
      sold: num(type.values.taken) ?? 0,
      held: num(type.values.held) ?? 0,
      remaining: num(type.values.available),
      revenue: revenue.get(type.id) ?? 0,
    }));
    const eventLeft = num(event.values.available);
    const typesLeft = ticketTypes.every((t) => t.remaining !== null)
      ? ticketTypes.reduce((sum, t) => sum + (t.remaining ?? 0), 0)
      : null;
    const settings = await ctx.ops.call<{ currency: string | null }>("order.settings.get", {});
    return {
      event: { id: event.id, name: text(event.values.name), status: text(event.values.status) },
      currency: settings.currency ?? null,
      ticketTypes,
      totals: {
        sold: ticketTypes.reduce((sum, t) => sum + t.sold, 0),
        held: ticketTypes.reduce((sum, t) => sum + t.held, 0),
        // The fewer of the event's places left and the ticket types' own.
        remaining:
          eventLeft === null
            ? typesLeft
            : typesLeft === null
              ? eventLeft
              : Math.min(eventLeft, typesLeft),
        revenue: ticketTypes.reduce((sum, t) => sum + t.revenue, 0),
      },
    };
  },
});

// --- Check-in -------------------------------------------------------------------------------------

/** A granted ticket's code: 26 characters of Crockford base32 (ADR 0435). */
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** A code as a scanner or a person typed it: case, spaces and dashes do not matter. */
export function normaliseCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "");
}

const ticketOutput = z.object({
  id: z.string(),
  name: z.string().nullable(),
  event: z.string().nullable(),
  ticketType: z.string().nullable(),
  holder: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  state: z.string().nullable(),
  usedAt: z.string().nullable(),
  usedBy: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
});
type TicketOut = z.infer<typeof ticketOutput>;

const checkInOutput = z.object({
  result: z
    .enum(["accepted", "already_used", "void", "unknown"])
    .describe(
      "accepted: let them in. already_used: this code was checked in before (see usedAt and " +
        "usedBy). void: the ticket was cancelled or refunded. unknown: no ticket has this code.",
    ),
  accepted: z.boolean(),
  message: z.string(),
  ticket: ticketOutput.nullable(),
  balanceOwing: z
    .object({
      amount: z.number().describe("In the currency's minor unit"),
      currency: z.string(),
      dueAt: z.string().nullable(),
    })
    .nullable()
    .describe("Set when the ticket's order still has a balance to pay. It does not refuse entry."),
});

type Ctx = ExtensionContext;

async function personName(ctx: Ctx, id: string): Promise<string | null> {
  try {
    const person = await ctx.ops.call<{ displayName?: string | null } | null>("person.get", { id });
    return person?.displayName ?? null;
  } catch (error) {
    if (error instanceof OpsCallError && error.code === "not_found") return null;
    throw error;
  }
}

async function describeTicket(ctx: Ctx, ticket: RecordShape): Promise<TicketOut> {
  const v = ticket.values;
  const holder = text(v.holder);
  const usedBy = text(v.usedBy);
  return {
    id: ticket.id,
    name: text(v.name),
    event: text(v.event),
    ticketType: text(v.tickettype),
    holder: holder ? { id: holder, name: await personName(ctx, holder) } : null,
    state: text(v.state),
    usedAt: text(v.usedAt),
    usedBy: usedBy ? { id: usedBy, name: text(v.usedByName) } : null,
  };
}

/** What a ticket that cannot be let in is reported as. */
function refusedFor(ticket: TicketOut): z.infer<typeof checkInOutput> | null {
  if (ticket.state === "void") {
    return {
      result: "void",
      accepted: false,
      message: "This ticket was cancelled or refunded. It is not valid.",
      ticket,
      balanceOwing: null,
    };
  }
  if (ticket.state === "used") {
    const who = ticket.usedBy?.name ?? "someone";
    return {
      result: "already_used",
      accepted: false,
      message: `Already checked in${ticket.usedAt ? ` at ${ticket.usedAt}` : ""} by ${who}.`,
      ticket,
      balanceOwing: null,
    };
  }
  return null;
}

async function balanceOwing(
  ctx: Ctx,
  orderId: string | null,
): Promise<z.infer<typeof checkInOutput>["balanceOwing"]> {
  if (!orderId) return null;
  const order = await ctx.ops.call<{
    state: string;
    balance: number;
    currency: string;
    balanceDueAt: string | null;
  }>("order.get", { id: orderId });
  if (order.state !== "part_paid" || order.balance <= 0) return null;
  return { amount: order.balance, currency: order.currency, dueAt: order.balanceDueAt ?? null };
}

const checkInInput = z.object({
  code: z.string().trim().min(1).max(64).describe("The code on the ticket, as scanned"),
});

async function checkInHandler(
  input: z.output<typeof checkInInput>,
  ctx: Ctx,
): Promise<z.infer<typeof checkInOutput>> {
  const code = normaliseCode(input.code);
  const unknown = {
    result: "unknown" as const,
    accepted: false,
    message: "No ticket has this code. Check it was scanned whole, or look the buyer up.",
    ticket: null,
    balanceOwing: null,
  };
  if (!CODE_RE.test(code)) return unknown;
  const found = await ctx.ops.call<ListShape>("record.list", {
    object: TICKET,
    filter: { field: "code", op: "eq", value: code },
    limit: 1,
  });
  const record = found.items[0];
  if (!record) return unknown;
  const before = await describeTicket(ctx, record);
  const refused = refusedFor(before);
  if (refused) return refused;
  const usedAt = new Date().toISOString();
  const staff = ctx.caller?.kind === "staff" ? ctx.caller : null;
  const usedBy = staff?.userId ?? null;
  try {
    // Moved out of `valid` only if it is still valid when the host writes it (ADR 0437): of two
    // scanners at the same moment, one is let in and the other told who was first.
    await ctx.ops.call("record.update", {
      object: TICKET,
      id: record.id,
      from: "valid",
      values: { state: "used", usedAt, usedBy, usedByName: staff?.name || null },
    });
  } catch (error) {
    if (!(error instanceof OpsCallError) || error.code !== "conflict") throw error;
    const now = await ctx.ops.call<RecordShape>("record.get", { object: TICKET, id: record.id });
    const ticket = await describeTicket(ctx, now);
    return (
      refusedFor(ticket) ?? {
        // Moved by someone and back again in the meantime: say so, and let them scan again.
        result: "unknown",
        accepted: false,
        message: "The ticket changed while it was being checked in. Scan it again.",
        ticket,
        balanceOwing: null,
      }
    );
  }
  const owing = await balanceOwing(ctx, text(record.values.order));
  const name = before.holder?.name;
  return {
    result: "accepted",
    accepted: true,
    message:
      `Valid${name ? `: ${name}` : ""}. Let them in.` +
      (owing ? ` A balance of ${(owing.amount / 100).toFixed(2)} ${owing.currency} is owing.` : ""),
    ticket: {
      ...before,
      state: "used",
      usedAt,
      usedBy: usedBy ? { id: usedBy, name: staff?.name || null } : null,
    },
    balanceOwing: owing,
  };
}

export const checkIn = defineTool({
  description:
    "Check a ticket in at the door by its code. A valid ticket is marked used and accepted; a " +
    "used one is refused with who checked it in and when; a void (cancelled or refunded) one " +
    "and an unknown code are refused with their own reasons. A ticket whose order still has a " +
    "balance owing is accepted, and the result says how much. Safe to call twice: the second " +
    "scan reports the first. Two scanners at once: one is accepted, the other told.",
  input: checkInInput,
  output: checkInOutput,
  risk: "write",
  permission: "ticketing:checkin",
  handler: checkInHandler,
});

export const undoCheckIn = defineTool({
  description:
    "Undo a check-in made by mistake: a used ticket becomes valid again and its check-in time " +
    "and person are cleared. A ticket that is not used is left as it is and the result says why.",
  input: z.object({ ticketId: z.string().min(1).max(64) }),
  output: z.object({ undone: z.boolean(), message: z.string(), ticket: ticketOutput }),
  risk: "write",
  permission: "ticketing:checkin",
  async handler(input, ctx) {
    try {
      const after = await ctx.ops.call<RecordShape>("record.update", {
        object: TICKET,
        id: input.ticketId,
        from: "used",
        values: { state: "valid", usedAt: null, usedBy: null, usedByName: null },
      });
      return {
        undone: true,
        message: "Check-in undone. The ticket is valid again.",
        ticket: await describeTicket(ctx, after),
      };
    } catch (error) {
      if (!(error instanceof OpsCallError) || error.code !== "conflict") throw error;
      const now = await ctx.ops.call<RecordShape>("record.get", {
        object: TICKET,
        id: input.ticketId,
      });
      const ticket = await describeTicket(ctx, now);
      return {
        undone: false,
        message:
          ticket.state === "void"
            ? "This ticket is void; there is no check-in to undo."
            : "This ticket is not checked in; there is nothing to undo.",
        ticket,
      };
    }
  },
});
