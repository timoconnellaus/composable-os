// The account entry's logic for stage 48 step 7, which the attention, change-address and delete
// blocks share, web and native: a refusal for an old sign-in is its own outcome and never done;
// nothing is confirmed for deletion without the host's preview and the typed word; the preview is
// put in words whole; an attention item says whose it is and leads only to a section the host
// listed. Fixture values only; the host's side is core's tests (customer-email-change,
// me-attention, the delete tests).
import { describe, expect, it } from "vitest";
import {
  type AccountOrder,
  ApiError,
  type AttentionItem,
  attentionTarget,
  attentionWords,
  confirmDelete,
  createAccountHooks,
  DELETE_WORD,
  type DeletePreview,
  deleteConfirmInput,
  deletePreviewWords,
  emailChangeErrorWords,
  emailChangeProblem,
  followableUrl,
  isPreviewChanged,
  isSignInAgain,
  payWords,
  portalSections,
  sensitive,
  showsPay,
} from "../src/index.ts";

const preview = (extra: Partial<DeletePreview> = {}): DeletePreview => ({
  deleted: false,
  subscriptions: [
    {
      id: "sub_1",
      title: "Three a week",
      amount: 4150,
      currency: "AUD",
      interval: "month",
      endsAt: "2026-12-03T00:00:00.000Z",
      ending: "period_end",
    },
  ],
  orders: [
    {
      id: "ord_1",
      total: 2200,
      currency: "AUD",
      createdAt: "2026-11-20T00:00:00.000Z",
      lines: ["Drop-in: Strength"],
    },
  ],
  leftForStaff: {
    records: [{ object: "bookings.booking", label: "Bookings", count: 2 }],
    partPaidOrders: 1,
    moreUnpaidOrders: 0,
    subscriptions: [{ id: "sub_2", title: "Old plan", state: "active", why: "end_date_later" }],
    dependantsWithoutGuardian: 1,
  },
  eraseDueAt: "2026-12-25T00:00:00.000Z",
  expect: "fp_abc",
  ...extra,
});

const item = (extra: Partial<AttentionItem> = {}): AttentionItem => ({
  key: "k",
  kind: "agree",
  person: { id: "per_me", name: "Hannah Okafor", self: true },
  record: { object: "agreement", id: "agr_1", title: "Waiver" },
  at: "2026-11-26T00:00:00.000Z",
  amount: null,
  currency: null,
  usesLeft: null,
  link: null,
  ...extra,
});

describe("a recent sign-in (sign_in_again)", () => {
  const signInAgain = new ApiError("sign_in_again", "Sign in again first", 403, {
    withinMinutes: 15,
  });

  it("is its own outcome: never done, never a failure", async () => {
    expect(isSignInAgain(signInAgain)).toBe(true);
    expect(isSignInAgain(new ApiError("forbidden", "No", 403))).toBe(false);
    let ran = 0;
    const outcome = await sensitive(async () => {
      ran += 1;
      throw signInAgain;
    });
    expect(outcome).toEqual({ kind: "sign_in_again" });
    expect(ran).toBe(1);
  });

  it("passes the host's answer and its other refusals through", async () => {
    expect(await sensitive(async () => 7)).toEqual({ kind: "done", value: 7 });
    const refused = new ApiError(
      "conflict",
      "This address is already in use at the business",
      409,
      {
        rule: "address_in_use",
      },
    );
    const outcome = await sensitive(async () => {
      throw refused;
    });
    expect(outcome).toEqual({ kind: "failed", error: refused });
  });
});

describe("changing the sign-in address", () => {
  it("checks the address's shape only: whether it can be used is the host's", () => {
    expect(emailChangeProblem("", "a@example.com")).toBe("Enter the new address");
    expect(emailChangeProblem("not an address", "a@example.com")).toMatch(/Enter an email/);
    expect(emailChangeProblem(" A@Example.com ", "a@example.com")).toMatch(/sign in with now/);
    expect(emailChangeProblem("b@example.com", "a@example.com")).toBeNull();
  });

  it("says the host's own words for its refusals", () => {
    const inUse = new ApiError("conflict", "This address is already in use at the business", 409);
    expect(emailChangeErrorWords(inUse)).toBe("This address is already in use at the business");
    const wrong = new ApiError("invalid_input", "That code is not right", 400, { triesLeft: 3 });
    expect(emailChangeErrorWords(wrong)).toBe("That code is not right");
    expect(emailChangeErrorWords(new ApiError("rate_limited", "x", 429))).toMatch(/Too many/);
  });
});

