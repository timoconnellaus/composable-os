// The Ticketing pack's headless entry (stage 27, step 5; ADR 0418): functions and hooks over the
// typed client, no markup. A client app imports it as `@composable-os/pack-ticketing/client` and
// hands it its generated client; the ticketing blocks render what it returns.
//
// As every pack's entry: the operations are typed from the pack's own tool schemas, it takes the
// client and the app's `useQuery`, `useMutation` and `useState` as arguments (no React or TanStack
// import), and it holds no rules. Prices, limits, places, what may be bought and whether an order
// is paid are the host's. The one sum here, `estimate`, is a preview of what the host will
// charge, shown before the order starts; the order the host returns is what is paid.
import { type ClientHolding, type PackClient, packHooks } from "@composable-os/client";
import type { z } from "@composable-os/sdk";
import type { checkIn, eventsOnSale, myTickets, orderStart, undoCheckIn } from "../tools.ts";

type Io<T extends { input: z.ZodType; output: z.ZodType }> = {
  input: z.input<T["input"]>;
  output: z.output<T["output"]>;
};

/** An order as the host shows it to its buyer (order.get, order.view), as far as this uses it. */
export interface BuyerOrder {
  id: string;
  state: "pending" | "part_paid" | "paid" | "cancelled" | "expired" | "refunded";
  currency: string;
  total: number;
  paid: number;
  balance: number;
  pay: "full" | "deposit";
  deposit: number | null;
  balanceDueAt: string | null;
  expiresAt: string | null;
  /**
   * The tax inside what has been paid, as the payment provider calculated it (ADR 0479). Prices
   * include it. Optional: a host from before tax at checkout does not send it.
   */
  taxAmount?: number;
  lines: { id: string; title: string; quantity: number; unitPrice: number; total: number }[];
}

/** The operations this entry calls, as the generated client types them. */
export type TicketingOperations = {
  "x.ticketing.eventsOnSale": { kind: "query" } & Io<typeof eventsOnSale>;
  "x.ticketing.myTickets": { kind: "query" } & Io<typeof myTickets>;
  "x.ticketing.orderStart": { kind: "mutation" } & Io<typeof orderStart>;
  "x.ticketing.checkIn": { kind: "mutation" } & Io<typeof checkIn>;
  "x.ticketing.undoCheckIn": { kind: "mutation" } & Io<typeof undoCheckIn>;
  "order.get": { kind: "query"; input: { id: string }; output: BuyerOrder };
  "order.view": { kind: "query"; input: { id: string; token: string }; output: BuyerOrder };
  "order.checkout": {
    kind: "mutation";
    input: { id: string; token?: string; returnUrl: string; amount?: number };
    output: { url: string; amount: number };
  };
};

type Name = keyof TicketingOperations & string;
type In<N extends Name> = TicketingOperations[N]["input"];
type Out<N extends Name> = TicketingOperations[N]["output"];

export type EventsOnSale = Out<"x.ticketing.eventsOnSale">;
export type EventOnSale = EventsOnSale["events"][number];
export type TicketTypeOnSale = EventOnSale["ticketTypes"][number];
export type MyTickets = Out<"x.ticketing.myTickets">;
export type CheckInResult = Out<"x.ticketing.checkIn">;
export type StartedOrder = Out<"x.ticketing.orderStart">;

/**
 * The client of every operation this entry calls. The hooks are written against it; the client an
 * app passes may hold fewer (a customer's, the door role's), and then gets only the hooks it can
 * back (ADR 0453).
 */
export type TicketingClient = PackClient<TicketingOperations>;

// --- Plain functions ------------------------------------------------------------------------------

const digitsByCurrency = new Map<string, number>();

/**
 * How many decimal places `currency` has (2 for AUD, 0 for JPY), for display. The currency is
 * always the host's, from the data (a ticket type's `currency`, an order's): never the app's.
 * Asked once per currency: a list of prices asks it for every line.
 */
export function currencyDigits(currency: string | null | undefined): number {
  if (!currency) return 2;
  let digits = digitsByCurrency.get(currency);
  if (digits === undefined) {
    try {
      digits =
        new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
          .maximumFractionDigits ?? 2;
    } catch {
      digits = 2;
    }
    digitsByCurrency.set(currency, digits);
  }
  return digits;
}

