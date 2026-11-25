// The account entry's logic for stage 48 step 7, which the attention, change-address and delete
// blocks share, web and native: a refusal for an old sign-in is its own outcome and never done;
// nothing is confirmed for deletion without the host's preview and the typed word; the preview is
// put in words whole; an attention item says whose it is and leads only to a section the host
// listed. Fixture values only; the host's side is core's tests (customer-email-change,
// me-attention, the delete tests).
import { describe, expect, it } from "vitest";
import {
  ApiError,
  type AttentionItem,
  attentionTarget,
  attentionWords,
  DELETE_WORD,
  type DeletePreview,
  deleteConfirmInput,
  deletePreviewWords,
  emailChangeErrorWords,
  emailChangeProblem,
  isPreviewChanged,
  isSignInAgain,
  sensitive,
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
    expect(attentionTarget(item({ kind: "balance_due" }), shown)).toEqual({
      kind: "section",
      key: "orders",
    });
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