describe("deleting the account", () => {
  it("confirms only a preview the host gave, and only once the word is typed", () => {
    expect(deleteConfirmInput(undefined, DELETE_WORD)).toBeNull();
    expect(deleteConfirmInput(null, DELETE_WORD)).toBeNull();
    expect(deleteConfirmInput(preview({ expect: "" }), DELETE_WORD)).toBeNull();
    expect(deleteConfirmInput(preview(), "")).toBeNull();
    expect(deleteConfirmInput(preview(), "delete it")).toBeNull();
    expect(deleteConfirmInput(preview(), " delete ")).toEqual({ confirm: true, expect: "fp_abc" });
  });

  it("puts every part of the preview in words", () => {
    const words = deletePreviewWords(preview(), "en-AU");
    expect(words.ends).toHaveLength(1);
    expect(words.ends[0]).toMatch(/Three a week \(\$41\.50 a month\) ends on 3 Dec 2026/);
    expect(words.ends[0]).toMatch(/Nothing is refunded/);
    expect(words.cancelled[0]).toMatch(/Drop-in: Strength, \$22\.00\) is cancelled/);
    expect(words.left).toEqual([
      "Bookings: 2",
      "1 part-paid order",
      "Old plan: it has an end date set later, and may charge until the business ends it",
      "1 child linked to you will have no other parent or guardian on the account",
    ]);
    expect(words.erase).toMatch(/by 25 Dec 2026/);
  });

  it("knows a preview that changed meanwhile", () => {
    const changed = new ApiError("conflict", "changed", 409, { rule: "preview_changed" });
    expect(isPreviewChanged(changed)).toBe(true);
    expect(isPreviewChanged(new ApiError("conflict", "other", 409, { rule: "x" }))).toBe(false);
  });
});

describe("needs your attention", () => {
  const shown = [
    { key: "memberships.memberships", label: "Memberships and passes", order: 20 },
    { key: "orders", label: "Orders", order: 60 },
    { key: "agreements", label: "Agreements", order: 70 },
    { key: "payment", label: "Payment method", order: 85 },
  ];

  it("says whose it is when it is a child's", () => {
    expect(attentionWords(item()).whose).toBeNull();
    const child = item({ person: { id: "per_leo", name: "Leo Okafor", self: false } });
    expect(attentionWords(child)).toMatchObject({
      whose: "For Leo Okafor",
      title: "Agree to Waiver",
    });
  });

  it("leads each kind to the section the host listed for it, and nowhere else", () => {
    expect(attentionTarget(item(), shown)).toEqual({ kind: "section", key: "agreements" });
    expect(attentionTarget(item({ kind: "card_failing" }), shown)).toEqual({
      kind: "section",
      key: "payment",
    });
    // Money owed on an order: the order itself in Orders, where the web pays it (F5).
    const owed = { object: "order", id: "ord_1", title: "Camp" };
    expect(attentionTarget(item({ kind: "balance_due", record: owed }), shown)).toEqual({
      kind: "section",
      key: "orders",
      order: "ord_1",
    });
    expect(attentionTarget(item({ kind: "finish_paying", record: owed }), shown)).toEqual({
      kind: "section",
      key: "orders",
      order: "ord_1",
    });
    expect(attentionTarget(item({ kind: "balance_due", record: owed }), [])).toBeNull();
    expect(attentionWords(item({ kind: "balance_due", record: owed })).action).toBe("Pay the rest");
    expect(attentionWords(item({ kind: "finish_paying", record: owed })).action).toBe(
      "Finish paying",
    );
    const pass = item({
      kind: "pass_expiring",
      record: { object: "memberships.pass", id: "p", title: "Ten" },
    });
    expect(attentionTarget(pass, shown)).toEqual({
      kind: "section",
      key: "memberships.memberships",
    });
    // A pack whose section the app does not show: the item is listed, leading nowhere.
    const other = item({
      kind: "pass_used_up",
      record: { object: "bkfixture.pass", id: "p", title: "x" },
    });
    expect(attentionTarget(other, shown)).toBeNull();
    expect(attentionTarget(item(), [])).toBeNull();
  });

  it("opens the provider's page the host gave for a payment the bank waits on", () => {
    const waiting = item({
      kind: "confirm_payment",
      record: { object: "subscription", id: "sub_1", title: "Gold" },
    });
    const subs = [
      { id: "sub_1", planObject: "memberships.plan", actionUrl: "https://pay.example/3ds" },
    ];
    expect(attentionTarget(waiting, shown, subs)).toEqual({
      kind: "page",
      url: "https://pay.example/3ds",
    });
    expect(attentionTarget(waiting, shown)).toEqual({ kind: "section", key: "payment" });
    // Only an https: address is followed (F10); anything else leads to Payment method.
    for (const actionUrl of [
      "javascript:alert(1)",
      "http://pay.example/3ds",
      "data:text/html,x",
      "//evil.example/x",
    ]) {
      expect(
        attentionTarget(waiting, shown, [
          { id: "sub_1", planObject: "memberships.plan", actionUrl },
        ]),
        actionUrl,
      ).toEqual({ kind: "section", key: "payment" });
    }
    const trial = item({
      kind: "trial_ending",
      record: { object: "subscription", id: "sub_1", title: "Gold" },
    });
    expect(attentionTarget(trial, shown, subs)).toEqual({
      kind: "section",
      key: "memberships.memberships",
    });
  });

  it("opens a form by its personal link", () => {
    const form = item({
      kind: "form_to_fill",
      link: "lnk_1",
      record: { object: "forms.form", id: "f", title: "Feedback" },
    });
    expect(attentionTarget(form, shown)).toEqual({ kind: "form", link: "lnk_1" });
  });
});