const withCurrency = (amount: string, currency: string | null) =>
  currency ? `${amount} ${currency}` : amount;

/** An amount in the minor unit as the buyer reads it: `450.00 AUD`. Display only. */
export function formatMoney(minor: number, currency: string | null): string {
  const digits = currencyDigits(currency);
  return withCurrency((minor / 10 ** digits).toFixed(digits), currency);
}

/** A ticket type's price (major unit, as the record holds it) as the buyer reads it. */
export function formatPrice(price: number | null, currency: string | null): string {
  return price === null ? "" : withCurrency(price.toFixed(currencyDigits(currency)), currency);
}

/** The viewer's own time zone, as their device reports it. */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * When an event starts (or ends, with `at: "endsAt"`), as a buyer or holder reads it: the day and
 * time in the event's own zone (ADR 0460), never the device's, so a camp in Bangkok reads as
 * Bangkok's time on a phone in Sydney. When the event's zone is not the viewer's, the zone is
 * said (`… (Bangkok time)`). Display only.
 */
export function eventTime(
  event: { startsAt: string | null; endsAt?: string | null; timeZone: string | null },
  options: { at?: "startsAt" | "endsAt"; viewer?: string; locale?: string } = {},
): string {
  const iso = options.at === "endsAt" ? (event.endsAt ?? null) : event.startsAt;
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const viewer = options.viewer ?? viewerTimeZone();
  const zone = event.timeZone ?? viewer;
  let text: string;
  try {
    text = new Intl.DateTimeFormat(options.locale, {
      timeZone: zone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(at);
  } catch {
    return at.toISOString();
  }
  if (zone === viewer || sameOffset(at, zone, viewer)) return text;
  const city = zone.split("/").pop()?.replace(/_/g, " ") ?? zone;
  return `${text} (${city} time)`;
}

/** Whether two zones show the same wall-clock time at `at` (then saying the zone adds nothing). */
function sameOffset(at: Date, a: string, b: string): boolean {
  try {
    const wall = (timeZone: string) =>
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(at);
    return wall(a) === wall(b);
  } catch {
    return false;
  }
}

/** The day an event starts on in its own zone (`2027-03-01`), for grouping or a calendar. */
export function eventDay(event: { startsAt: string | null; timeZone: string | null }): string {
  if (!event.startsAt) return "";
  const at = new Date(event.startsAt);
  if (Number.isNaN(at.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: event.timeZone ?? viewerTimeZone(),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    return event.startsAt.slice(0, 10);
  }
}

/** The currency an event's prices are in, as the host gave it with its ticket types. */
export function eventCurrency(event: EventOnSale): string | null {
  return event.ticketTypes.find((type) => type.currency)?.currency ?? null;
}

/**
 * An amount a buyer typed (`120`, `120.50`) in the minor unit of `currency`, or null when it is
 * not one. The host decides whether it may be charged (at least the set minimum, at most the
 * balance).
 */
export function minorFromInput(text: string, currency: string | null = null): number | null {
  const value = Number(text.trim().replace(",", "."));
  return Number.isFinite(value) && value > 0
    ? Math.round(value * 10 ** currencyDigits(currency))
    : null;
}

/** What the picker shows of a ticket type's places: "Sold out", "Only 3 left", or nothing. */
export function availabilityLabel(availability: TicketTypeOnSale["availability"]): string | null {
  if (availability.status === "sold_out") return "Sold out";
  if (availability.status === "low" && typeof availability.available === "number") {
    return `Only ${availability.available} left`;
  }
  return null;
}

const TICKET_STATE_LABELS: Readonly<Record<string, string>> = {
  valid: "Valid",
  used: "Used",
  void: "Cancelled",
};

/** A ticket's state as its holder reads it (a void ticket is "Cancelled"). Display only. */
export function ticketStateLabel(state: string | null): string | null {
  return state === null ? null : (TICKET_STATE_LABELS[state] ?? state);
}

/** Quantities chosen, by ticket type id. */
export type Quantities = Readonly<Record<string, number>>;

/** The lines `orderStart` takes, from what was chosen. */
export function pickerLines(quantities: Quantities): { ticketTypeId: string; quantity: number }[] {
  return Object.entries(quantities)
    .filter(([, quantity]) => quantity > 0)
    .map(([ticketTypeId, quantity]) => ({ ticketTypeId, quantity }));
}

/**
 * A preview of the order, in the minor unit, from the prices the host published: what to show
 * while choosing. The host prices the order when it starts; show its total after that.
 */
export function estimate(
  event: EventOnSale,
  quantities: Quantities,
): { full: number; deposit: number | null; currency: string | null } {
  const currency = eventCurrency(event);
  const scale = 10 ** currencyDigits(currency);
  let full = 0;
  let deposit = 0;
  let everyLineOffersDeposit = true;
  for (const type of event.ticketTypes) {
    const quantity = quantities[type.id] ?? 0;
    if (quantity <= 0) continue;
    full += Math.round((type.price ?? 0) * scale) * quantity;
    if (type.deposit === null || type.balanceDue === null) everyLineOffersDeposit = false;
    else deposit += Math.round(type.deposit * scale) * quantity;
  }
  return { full, deposit: full > 0 && everyLineOffersDeposit ? deposit : null, currency };
}

/** The most the picker offers of one type: its declared most per order, or 10 as the host does. */
export function pickerMax(type: TicketTypeOnSale): number {
  if (type.availability.status === "sold_out") return 0;
  return type.maxPerOrder ?? 10;
}

/** What the confirmation page says about an order, from its real state. */
export function orderStatus(order: BuyerOrder): {
  kind: "waiting" | "paid" | "part_paid" | "closed";
  title: string;
  /** True while the page should keep asking: the provider's word has not arrived yet. */
  waiting: boolean;
} {
  switch (order.state) {
    case "pending":
      return { kind: "waiting", title: "Waiting for your payment to be confirmed", waiting: true };
    case "paid":
      return {
        kind: "paid",
        title: "Paid. Your tickets are on their way by email.",
        waiting: false,
      };
    case "part_paid":
      return {
        kind: "part_paid",
        title: "Deposit paid. Your tickets are on their way by email.",
        waiting: false,
      };
    default:
      return {
        kind: "closed",
        title: `This order is ${order.state.replace("_", " ")}.`,
        waiting: false,
      };
  }
}

// --- Hooks ---------------------------------------------------------------------------------------

/** The app's `useQuery`, as far as these hooks use it. */
export type UseQuery = <T>(options: {
  queryKey: readonly unknown[];
  queryFn: () => Promise<T>;
  /** Asked again every this many ms while it returns a number (TanStack's refetchInterval). */
  refetchInterval?:
    | ((query: { state: { data: T | undefined } }) => number | false)
    | number
    | false;
  enabled?: boolean;
}) => { data: T | undefined; isPending: boolean; error: unknown };

/** The app's `useMutation`, as far as these hooks use it. */
export type UseMutation = <I, O>(options: {
  mutationKey: readonly unknown[];
  mutationFn: (input: I) => Promise<O>;
  gcTime?: number;
}) => {
  mutate(input: I): void;
  mutateAsync(input: I): Promise<O>;
  data: O | undefined;
  isPending: boolean;
  error: unknown;
  /** Forgets the call: its variables and its answer (TanStack Query's `reset`). */
  reset?: () => void;
};

/** The app's `useState`. */
export type UseState = <T>(initial: T) => [T, (next: T | ((previous: T) => T)) => void];

/** How often the confirmation page asks again while an order is pending. */
export const WAITING_POLL_MS = 2000;

/**
 * The operations each hook calls (ADR 0453). A client gets the hooks whose operations it holds:
 * the door role's client gets `useCheckIn`, `useUndoCheckIn` and `useTicketPicker`, a customer's
 * client the buying hooks, the staff client all of them.
 */
export const TICKETING_HOOKS_CALL = {
  useEventsOnSale: ["x.ticketing.eventsOnSale"],
  useTicketPicker: [],
  useStartOrder: ["x.ticketing.orderStart"],
  useCheckout: ["order.checkout"],
  useOrder: ["order.view", "order.get"],
  useMyTickets: ["x.ticketing.myTickets"],
  useCheckIn: ["x.ticketing.checkIn"],
  useUndoCheckIn: ["x.ticketing.undoCheckIn"],
} as const;

/**
 * Hooks for a React or React Native app:
 * `const ticketing = createTicketingHooks({ useQuery, useMutation, useState }, api)`. `api` is any
 * generated client: the customer's, a pack role's (`roles/ticketing.door.ts`) or the staff one.
 * The hooks it cannot back are not there, and calling one does not compile.
 */
export function createTicketingHooks<C extends ClientHolding>(
  react: { useQuery: UseQuery; useMutation: UseMutation; useState: UseState },
  client: C,
) {
  return packHooks(client, TICKETING_HOOKS_CALL, (api: TicketingClient) =>
    allTicketingHooks(react, api),
  );
}

function allTicketingHooks(
  react: { useQuery: UseQuery; useMutation: UseMutation; useState: UseState },
  api: TicketingClient,
) {
  const { useQuery, useMutation, useState } = react;
  return {
    /** The events on sale (or one), with their ticket types and places. */
    useEventsOnSale(input: In<"x.ticketing.eventsOnSale"> = {}) {
      return useQuery(api.query("x.ticketing.eventsOnSale", input));
    },
    /** Quantities for one event's ticket types, the lines to start with and the preview. */
    useTicketPicker(event: EventOnSale | undefined) {
      const [quantities, setQuantities] = useState<Quantities>({});
      const set = (ticketTypeId: string, quantity: number) => {
        const type = event?.ticketTypes.find((t) => t.id === ticketTypeId);
        const max = type ? pickerMax(type) : 0;
        setQuantities((previous) => ({
          ...previous,
          [ticketTypeId]: Math.max(0, Math.min(Math.trunc(quantity), max)),
        }));
      };
      const lines = pickerLines(quantities);
      return {
        quantities,
        set,
        lines,
        estimate: event ? estimate(event, quantities) : { full: 0, deposit: null, currency: null },
        empty: lines.length === 0,
        max: pickerMax,
        clear: () => setQuantities({}),
      };
    },
    /** Starts the order through the host, which prices it and holds the places. */
    useStartOrder() {
      // A visitor's agreements (a name typed, a signature, health answers) go in this call:
      // not kept in the app's cache once it is over (stage 44, issue #292).
      return useMutation({ ...api.mutation("x.ticketing.orderStart"), gcTime: 0 });
    },
    /** Opens the payment provider's page for an order (the first payment, or a balance). */
    useCheckout() {
      return useMutation(api.mutation("order.checkout"));
    },
    /** One order as its buyer sees it, asked again while it is waiting for the provider. */
    useOrder(order: { id: string; token?: string | null } | null) {
      const options = order
        ? order.token
          ? api.query("order.view", { id: order.id, token: order.token })
          : api.query("order.get", { id: order.id })
        : { queryKey: ["order.none"], queryFn: async () => undefined as never };
      return useQuery<BuyerOrder>({
        ...options,
        enabled: order !== null,
        refetchInterval: (query) =>
          query.state.data && orderStatus(query.state.data).waiting ? WAITING_POLL_MS : false,
      });
    },
    /** The signed-in customer's own tickets. */
    useMyTickets(input: In<"x.ticketing.myTickets"> = {}) {
      return useQuery(api.query("x.ticketing.myTickets", input));
    },
    /** Checks a ticket in by its code (staff, or a door account). */
    useCheckIn() {
      return useMutation(api.mutation("x.ticketing.checkIn"));
    },
    /** Undoes a check-in made by mistake. */
    useUndoCheckIn() {
      return useMutation(api.mutation("x.ticketing.undoCheckIn"));
    },
  };
}

/** Every hook of this entry, as a client of all its operations gets them. A block takes the ones it calls: `Pick<TicketingHooks, "useCheckIn">`. */
export type TicketingHooks = ReturnType<typeof allTicketingHooks>;
