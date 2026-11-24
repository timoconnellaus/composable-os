// The account entry (stage 48 step 1): the logic the My account blocks share, web and native. It
// orders the sections, puts the host's answers in words, sends only what changed, reads a page of
// orders with their lines in two calls, and offers only the hooks a client can back. Fixture
// values only. Its reads against a real host are core's test (account-orders.test.ts).
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_HOOKS_CALL,
  type AccountClient,
  type AccountOrder,
  type AccountSubscription,
  accountSections,
  birthdayDays,
  birthdayForm,
  birthdayInput,
  birthdayMonths,
  birthdayProblem,
  createAccountHooks,
  detailsInput,
  detailsProblems,
  formatMinor,
  hiddenSections,
  loadOrders,
  ORDERS_PAGE,
  orderedSessions,
  orderMoney,
  orderStateWords,
  showsPayment,
  showsReceiptNote,
  subscriptionStatus,
} from "../src/index.ts";

const order = (extra: Partial<AccountOrder> = {}): AccountOrder => ({
  id: "ord_1",
  state: "paid",
  currency: "AUD",
  total: 2500,
  paid: 2500,
  balance: 0,
  refunded: 0,
  pay: "full",
  deposit: null,
  balanceDueAt: null,
  expiresAt: null,
  paidAt: "2026-11-01T00:00:00.000Z",
  createdAt: "2026-11-01T00:00:00.000Z",
  taxAmount: 227,
  taxRefunded: 0,
  subscriptionId: null,
  lines: [],
  receiptUrl: null,
  ...extra,
});

const sub = (extra: Partial<AccountSubscription> = {}): AccountSubscription => ({
  id: "sub_1",
  state: "active",
  planObject: "x.memberships.plan",
  planId: "rec_1",
  planTitle: "Fixture plan",
  amount: 2900,
  currency: "AUD",
  interval: "month",
  trialEnd: null,
  currentPeriodEnd: "2026-12-01T00:00:00.000Z",
  cancelAtPeriodEnd: false,
  cancelAt: null,
  endedAt: null,
  actionUrl: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  holderPersonId: null,
  ...extra,
});

describe("sections", () => {
  it("puts the packs' sections first by order, then the base ones, and hides what is asked", () => {
    const packs = [
      { key: "memberships", label: "Memberships and passes", order: 20 },
      { key: "bookings", label: "Bookings", order: 10 },
    ];
    expect(accountSections(packs).map((s) => s.key)).toEqual([
      "bookings",
      "memberships",
      "orders",
      "agreements",
      "family",
      "payment",
      "details",
      "devices",
    ]);
    expect(accountSections([], ["payment"]).map((s) => s.key)).not.toContain("payment");
  });

  it("never lets a pack's section take a base section's key", () => {
    const shown = accountSections([{ key: "orders", label: "Shop orders", order: 1 }]);
    expect(shown.filter((s) => s.key === "orders")).toEqual([
      { key: "orders", label: "Orders", order: 60 },
    ]);
  });

  it("shows Payment method only to someone who pays a subscription that has not ended", () => {
    expect(hiddenSections(undefined)).toEqual(["payment"]);
    expect(hiddenSections([sub({ state: "ended" }), sub({ state: "expired" })])).toEqual([
      "payment",
    ]);
    expect(showsPayment([sub({ state: "past_due" })])).toBe(true);
    expect(hiddenSections([sub()])).toEqual([]);
  });
});

