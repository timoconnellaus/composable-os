// The `sellable` declaration's contract checks (stage 27, ADR 0435): field types, the granted
// object being another of the extension's objects that declares the void state, the host being
// able to void from every state, the grant's sources, and a deposit needing both of its fields.
import { describe, expect, it } from "vitest";
import { type SellableManifest, validateManifest } from "../src/index.ts";

type Objects = Record<string, Record<string, unknown>>;

const ticketStates = {
  field: "state",
  initial: "valid",
  moves: [
    { from: "valid", to: "used", by: ["staff"] },
    { from: ["valid", "used"], to: "void", by: ["staff", "host"], final: true },
  ],
};

function shop(sellable: Partial<SellableManifest> | undefined, objects: Objects = {}) {
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
        fields: { name: { type: "text", label: "Name", required: true } },
      },
      kind: {
        label: "Ticket type",
        plural: "Ticket types",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          event: { type: "relation", label: "Event", to: "shop.event", required: true },
          optionalEvent: { type: "relation", label: "Event", to: "shop.event" },
          price: { type: "currency", label: "Price", currency: "AUD" },
          label: { type: "text", label: "Label" },
          from: { type: "datetime", label: "From" },
          until: { type: "date", label: "Until" },
          most: { type: "number", label: "Most" },
          deposit: { type: "currency", label: "Deposit" },
          due: { type: "date", label: "Due" },
        },
        ...(sellable ? { sellable: { price: "price", ...sellable } } : {}),
      },
      ticket: {
        label: "Ticket",
        plural: "Tickets",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          code: { type: "text", label: "Code", readOnly: true },
          kind: { type: "relation", label: "Kind", to: "shop.kind", required: true },
          event: { type: "relation", label: "Event", to: "shop.event", required: true },
          holder: { type: "relation", label: "Holder", to: "person" },
          email: { type: "email", label: "Email" },
          order: { type: "text", label: "Order" },
          paid: { type: "currency", label: "Paid" },
          state: {
            type: "select",
            label: "State",
            options: [
              { value: "valid", label: "Valid" },
              { value: "used", label: "Used" },
              { value: "void", label: "Void" },
            ],
          },
        },
        states: ticketStates,
      },
      ...objects,
    },
  };
}

const goodGrant = {
  object: "ticket",
  set: {
    name: "line.title",
    kind: "item",
    event: "item.event",
    holder: "order.person",
    email: "order.email",
    order: "order",
    paid: "line.unitPrice",
    code: "code",
  },
  void: "void",
} as const;

/** The contract issues under objects.kind.sellable, as path: message. */
function issues(sellable: Partial<SellableManifest> | undefined, objects: Objects = {}) {
  const { issues } = validateManifest(shop(sellable, objects));
  return issues.map((i) => `${i.path}: ${i.message}`);
}

describe("sellable: the item's own fields", () => {
  it("accepts a full declaration", () => {
    expect(
      issues({
        saleWindow: { from: "from", until: "until" },
        maxPerOrder: "most",
        deposit: { amount: "deposit", balanceDue: "due" },
        grants: goodGrant,
      }),
    ).toEqual([]);
  });

  it("checks the price, the window, the most per order and the currency", () => {
    expect(issues({ price: "label" })).toEqual([
      'objects.kind.sellable.price: "label" must be a currency or number field of kind',
    ]);
    expect(issues({ currency: "USD" })).toEqual([
      "objects.kind.sellable.currency: The price field is in AUD; currency says USD. Declare one",
    ]);
    expect(issues({ saleWindow: {} })).toEqual([
      "objects.kind.sellable.saleWindow: A sale window names its from field, its until field or both",
    ]);
    expect(issues({ saleWindow: { from: "most" } })).toEqual([
      'objects.kind.sellable.saleWindow.from: "most" must be a date or datetime field of kind',
    ]);
    expect(issues({ maxPerOrder: "price" })).toEqual([
      'objects.kind.sellable.maxPerOrder: "price" must be a number field of kind',
    ]);
  });

  it("a deposit needs both of its fields, of the right types", () => {
    const both =
      "objects.kind.sellable.deposit: A deposit names both fields: amount (the deposit for one) and balanceDue (when the rest is due)";
    expect(issues({ deposit: { amount: "deposit" } })).toEqual([both]);
    expect(issues({ deposit: { balanceDue: "due" } })).toEqual([both]);
    expect(issues({ deposit: { amount: "due", balanceDue: "deposit" } })).toEqual([
      'objects.kind.sellable.deposit.amount: "due" must be a currency or number field of kind',
      'objects.kind.sellable.deposit.balanceDue: "deposit" must be a date or datetime field of kind',
    ]);
  });
});

