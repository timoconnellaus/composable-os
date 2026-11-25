// Dummy data the Ticketing previews share: one small venue's spring programme, and a customer's
// tickets for it.
import type { BuyerOrder, TicketingOperations } from "@composable-os/pack-ticketing/client";
import { at, dayAfter, TIME_ZONE } from "../../src/fake.ts";

type Out<K extends keyof TicketingOperations> = TicketingOperations[K]["output"];
type Event = Out<"x.ticketing.eventsOnSale">["events"][number];
type TicketType = Event["ticketTypes"][number];

const CURRENCY = "GBP";

function ticketType(
  t: Partial<TicketType> & Pick<TicketType, "id" | "name" | "price">,
): TicketType {
  return {
    description: null,
    currency: CURRENCY,
    onSaleFrom: null,
    onSaleUntil: null,
    maxPerOrder: 8,
    deposit: null,
    balanceDue: null,
    availability: { status: "available" },
    ...t,
  };
}

function event(e: Partial<Event> & Pick<Event, "id" | "name" | "startsAt" | "ticketTypes">): Event {
  return {
    endsAt: null,
    timeZone: TIME_ZONE,
    venue: "The Old Granary, Bristol",
    description: null,
    image: null,
    availability: { status: "available" },
    ...e,
  };
}

export const retreat = event({
  id: "ev_retreat",
  name: "Spring Yoga Retreat",
  startsAt: at("02:00", dayAfter(46)),
  endsAt: at("05:00", dayAfter(51)),
  timeZone: "Asia/Bangkok",
  venue: "Baan Suan, Chiang Mai",
  description: "Five days of morning practice, cooking classes and quiet afternoons in the hills.",
  ticketTypes: [
    ticketType({
      id: "tt_shared",
      name: "Shared room",
      price: 850,
      deposit: 200,
      balanceDue: dayAfter(30),
      maxPerOrder: 4,
    }),
    ticketType({
      id: "tt_private",
      name: "Private room",
      price: 1150,
      deposit: 300,
      balanceDue: dayAfter(30),
      maxPerOrder: 2,
      availability: { status: "low", available: 3 },
    }),
    ticketType({
      id: "tt_suite",
      name: "Garden suite",
      price: 1490,
      deposit: 400,
      balanceDue: dayAfter(30),
      maxPerOrder: 2,
      availability: { status: "sold_out", available: 0 },
    }),
  ],
});

export const onSale: Out<"x.ticketing.eventsOnSale"> = {
  events: [
    event({
      id: "ev_supper",
      name: "Spring Supper Club",
      startsAt: at("19:00", dayAfter(12)),
      endsAt: at("22:30", dayAfter(12)),
      ticketTypes: [
        ticketType({ id: "tt_dinner", name: "Dinner ticket", price: 45 }),
        ticketType({ id: "tt_wine", name: "Wine pairing", price: 25 }),
      ],
    }),
    event({
      id: "ev_sourdough",
      name: "Sourdough Masterclass",
      startsAt: at("10:00", dayAfter(19)),
      endsAt: at("14:00", dayAfter(19)),
      venue: "Harbourside Kitchen, Bristol",
      availability: { status: "low", available: 4 },
      ticketTypes: [
        ticketType({
          id: "tt_bake",
          name: "Place",
          price: 60,
          availability: { status: "low", available: 4 },
        }),
      ],
    }),
    event({
      id: "ev_jazz",
      name: "Jazz in the Courtyard",
      startsAt: at("18:30", dayAfter(26)),
      availability: { status: "sold_out", available: 0 },
      ticketTypes: [
        ticketType({
          id: "tt_jazz",
          name: "Standing",
          price: 18,
          availability: { status: "sold_out", available: 0 },
        }),
      ],
    }),
    event({
      id: "ev_10k",
      name: "Riverside 10K",
      startsAt: at("08:00", dayAfter(33)),
      venue: "Castle Park, Bristol",
      ticketTypes: [
        ticketType({ id: "tt_runner", name: "Runner", price: 28 }),
        ticketType({ id: "tt_junior", name: "Junior (under 16)", price: 12 }),
      ],
    }),
    retreat,
  ],
};

