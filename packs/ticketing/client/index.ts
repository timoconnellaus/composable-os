// The Ticketing pack's headless entry (stage 27, step 5; ADR 0418): functions and hooks over the
// typed client, no markup. A client app imports it as `@composable-os/pack-ticketing/client` and
// hands it its generated client; the ticketing blocks render what it returns.
//
// As every pack's entry: the operations are typed from the pack's own tool schemas, it takes the
// client and the app's `useQuery`, `useMutation` and `useState` as arguments (no React or TanStack
// import), and it holds no rules. Prices, limits, places, what may be bought and whether an order
// is paid are the host's. The one sum here, `estimate`, is a preview of what the host will
// charge, shown before the order starts; the order the host returns is what is paid.
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
type QueryName = { [N in Name]: TicketingOperations[N]["kind"] extends "query" ? N : never }[Name];
type MutationName = {
  [N in Name]: TicketingOperations[N]["kind"] extends "mutation" ? N : never;
}[Name];
type In<N extends Name> = TicketingOperations[N]["input"];
type Out<N extends Name> = TicketingOperations[N]["output"];

export type EventsOnSale = Out<"x.ticketing.eventsOnSale">;
export type EventOnSale = EventsOnSale["events"][number];
export type TicketTypeOnSale = EventOnSale["ticketTypes"][number];
export type MyTickets = Out<"x.ticketing.myTickets">;
export type CheckInResult = Out<"x.ticketing.checkIn">;
export type StartedOrder = Out<"x.ticketing.orderStart">;

/** The part of a generated client this entry needs. A product's client fits it. */
export interface TicketingClient {
  query<N extends QueryName>(
    name: N,
    input: In<N>,
  ): { queryKey: readonly unknown[]; queryFn: () => Promise<Out<N>> };
  mutation<N extends MutationName>(
    name: N,
  ): { mutationKey: readonly unknown[]; mutationFn: (input: In<N>) => Promise<Out<N>> };
}

// --- Plain functions ------------------------------------------------------------------------------

/**
 * How many decimal places `currency` has (2 for AUD, 0 for JPY), for display. The currency is
 * always the host's, from the data (a ticket type's `currency`, an order's): never the app's.
 */
export function currencyDigits(currency: string | null | undefined): number {
  if (!currency) return 2;
  try {
    return (
      new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/** An amount in the minor unit as the buyer reads it: `450.00 AUD`. Display only. */
export function formatMoney(minor: number, currency: string | null): string {
  const digits = currencyDigits(currency);
  return `${(minor / 10 ** digits).toFixed(digits)}${currency ? ` ${currency}` : ""}`;
}

/** A ticket type's price (major unit, as the record holds it) as the buyer reads it. */
export function formatPrice(price: number | null, currency: string | null): string {
  return price === null
    ? ""
    : `${price.toFixed(currencyDigits(currency))}${currency ? ` ${currency}` : ""}`;
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
}) => {
  mutate(input: I): void;
  mutateAsync(input: I): Promise<O>;
  data: O | undefined;
  isPending: boolean;
  error: unknown;
};

/** The app's `useState`. */
export type UseState = <T>(initial: T) => [T, (next: T | ((previous: T) => T)) => void];

/** How often the confirmation page asks again while an order is pending. */
export const WAITING_POLL_MS = 2000;

/**
 * Hooks for a React or React Native app:
 * `const ticketing = createTicketingHooks({ useQuery, useMutation, useState }, api)`.
 */
export function createTicketingHooks(
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
        max: (type: TicketTypeOnSale) => pickerMax(type),
        clear: () => setQuantities({}),
      };
    },
    /** Starts the order through the host, which prices it and holds the places. */
    useStartOrder() {
      return useMutation(api.mutation("x.ticketing.orderStart"));
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

export type TicketingHooks = ReturnType<typeof createTicketingHooks>;