describe("words", () => {
  it("shows the host's amounts in the currency's minor unit", () => {
    expect(formatMinor(2500, "AUD", "en-AU")).toBe("$25.00");
    expect(formatMinor(2500, "JPY", "en-AU").replace(/\s/g, " ")).toBe("JPY 2,500");
    expect(formatMinor(5, "not a currency")).toBe("5 not a currency");
  });

  it("lists an order's money as the host gave it, leaving out what it does not have", () => {
    const rows = orderMoney(order(), "en-AU");
    expect(rows.map((r) => r.key)).toEqual(["total", "tax", "paid"]);
    const deposit = orderMoney(
      order({
        state: "part_paid",
        pay: "deposit",
        deposit: 1000,
        paid: 1000,
        balance: 1500,
        balanceDueAt: "2026-12-10T00:00:00.000Z",
      }),
      "en-AU",
    );
    expect(deposit.map((r) => r.key)).toEqual(["total", "tax", "deposit", "paid", "balance"]);
    expect(deposit.find((r) => r.key === "balance")).toMatchObject({ value: "$15.00" });
    expect(deposit.find((r) => r.key === "balance")?.label).toMatch(/^To pay by /);
    const refunded = orderMoney(order({ refunded: 2500, taxRefunded: 227, state: "refunded" }));
    expect(refunded.map((r) => r.key)).toContain("refunded");
    expect(refunded.map((r) => r.key)).toContain("taxRefunded");
    // A cancelled or expired order owes nothing, whatever its balance says.
    expect(
      orderMoney(order({ state: "cancelled", paid: 0, balance: 2500 })).map((r) => r.key),
    ).not.toContain("balance");
  });

  it("says an order's state and where a paid order's receipt is", () => {
    expect(orderStateWords(order({ state: "pending" }))).toBe("Waiting for payment");
    expect(orderStateWords(order({ state: "paid", refunded: 100 }))).toBe("Paid, part refunded");
    expect(showsReceiptNote(order())).toBe(true);
    expect(showsReceiptNote(order({ state: "pending", paid: 0 }))).toBe(false);
    expect(showsReceiptNote(order({ state: "part_paid", paid: 1000 }))).toBe(true);
  });

  it("says a subscription's state from what the host reports", () => {
    expect(subscriptionStatus(sub(), "en-AU")).toMatch(/^Active: next charge on /);
    expect(subscriptionStatus(sub({ cancelAtPeriodEnd: true }), "en-AU")).toMatch(/then it ends$/);
    expect(subscriptionStatus(sub({ state: "past_due" }))).toMatch(/payment failed/);
    expect(subscriptionStatus(sub({ state: "incomplete", actionUrl: "https://x" }))).toMatch(
      /confirm its first payment/,
    );
  });

  it("lists this session first, then the most recently used", () => {
    const at = (d: string) => `2026-11-${d}T00:00:00.000Z`;
    const s = (id: string, last: string, current = false) => ({
      id,
      kind: "browser" as const,
      deviceName: null,
      createdAt: at("01"),
      lastActiveAt: at(last),
      expiresAt: null,
      current,
    });
    expect(
      orderedSessions([s("a", "02"), s("b", "05"), s("c", "01", true)]).map((x) => x.id),
    ).toEqual(["c", "b", "a"]);
  });
});

describe("details", () => {
  const me = {
    displayName: "Fixture Person",
    givenName: "Fixture",
    familyName: null,
    primaryPhone: "0400 000 000",
  };

  it("sends only what changed, an emptied field as null, and nothing when nothing did", () => {
    const same = {
      displayName: "Fixture Person",
      givenName: "Fixture",
      familyName: "",
      primaryPhone: "0400 000 000",
    };
    expect(detailsInput(me, same)).toBeNull();
    expect(detailsInput(me, { ...same, primaryPhone: "  " })).toEqual({ primaryPhone: null });
    expect(detailsInput(me, { ...same, displayName: " New Name ", familyName: "Person" })).toEqual({
      displayName: "New Name",
      familyName: "Person",
    });
  });

  it("says what is missing before saving", () => {
    const problems = detailsProblems({
      displayName: " ",
      givenName: "x".repeat(101),
      familyName: "",
      primaryPhone: "",
    });
    expect(problems.map((p) => p.field)).toEqual(["displayName", "givenName"]);
  });
});

describe("birthday", () => {
  it("is a day and a month, both or neither, a day the month has", () => {
    expect(birthdayDays("2")).toHaveLength(29);
    expect(birthdayDays("4")).toHaveLength(30);
    expect(birthdayDays("")).toHaveLength(31);
    expect(birthdayMonths("en").map((m) => m.label)[0]).toBe("January");
    expect(birthdayMonths("en")).toHaveLength(12);
    expect(birthdayProblem({ day: "", month: "" })).toBeNull();
    expect(birthdayProblem({ day: "3", month: "" })).toMatch(/day and a month/);
    expect(birthdayProblem({ day: "31", month: "6" })).toMatch(/no such day/);
    expect(birthdayProblem({ day: "29", month: "2" })).toBeNull();
  });

  it("sends only a change; choosing neither removes it", () => {
    const saved = { day: 4, month: 7 };
    expect(birthdayForm(saved)).toEqual({ day: "4", month: "7" });
    expect(birthdayForm(null)).toEqual({ day: "", month: "" });
    expect(birthdayInput(saved, { day: "4", month: "7" })).toBeNull();
    expect(birthdayInput(null, { day: "", month: "" })).toBeNull();
    expect(birthdayInput(saved, { day: "5", month: "7" })).toEqual({
      birthday: { day: 5, month: 7 },
    });
    expect(birthdayInput(saved, { day: "", month: "" })).toEqual({ birthday: null });
  });
});