export const supperOrder: BuyerOrder = {
  id: "ord_1042",
  state: "paid",
  currency: CURRENCY,
  total: 13500,
  paid: 13500,
  balance: 0,
  pay: "full",
  deposit: null,
  balanceDueAt: null,
  expiresAt: null,
  taxAmount: 2250,
  lines: [
    {
      id: "ol_1",
      title: "Spring Supper Club · Dinner ticket",
      quantity: 2,
      unitPrice: 4500,
      total: 9000,
    },
    {
      id: "ol_2",
      title: "Spring Supper Club · Wine pairing",
      quantity: 1,
      unitPrice: 2500,
      total: 2500,
    },
    {
      id: "ol_3",
      title: "Spring Supper Club · Cookbook",
      quantity: 1,
      unitPrice: 2000,
      total: 2000,
    },
  ],
};

type MyTicket = Out<"x.ticketing.myTickets">["items"][number];

function mine(
  t: Partial<MyTicket> & Pick<MyTicket, "id" | "eventName" | "ticketTypeName" | "startsAt">,
): MyTicket {
  return {
    event: `ev_${t.id}`,
    ticketType: `tt_${t.id}`,
    code: `TK${t.id.toUpperCase()}`,
    state: "valid",
    endsAt: null,
    timeZone: TIME_ZONE,
    venue: "The Old Granary, Bristol",
    eventStatus: "on_sale",
    ...t,
  };
}

export const myTickets: Out<"x.ticketing.myTickets"> = {
  items: [
    mine({
      id: "t1",
      eventName: "Spring Supper Club",
      ticketTypeName: "Dinner ticket",
      startsAt: at("19:00", dayAfter(12)),
      code: "TK7Q-M2XR-94PA",
    }),
    mine({
      id: "t2",
      eventName: "Spring Supper Club",
      ticketTypeName: "Dinner ticket",
      startsAt: at("19:00", dayAfter(12)),
      code: "TK3H-WN8D-21LC",
    }),
    mine({
      id: "t3",
      eventName: "Riverside 10K",
      ticketTypeName: "Runner",
      startsAt: at("08:00", dayAfter(33)),
      venue: "Castle Park, Bristol",
    }),
    mine({
      id: "t4",
      eventName: "Spring Yoga Retreat",
      ticketTypeName: "Shared room",
      startsAt: retreat.startsAt,
      timeZone: "Asia/Bangkok",
      venue: "Baan Suan, Chiang Mai",
    }),
    mine({
      id: "t5",
      eventName: "Winter Wine Tasting",
      ticketTypeName: "Tasting",
      startsAt: at("19:30", "2026-02-12"),
      state: "used",
      eventStatus: "ended",
    }),
    mine({
      id: "t6",
      eventName: "Comedy Night",
      ticketTypeName: "Seated",
      startsAt: at("20:00", "2026-01-23"),
      state: "void",
      eventStatus: "cancelled",
    }),
  ],
  nextCursor: null,
};

/** What the door gets for each code the scanner reads, in order. */
export const doorScans: Out<"x.ticketing.checkIn">[] = [
  { name: "Jordan Lee", owing: null },
  { name: "Maya Patel", owing: null },
  { name: "Chris Okafor", owing: 30000 },
].map(
  ({ name, owing }, i): Out<"x.ticketing.checkIn"> => ({
    result: "accepted",
    accepted: true,
    message: `Valid: ${name}. Let them in.${owing ? ` A balance of ${(owing / 100).toFixed(2)} ${CURRENCY} is owing.` : ""}`,
    ticket: {
      id: `tk_${i + 1}`,
      name: `Spring Yoga Retreat · Shared room`,
      event: "ev_retreat",
      ticketType: "tt_shared",
      holder: { id: `p_${i + 1}`, name },
      state: "used",
      usedAt: at("09:30"),
      usedBy: { id: "p_door", name: "Sam Rivera" },
    },
    balanceOwing: owing ? { amount: owing, currency: CURRENCY, dueAt: dayAfter(30) } : null,
  }),
);