describe("an address the host gave is followed only when it is https: or this site's (F10)", () => {
  it("follows https: and a path here, nothing else", () => {
    expect(followableUrl("https://pay.example/3ds?x=1")).toBe(true);
    expect(followableUrl("/account#orders")).toBe(true);
    // A local development host's fake provider page.
    expect(followableUrl("http://localhost:5179/fake/pay")).toBe(true);
    expect(followableUrl("http://localhost.evil.example/x")).toBe(false);
    for (const url of [
      "",
      null,
      undefined,
      "http://pay.example",
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "data:text/html,x",
      "//evil.example",
      "/\\evil.example",
      "https:///x",
      "https://pay.example/ x",
      "pay.example",
    ]) {
      expect(followableUrl(url), String(url)).toBe(false);
    }
  });
});

describe("paying an order from Orders (F5)", () => {
  const order = (extra: Partial<AccountOrder>): AccountOrder => ({
    id: "ord_1",
    state: "pending",
    currency: "AUD",
    total: 30000,
    paid: 0,
    balance: 30000,
    refunded: 0,
    pay: "full",
    deposit: null,
    balanceDueAt: null,
    expiresAt: null,
    paidAt: null,
    createdAt: "2026-11-20T00:00:00.000Z",
    taxAmount: 0,
    taxRefunded: 0,
    subscriptionId: null,
    lines: [],
    receiptUrl: null,
    ...extra,
  });

  it("offers to pay an order waiting for payment or with the rest of a deposit to pay", () => {
    expect(showsPay(order({}))).toBe(true);
    expect(payWords(order({}))).toBe("Pay now");
    const rest = order({ state: "part_paid", paid: 10000, balance: 20000, pay: "deposit" });
    expect(showsPay(rest)).toBe(true);
    expect(payWords(rest)).toBe("Pay the rest");
    for (const state of ["paid", "cancelled", "expired", "refunded"] as const) {
      expect(showsPay(order({ state, balance: 0 })), state).toBe(false);
    }
    expect(showsPay(order({ state: "part_paid", balance: 0 }))).toBe(false);
  });

  it("pays through the host's order.checkout, the customer's own order", async () => {
    const calls: { name: string; input: unknown }[] = [];
    const client = {
      operations: { "order.checkout": {} },
      query: () => ({ queryKey: [], queryFn: async () => ({}) }),
      mutation: (name: string) => ({
        mutationKey: [name],
        mutationFn: async (input: unknown) => {
          calls.push({ name, input });
          return { url: "https://pay.example/c", amount: 1, currency: "AUD", kind: "full" };
        },
      }),
    };
    const hooks = createAccountHooks(
      {
        useQuery: () => ({ data: undefined, isPending: true, error: null }),
        useMutation: ((options: { mutationFn: (i: unknown) => Promise<unknown> }) => ({
          mutateAsync: options.mutationFn,
        })) as never,
      },
      client,
    );
    const answer = await hooks
      .useCheckoutOrder()
      .mutateAsync({ id: "ord_1", returnUrl: "https://shop.example/account" });
    expect(calls).toEqual([
      {
        name: "order.checkout",
        input: { id: "ord_1", returnUrl: "https://shop.example/account" },
      },
    ]);
    expect(answer.url).toBe("https://pay.example/c");
  });
});