describe("sellable: what a paid line grants", () => {
  it("the granted object is another of this extension's objects", () => {
    expect(issues({ grants: { ...goodGrant, object: "nothing" } })).toEqual([
      'objects.kind.sellable.grants.object: "nothing" must be another of this extension\'s objects',
    ]);
    expect(issues({ grants: { ...goodGrant, object: "kind", set: {} } })).toEqual([
      "objects.kind.sellable.grants.object: An object cannot grant records of itself",
    ]);
  });

  it("declares states, with the void state and a host move into it from every state", () => {
    const noStates = issues({
      grants: { ...goodGrant, object: "event", set: { name: "line.title" } },
    });
    expect(noStates).toEqual([
      'objects.kind.sellable.grants.object: event must declare states, so what was granted can be voided (to "void")',
    ]);
    expect(issues({ grants: { ...goodGrant, void: "gone" } })).toEqual([
      'objects.kind.sellable.grants.void: "gone" is not a state of ticket',
    ]);
    expect(issues({ grants: { ...goodGrant, void: "valid" } })).toEqual([
      'objects.kind.sellable.grants.void: "valid" is ticket\'s initial state; void is where a grant ends',
    ]);
    // A used ticket the host cannot void.
    const ticket = shop(undefined).objects.ticket;
    const staffOnly = {
      ticket: {
        ...ticket,
        states: {
          ...ticketStates,
          moves: [
            { from: "valid", to: "used", by: ["staff"] },
            { from: "valid", to: "void", by: ["host"], final: true },
            { from: "used", to: "void", by: ["staff"], final: true },
          ],
        },
      },
    };
    expect(issues({ grants: goodGrant }, staffOnly)).toEqual([
      'objects.kind.sellable.grants.void: ticket needs a move from "used" to "void" that the host may make (by: ["host", ...])',
    ]);
  });

  it("checks each source against the field it fills", () => {
    const set = (extra: Record<string, string>) => ({
      grants: { ...goodGrant, set: { ...goodGrant.set, ...extra } },
    });
    expect(issues(set({ kind: "order" }))).toEqual([
      'objects.kind.sellable.grants.set.kind: order needs a text field; "kind" is a relation field',
    ]);
    expect(issues(set({ email: "order.person" }))).toEqual([
      'objects.kind.sellable.grants.set.email: order.person needs a relation to one person; "email" is a email field',
    ]);
    expect(issues(set({ event: "item.nothing" }))).toEqual([
      'objects.kind.sellable.grants.set.event: "nothing" is not a field of kind',
    ]);
    expect(issues(set({ event: "item.label" }))).toEqual([
      'objects.kind.sellable.grants.set.event: item.label needs a text field, like kind.label; "event" is a relation field',
      'objects.kind.sellable.grants.set.event: "event" is required and kind.label may be empty',
    ]);
    // Required, from something that may be empty.
    expect(issues(set({ event: "item.optionalEvent" }))).toEqual([
      'objects.kind.sellable.grants.set.event: "event" is required and kind.optionalEvent may be empty',
    ]);
    expect(issues(set({ state: "order" }))).toContain(
      'objects.kind.sellable.grants.set.state: state is ticket\'s state: a granted record starts in "valid"',
    );
    expect(issues(set({ nothing: "order" }))).toEqual([
      'objects.kind.sellable.grants.set.nothing: "nothing" must be a field of ticket other than a formula',
    ]);
  });

  it("a code goes in one read-only text field", () => {
    expect(issues({ grants: { ...goodGrant, set: { ...goodGrant.set, order: "code" } } })).toEqual([
      'objects.kind.sellable.grants.set.order: "order" holds the host\'s code: make it readOnly, so nobody can change it',
      "objects.kind.sellable.grants.set: A grant has at most one code",
    ]);
  });

  describe("the granted object's own rules cannot refuse the host's insert", () => {
    const ticket = shop(undefined).objects.ticket;
    const fields = ticket.fields as Record<string, Record<string, unknown>>;

    it("no owner: assignment rules would run in the paid batch", () => {
      const owned = {
        ticket: {
          ...ticket,
          fields: { ...fields, owner: { type: "user", label: "Owner" } },
          owner: "owner",
        },
      };
      expect(issues({ grants: goodGrant }, owned)).toEqual([
        "objects.ticket.owner: ticket is granted by kind: an owner would run assignment rules in the paid batch, which could refuse it. Remove owner",
      ]);
    });

    it("requireOneOf needs a field the grant always fills", () => {
      const oneOf = (group: string[]) => ({ ticket: { ...ticket, requireOneOf: [group] } });
      // holder comes from order.person, which may be empty; email from order.email always has one.
      expect(issues({ grants: goodGrant }, oneOf(["holder", "paid"]))).toEqual([]);
      const { paid: _paid, ...set } = goodGrant.set;
      expect(issues({ grants: { ...goodGrant, set } }, oneOf(["holder", "paid"]))).toEqual([
        "objects.ticket.requireOneOf.0: ticket is granted by kind: set one of holder, paid in grants.set from a source that always has a value",
      ]);
      expect(issues({ grants: goodGrant }, oneOf(["holder", "email"]))).toEqual([]);
    });

    it("a choice the record starts in needs only fields the grant always fills", () => {
      const withRequires = (requires: string[]) => ({
        ticket: {
          ...ticket,
          fields: {
            ...fields,
            state: {
              type: "select",
              label: "State",
              options: [
                { value: "valid", label: "Valid", requires },
                { value: "used", label: "Used", requires: ["holder"] },
                { value: "void", label: "Void" },
              ],
            },
          },
        },
      });
      // The initial state is what a granted record holds; `used` is reached later by staff.
      expect(issues({ grants: goodGrant }, withRequires(["email"]))).toEqual([]);
      expect(issues({ grants: goodGrant }, withRequires(["holder"]))).toEqual([
        'objects.ticket.fields.state.options: ticket is granted by kind: "valid" needs holder, which grants.set does not always fill',
      ]);
      // A select set from the item can hold any of its choices.
      const fromItem = {
        ticket: {
          ...ticket,
          fields: {
            ...fields,
            tier: {
              type: "select",
              label: "Tier",
              options: [
                { value: "a", label: "A" },
                { value: "b", label: "B", requires: ["holder"] },
              ],
            },
          },
        },
        kind: {
          ...shop(undefined).objects.kind,
          fields: {
            ...(shop(undefined).objects.kind.fields as Record<string, unknown>),
            tier: {
              type: "select",
              label: "Tier",
              options: [
                { value: "a", label: "A" },
                { value: "b", label: "B" },
              ],
            },
          },
          sellable: {
            price: "price",
            grants: { ...goodGrant, set: { ...goodGrant.set, tier: "item.tier" } },
          },
        },
      };
      expect(issues(undefined, fromItem)).toEqual([
        'objects.ticket.fields.tier.options: ticket is granted by kind: "b" needs holder, which grants.set does not always fill',
      ]);
    });
  });

  it("every required field of the granted object is set", () => {
    const { kind: _kind, ...set } = goodGrant.set;
    expect(issues({ grants: { ...goodGrant, set } })).toEqual([
      "objects.kind.sellable.grants.set: ticket.kind is required: set it from the item, the order or the line",
    ]);
  });

  it("refuses an unknown source and an unknown key", () => {
    const unknownSource = issues({
      grants: { ...goodGrant, set: { ...goodGrant.set, order: "payment" as never } },
    });
    expect(unknownSource.join("\n")).toMatch(/objects\.kind\.sellable\.grants\.set\.order/);
    expect(
      issues({ grants: goodGrant, price: "price", ...{ fee: "price" } } as never).join("\n"),
    ).toMatch(/objects\.kind\.sellable/);
  });
});
