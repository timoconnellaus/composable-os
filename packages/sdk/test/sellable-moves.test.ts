// `sellable.moves` (stage 31a step 8, ADR 0560): a paid line moves a record that already exists (a
// drop-in booking held while its order is unpaid). The contract refuses each way the order's
// batch could fail, and each way someone could hold a place with no order.
import { describe, expect, it } from "vitest";
import { validateManifest } from "../src/index.ts";

const moves = {
  held: "pending",
  paid: "booked",
  expired: "expired",
  refund: ["cancelled"],
  price: { field: "class.price", setting: "price" },
  title: "class.name",
  order: "order",
};

function gym(over: { sellable?: object; booking?: object; createIn?: object; moves?: object[] }) {
  return {
    id: "gym",
    version: "1.0.0",
    contractVersion: 1,
    permissions: {},
    settings: { price: { type: "number", label: "Price" } },
    objects: {
      class: {
        label: "Class",
        plural: "Classes",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          price: { type: "number", label: "Price" },
          places: { type: "number", label: "Places", required: true },
        },
        capacity: { places: "places" },
        public: { read: ["name"] },
      },
      booking: {
        label: "Booking",
        plural: "Bookings",
        titleField: "title",
        fields: {
          title: { type: "text", label: "Title" },
          class: { type: "relation", label: "Class", to: "gym.class", required: true },
          person: { type: "relation", label: "Person", to: "person", required: true },
          state: {
            type: "select",
            label: "State",
            options: ["booked", "pending", "expired", "cancelled"].map((value) => ({
              value,
              label: value,
            })),
          },
          paid: { type: "number", label: "Paid", readOnly: true },
          order: { type: "text", label: "Order", readOnly: true },
        },
        states: {
          field: "state",
          initial: "booked",
          create: { in: over.createIn ?? { pending: ["host"] } },
          moves: over.moves ?? [
            { from: "pending", to: "booked", by: ["host"] },
            { from: "pending", to: "expired", by: ["host"], final: true },
            { from: "booked", to: "cancelled", by: ["customer", "staff"], final: true },
          ],
        },
        claims: { on: "class", held: ["pending"], confirmed: ["booked"] },
        customer: { field: "person", read: ["class", "state"], write: ["class", "state"] },
        sellable: { price: "paid", moves, ...(over.sellable ?? {}) },
        ...(over.booking ?? {}),
      },
    },
  };
}

const problems = (over: Parameters<typeof gym>[0] = {}) =>
  validateManifest(gym(over)).issues.map((i) => `${i.path}: ${i.message}`);

describe("sellable.moves", () => {
  it("accepts a drop-in booking", () => {
    expect(problems()).toEqual([]);
  });

  it("refuses a held state anyone but the host may create, or leave", () => {
    expect(problems({ createIn: { pending: ["host", "customer"] } }).join("\n")).toContain(
      "Only the host creates booking",
    );
    expect(
      problems({
        moves: [
          { from: "pending", to: "booked", by: ["host", "staff"] },
          { from: "pending", to: "expired", by: ["host"], final: true },
        ],
      }).join("\n"),
    ).toContain("Only the host moves booking out of");
    expect(problems({ createIn: {} }).join("\n")).toContain("states.create.in must let the host");
  });

  it("refuses an expired state that is not final, and missing host moves", () => {
    const out = problems({
      moves: [
        { from: "pending", to: "booked", by: ["host"] },
        { from: "pending", to: "expired", by: ["host"] },
      ],
    }).join("\n");
    expect(out).toContain('"expired" must be a final state');
    expect(
      problems({ moves: [{ from: "pending", to: "expired", by: ["host"], final: true }] }).join(
        "\n",
      ),
    ).toContain('needs a move from "pending" to "booked"');
  });

  it("refuses a price field anyone could write, and wrong paths and settings", () => {
    expect(
      problems({
        booking: {},
        sellable: { price: "title" },
      }).join("\n"),
    ).toMatch(/price|readOnly/);
    expect(
      problems({ sellable: { moves: { ...moves, price: { field: "class.name" } } } }).join("\n"),
    ).toContain("must be a number field");
    expect(
      problems({ sellable: { moves: { ...moves, price: { setting: "nope" } } } }).join("\n"),
    ).toContain("must be a number setting");
    expect(problems({ sellable: { moves: { ...moves, order: "title" } } }).join("\n")).toContain(
      "must be a readOnly text field",
    );
  });

  it("refuses what one record on one order cannot have", () => {
    expect(problems({ sellable: { maxPerOrder: "paid" } }).join("\n")).toContain(
      "it has no maxPerOrder",
    );
  });

  it("refuses refund states that are held or expired", () => {
    expect(
      problems({ sellable: { moves: { ...moves, refund: ["pending"] } } }).join("\n"),
    ).toContain("other than held and expired");
  });
});
