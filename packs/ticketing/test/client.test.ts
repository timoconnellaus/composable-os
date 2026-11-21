// The Ticketing pack's headless entry (stage 27, step 5): its plain functions, and that each hook
// asks the client for the operation it names. apps/runner/test/ticketing.test.ts drives the same
// hooks against the real host.
import { describe, expect, it } from "vitest";
import {
  availabilityLabel,
  type BuyerOrder,
  createTicketingHooks,
  type EventOnSale,
  estimate,
  formatMoney,
  minorFromInput,
  orderStatus,
  pickerLines,
  pickerMax,
  type TicketingClient,
  type UseMutation,
  type UseQuery,
  type UseState,
  WAITING_POLL_MS,
} from "../client/index.ts";

const type = (values: Partial<EventOnSale["ticketTypes"][number]>) => ({
  id: "tt",
  name: "Shared",
  description: null,
  price: 450,
  onSaleFrom: null,
  onSaleUntil: null,
  maxPerOrder: null,
  deposit: null,
  balanceDue: null,
  availability: { status: "available" as const },
  ...values,
});

const event = (types: EventOnSale["ticketTypes"]): EventOnSale => ({
  id: "ev1",
  name: "Camp",
  startsAt: null,
  endsAt: null,
  venue: null,
  description: null,
  image: null,
  availability: { status: "available" },
  ticketTypes: types,
});

describe("plain functions", () => {
  it("previews the order from the published prices, and a deposit only when every line has one", () => {
    const e = event([
      type({ id: "a", price: 450, deposit: 100, balanceDue: "2027-01-01" }),
      type({ id: "b", price: 19.99 }),
    ]);
    expect(estimate(e, { a: 2 })).toEqual({ full: 90000, deposit: 20000 });
    expect(estimate(e, { a: 1, b: 3 })).toEqual({ full: 45000 + 5997, deposit: null });
    expect(estimate(e, {})).toEqual({ full: 0, deposit: null });
    expect(pickerLines({ a: 2, b: 0 })).toEqual([{ ticketTypeId: "a", quantity: 2 }]);
  });

  it("offers up to the declared most per order (10 as the host), none when sold out", () => {
    expect(pickerMax(type({ maxPerOrder: 4 }))).toBe(4);
    expect(pickerMax(type({}))).toBe(10);
    expect(pickerMax(type({ availability: { status: "sold_out" } }))).toBe(0);
    expect(availabilityLabel({ status: "low", available: 3 })).toBe("Only 3 left");
    expect(availabilityLabel({ status: "sold_out" })).toBe("Sold out");
    expect(availabilityLabel({ status: "available" })).toBeNull();
  });

  it("formats money and reads a typed amount, leaving the limits to the host", () => {
    expect(formatMoney(80000, "AUD")).toBe("800.00 AUD");
    expect(minorFromInput("120.5")).toBe(12050);
    expect(minorFromInput("12,50")).toBe(1250);
    expect(minorFromInput("nope")).toBeNull();
    expect(minorFromInput("0")).toBeNull();
  });

  it("says an order is waiting until the host says it is paid", () => {
    const order = (state: BuyerOrder["state"]) => ({ state }) as BuyerOrder;
    expect(orderStatus(order("pending"))).toMatchObject({ kind: "waiting", waiting: true });
    expect(orderStatus(order("paid"))).toMatchObject({ kind: "paid", waiting: false });
    expect(orderStatus(order("part_paid"))).toMatchObject({ kind: "part_paid", waiting: false });
    expect(orderStatus(order("expired"))).toMatchObject({ kind: "closed", waiting: false });
  });
});

describe("the hooks", () => {
  const asked: unknown[] = [];
  const api: TicketingClient = {
    query: ((name: string, input: unknown) => {
      asked.push([name, input]);
      return { queryKey: [name, input], queryFn: async () => ({}) as never };
    }) as TicketingClient["query"],
    mutation: ((name: string) => {
      asked.push([name]);
      return { mutationKey: [name], mutationFn: async () => ({}) as never };
    }) as TicketingClient["mutation"],
  };
  const options: unknown[] = [];
  const useQuery: UseQuery = (o) => {
    options.push(o);
    return { data: undefined, isPending: true, error: null };
  };
  const useMutation: UseMutation = () => ({
    mutate() {},
    mutateAsync: async () => ({}) as never,
    data: undefined,
    isPending: false,
    error: null,
  });
  let box: unknown;
  const useState: UseState = <T>(initial: T) => {
    if (box === undefined) box = initial;
    return [
      box as T,
      (next: T | ((p: T) => T)) => {
        box = typeof next === "function" ? (next as (p: T) => T)(box as T) : next;
      },
    ];
  };
  const hooks = createTicketingHooks({ useQuery, useMutation, useState }, api);

  it("each asks for the operation it names", () => {
    hooks.useEventsOnSale();
    hooks.useMyTickets({ code: "X" });
    hooks.useStartOrder();
    hooks.useCheckout();
    hooks.useCheckIn();
    hooks.useUndoCheckIn();
    hooks.useOrder({ id: "ord_1", token: "t" });
    hooks.useOrder({ id: "ord_2" });
    expect(asked).toEqual([
      ["x.ticketing.eventsOnSale", {}],
      ["x.ticketing.myTickets", { code: "X" }],
      ["x.ticketing.orderStart"],
      ["order.checkout"],
      ["x.ticketing.checkIn"],
      ["x.ticketing.undoCheckIn"],
      ["order.view", { id: "ord_1", token: "t" }],
      ["order.get", { id: "ord_2" }],
    ]);
  });

  it("useOrder asks again while the order is pending, and stops when it is not", () => {
    const o = options.at(-1) as {
      refetchInterval: (q: { state: { data: BuyerOrder | undefined } }) => number | false;
    };
    expect(o.refetchInterval({ state: { data: { state: "pending" } as BuyerOrder } })).toBe(
      WAITING_POLL_MS,
    );
    expect(o.refetchInterval({ state: { data: { state: "paid" } as BuyerOrder } })).toBe(false);
  });

  it("useTicketPicker keeps quantities within what the picker offers", () => {
    const e = event([type({ id: "a", maxPerOrder: 3 })]);
    const picker = hooks.useTicketPicker(e);
    picker.set("a", 7);
    expect(hooks.useTicketPicker(e).quantities).toEqual({ a: 3 });
    hooks.useTicketPicker(e).set("a", -2);
    expect(hooks.useTicketPicker(e).quantities).toEqual({ a: 0 });
  });
});
