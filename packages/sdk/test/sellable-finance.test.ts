// `sellable.finance` (stage 52 step 2, ADR 0792): what kind of sale an object is in the finance
// reports and when its money is earned. Each way of earning names what the host reads to work it
// out, and one category key has one label across an extension.
import { describe, expect, it } from "vitest";
import {
  FINANCE_DEFAULTS,
  type SellableManifest,
  sellableFinance,
  validateManifest,
} from "../src/index.ts";

const passStates = {
  field: "state",
  initial: "active",
  moves: [{ from: "active", to: "void", by: ["host"], final: true }],
};

function shop(kind: Partial<SellableManifest>, extra: Record<string, unknown> = {}) {
  return {
    id: "shop",
    version: "1.0.0",
    contractVersion: 1,
    permissions: {},
    objects: {
      event: {
        label: "Event",
        plural: "Events",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          startsAt: { type: "datetime", label: "Starts" },
          venue: { type: "text", label: "Venue" },
        },
      },
      kind: {
        label: "Ticket type",
        plural: "Ticket types",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          event: { type: "relation", label: "Event", to: "shop.event", required: true },
          events: { type: "relation", label: "Events", to: "shop.event", many: true },
          price: { type: "currency", label: "Price" },
          uses: { type: "number", label: "Uses" },
          day: { type: "date", label: "Day" },
        },
        sellable: { price: "price", ...kind },
      },
      pass: {
        label: "Pass",
        plural: "Passes",
        titleField: "state",
        fields: {
          person: { type: "relation", label: "Person", to: "person", readOnly: true },
          kind: { type: "relation", label: "Kind", to: "shop.kind", required: true },
          uses: { type: "number", label: "Uses", readOnly: true },
          state: {
            type: "select",
            label: "State",
            options: [
              { value: "active", label: "Active" },
              { value: "void", label: "Void" },
            ],
          },
        },
        states: passStates,
        allowance: {
          holds: {
            person: "person",
            uses: "uses",
            per: "total",
            spendsOn: { object: "shop.event" },
          },
        },
      },
      ...extra,
    },
  };
}

const grantsPass = {
  object: "pass",
  set: { person: "order.person", kind: "item", uses: "item.uses" },
  void: "void",
} as const;

/** The contract issues under sellable.finance, as path: message. */
function issues(kind: Partial<SellableManifest>, extra: Record<string, unknown> = {}) {
  const { issues } = validateManifest(shop(kind, extra));
  return issues
    .filter((i) => i.path.includes(".sellable.finance"))
    .map((i) => `${i.path}: ${i.message}`);
}

describe("sellable.finance", () => {
  it("is optional: left out, a sale is category other, earned at sale", () => {
    expect(issues({})).toEqual([]);
    expect(sellableFinance(undefined)).toEqual(FINANCE_DEFAULTS);
    expect(sellableFinance({ earned: "per_use" })).toEqual({
      category: { key: "other", label: "Other" },
      earned: "per_use",
    });
  });

  it("at_date names a date or datetime field, here or through relations", () => {
    expect(issues({ finance: { earned: "at_date", at: "day" } })).toEqual([]);
    expect(issues({ finance: { earned: "at_date", at: "event.startsAt" } })).toEqual([]);
    expect(issues({ finance: { earned: "at_date" } })).toEqual([
      "objects.kind.sellable.finance.at: at_date names its date: at, a date or datetime field",
    ]);
    const bad = (at: string) =>
      `objects.kind.sellable.finance.at: "${at}" must be a date or datetime field of kind, or <relation>.<field> through up to two relations, every field on the way declared by this extension`;
    expect(issues({ finance: { earned: "at_date", at: "event.venue" } })).toEqual([
      bad("event.venue"),
    ]);
    expect(issues({ finance: { earned: "at_date", at: "events.startsAt" } })).toEqual([
      bad("events.startsAt"),
    ]);
    expect(issues({ finance: { earned: "at_date", at: "nothing" } })).toEqual([bad("nothing")]);
    expect(issues({ finance: { earned: "at_sale", at: "day" } })).toEqual([
      "objects.kind.sellable.finance.at: at is the date of at_date: declare earned: at_date, or remove at",
    ]);
  });

  it("over_period is only a plan's", () => {
    expect(
      issues({ recurring: { interval: "month" }, finance: { earned: "over_period" } }),
    ).toEqual([]);
    expect(issues({ finance: { earned: "over_period" } })).toEqual([
      "objects.kind.sellable.finance.earned: over_period is earned over a paid period: only a plan (recurring) has one",
    ]);
  });

  it("per_use needs a grant of something that holds uses", () => {
    expect(issues({ grants: grantsPass, finance: { earned: "per_use" } })).toEqual([]);
    const needs =
      "objects.kind.sellable.finance.earned: per_use is earned as uses are spent: grants must grant an object that holds uses (allowance.holds)";
    expect(issues({ finance: { earned: "per_use" } })).toEqual([needs]);
    const ticket = {
      label: "Ticket",
      plural: "Tickets",
      titleField: "state",
      fields: {
        state: {
          type: "select",
          label: "State",
          options: [
            { value: "active", label: "Active" },
            { value: "void", label: "Void" },
          ],
        },
      },
      states: passStates,
    };
    expect(
      issues(
        { grants: { object: "ticket", set: {}, void: "void" }, finance: { earned: "per_use" } },
        { ticket },
      ),
    ).toEqual([needs]);
  });

  it("a category key is lower case, and has one label across the extension", () => {
    expect(
      validateManifest(shop({ finance: { category: { key: "Tickets", label: "Tickets" } } })).issues
        .length,
    ).toBeGreaterThan(0);
    const plan = (label: string) => ({
      plan: {
        label: "Plan",
        plural: "Plans",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          price: { type: "currency", label: "Price" },
        },
        sellable: {
          price: "price",
          recurring: { interval: "month" },
          finance: { category: { key: "tickets", label }, earned: "over_period" },
        },
      },
    });
    const same = { finance: { category: { key: "tickets", label: "Tickets" } } };
    expect(issues(same, plan("Tickets"))).toEqual([]);
    expect(issues(same, plan("Season tickets"))).toEqual([
      'objects.kind.sellable.finance.category.label: plan names category "tickets" "Season tickets": one category has one label',
      'objects.plan.sellable.finance.category.label: kind names category "tickets" "Tickets": one category has one label',
    ]);
  });
});