describe("deleting the account forgets the app's cache at once (F3)", () => {
  function hooksAnswering(answer: unknown) {
    const removed: number[] = [];
    const client = {
      operations: { "me.deleteAccount": {} },
      query: () => ({ queryKey: [], queryFn: async () => ({}) }),
      mutation: (name: string) => ({ mutationKey: [name], mutationFn: async () => answer }),
    };
    const hooks = createAccountHooks(
      {
        useQuery: () => ({ data: undefined, isPending: true, error: null }),
        useMutation: ((options: { mutationFn: (i: unknown) => Promise<unknown> }) => ({
          mutateAsync: options.mutationFn,
        })) as never,
        useQueryClient: () => ({ removeQueries: () => removed.push(1) }),
      },
      client,
    );
    return { hooks, removed };
  }

  it("the app's device session is ended at once once deleted, never on a refusal (native)", async () => {
    const ended: string[] = [];
    const endSession = async () => {
      ended.push("signed out");
    };
    const done = { deleted: true, disabled: true } as never;
    expect((await confirmDelete(async () => done, endSession)).kind).toBe("done");
    expect(ended).toEqual(["signed out"]);
    // A preview answered, a sign-in asked for, a refusal: the device stays signed in.
    await confirmDelete(async () => preview(), endSession);
    await confirmDelete(async () => {
      throw new ApiError("sign_in_again", "Sign in again", 403);
    }, endSession);
    await confirmDelete(async () => {
      throw new ApiError("conflict", "changed", 409, { rule: "preview_changed" });
    }, endSession);
    expect(ended).toEqual(["signed out"]);
    // Offline: forgetting fails, the deletion is still done.
    const offline = await confirmDelete(
      async () => done,
      async () => {
        throw new Error("offline");
      },
    );
    expect(offline.kind).toBe("done");
  });

  it("after the host deleted it, never for the preview", async () => {
    const done = hooksAnswering({ deleted: true, disabled: true });
    await done.hooks.useDeleteAccount().mutateAsync({ confirm: true, expect: "fp" });
    expect(done.removed).toEqual([1]);
    const looked = hooksAnswering(preview());
    await looked.hooks.useDeleteAccount().mutateAsync({});
    expect(looked.removed).toEqual([]);
  });
});

describe("a shell shows only the base sections it draws (F2)", () => {
  const base = (key: string, order: number) => ({
    key,
    pack: null,
    label: key,
    order,
    web: null,
    native: null,
  });
  const portal = {
    sections: [base("orders", 60), base("details", 90), base("contact", 92), base("delete", 99)],
    paysSubscription: false,
  };

  it("leaves out a base section a newer host lists that an older shell has no part for", () => {
    // A shell copied before Contact preferences and Delete my account were added.
    const older = ["orders", "agreements", "family", "payment", "details", "devices"];
    expect(portalSections(portal, [], older).map((s) => s.key)).toEqual(["orders", "details"]);
    expect(portalSections(undefined, [], older).map((s) => s.key)).not.toContain("delete");
    // Without the list, every base section the host lists, as before.
    expect(portalSections(portal).map((s) => s.key)).toEqual([
      "orders",
      "details",
      "contact",
      "delete",
    ]);
  });
});