describe("loadOrders", () => {
  /** A client over fixture pages of `my.list`, recording each call. */
  function fixtureClient(orders: number, linesPer: number) {
    const calls: { object: string; filter?: unknown; cursor?: string; limit?: number }[] = [];
    const all = Array.from({ length: orders }, (_, i) => ({
      object: "order",
      id: `ord_${String(i).padStart(3, "0")}`,
      values: { state: "paid", total: 100 + i, paid: 100 + i, createdAt: "2026-11-01T00:00:00Z" },
    }));
    const api = {
      query(name: string, input: Record<string, unknown>) {
        return {
          queryKey: [name, input],
          queryFn: async () => {
            const call = input as (typeof calls)[number];
            calls.push(call);
            if (call.object === "order") {
              const from = call.cursor ? Number(call.cursor) : 0;
              const to = from + (call.limit ?? 50);
              return {
                items: all.slice(from, to),
                nextCursor: to < all.length ? String(to) : null,
                currency: "AUD",
              };
            }
            const ids = (call.filter as { value: string[] }).value;
            const lines = ids.flatMap((id) =>
              Array.from({ length: linesPer }, (_, n) => ({
                object: "orderLine",
                id: `${id}_l${n}`,
                values: { orderId: id, position: linesPer - n, title: `Line ${n}`, total: 1 },
              })),
            );
            const from = call.cursor ? Number(call.cursor) : 0;
            const to = from + (call.limit ?? 50);
            return {
              items: lines.slice(from, to),
              nextCursor: to < lines.length ? String(to) : null,
            };
          },
        };
      },
      mutation() {
        throw new Error("no mutation here");
      },
    } as unknown as AccountClient;
    return { api, calls };
  }

  it("reads a page of orders and their lines in two calls, the filter naming the page's orders", async () => {
    const { api, calls } = fixtureClient(25, 2);
    const first = await loadOrders(api);
    expect(first.orders).toHaveLength(ORDERS_PAGE);
    expect(first.nextCursor).toBe(String(ORDERS_PAGE));
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ object: "order", limit: ORDERS_PAGE });
    expect(calls[1]).toMatchObject({ object: "orderLine", filter: { field: "orderId", op: "in" } });
    expect((calls[1]?.filter as { value: string[] } | undefined)?.value).toHaveLength(ORDERS_PAGE);
    // Lines in their positions, each on its own order; the currency from the host's answer.
    const [one] = first.orders;
    expect(one?.lines.map((l) => l.position)).toEqual([1, 2]);
    expect(one?.lines.every((l) => l.id.startsWith(one.id))).toBe(true);
    expect(one?.currency).toBe("AUD");
    const second = await loadOrders(api, first.nextCursor ?? undefined);
    expect(second.orders).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
  });

  it("follows the lines' pages a bounded number of times", async () => {
    const { api, calls } = fixtureClient(20, 60);
    const page = await loadOrders(api);
    // 1,200 lines at 200 a call is six pages: five are read, and no more.
    expect(calls.filter((c) => c.object === "orderLine")).toHaveLength(5);
    expect(page.orders.reduce((n, o) => n + o.lines.length, 0)).toBe(1000);
  });

  it("makes no lines call when there are no orders", async () => {
    const { api, calls } = fixtureClient(0, 0);
    expect((await loadOrders(api)).orders).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe("createAccountHooks", () => {
  const react = {
    useQuery: (() => ({ data: undefined, isPending: true, error: null })) as never,
    useMutation: (() => ({})) as never,
  };

  it("offers only the hooks the client's operations back", () => {
    const customer = {
      operations: Object.fromEntries(
        Object.values(ACCOUNT_HOOKS_CALL)
          .flat()
          .map((name) => [name, {}]),
      ),
      query: () => ({}),
      mutation: () => ({}),
    };
    expect(Object.keys(createAccountHooks(react, customer)).sort()).toEqual(
      Object.keys(ACCOUNT_HOOKS_CALL).sort(),
    );
    const readOnly = { ...customer, operations: { "me.get": {}, "my.list": {} } };
    expect(Object.keys(createAccountHooks(react, readOnly)).sort()).toEqual(["useMe", "useOrders"]);
  });
});
