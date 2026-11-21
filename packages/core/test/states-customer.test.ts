// Stage 25, second half (ADR 0426): a customer is a mover. When a signed-in customer changes one
// of their own records through the seam, the host writes it for them, and the transition engine
// judges the move as the customer's: a move that lists `customer` is allowed, one for `staff`
// only is refused, and the history row says who moved it as, with no staff user as its author.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, type CustomerPrincipal, invoke } from "../src/index.ts";
import { call, declareCustomers, outside } from "./customer-fixtures.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, unique } from "./helpers.ts";

const ext = extId("sc");
const BOOKING = `${ext}.booking`;

let admin: ActingUser;
let customer: CustomerPrincipal;
let other: CustomerPrincipal;

async function createCustomer(label: string): Promise<CustomerPrincipal> {
  const tag = unique(label);
  const person = await invoke(
    "person.create",
    { givenName: tag, emails: [{ email: `${tag}@movers.example` }] },
    context(admin),
  );
  return { kind: "customer", customerId: `cus_${tag}`, personId: person.id };
}

async function booking(holder: string): Promise<string> {
  const created = await invoke(
    "record.create",
    { object: BOOKING, values: { name: unique("Booking"), holder } },
    context(admin),
  );
  return created.id;
}

async function history(id: string) {
  const { results } = await env.DB.prepare(
    "SELECT position_id, entered_as, entered_by FROM core_transition_history WHERE object_type = ? AND record_id = ? ORDER BY entered_at, rowid",
  )
    .bind(BOOKING, id)
    .all();
  return results;
}

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(
    manifest(ext, {
      objects: {
        booking: {
          label: "Booking",
          plural: "Bookings",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            state: {
              type: "select",
              label: "State",
              options: [
                { value: "requested", label: "Requested" },
                { value: "confirmed", label: "Confirmed" },
                { value: "cancelled", label: "Cancelled" },
              ],
            },
            holder: { type: "relation", label: "Holder", to: "person" },
          },
          states: {
            field: "state",
            initial: "requested",
            moves: [
              { from: "requested", to: "confirmed", by: ["staff"] },
              {
                from: ["requested", "confirmed"],
                to: "cancelled",
                by: ["customer", "staff"],
                final: true,
              },
            ],
          },
        },
      },
    } as never),
  );
  await declareCustomers({
    [BOOKING]: { field: "holder", read: ["name", "state"], write: ["state"] },
  });
  customer = await createCustomer("mover");
  other = await createCustomer("other");
}, 60_000);

describe("a customer moves their own record as a customer", () => {
  it("a move that lists `customer` is allowed, and the history names no staff author", async () => {
    const id = await booking(customer.personId);
    const done = await call(
      "fixture.myUpdate",
      { object: BOOKING, id, values: { state: "cancelled" } },
      outside(customer),
    );
    expect(done).toMatchObject({ ok: true, value: { values: { state: "cancelled" } } });
    expect(await history(id)).toEqual([
      { position_id: "requested", entered_as: "staff", entered_by: admin.id },
      { position_id: "cancelled", entered_as: "customer", entered_by: null },
    ]);
  });

  it("a move for staff only is refused to the customer, with who may make it", async () => {
    const id = await booking(customer.personId);
    const refused = await call(
      "fixture.myUpdate",
      { object: BOOKING, id, values: { state: "confirmed" } },
      outside(customer),
    );
    expect(refused).toMatchObject({
      ok: false,
      error: {
        code: "invalid_input",
        details: { rule: "state_move_not_permitted", by: ["staff"] },
      },
    });
    expect(await history(id)).toHaveLength(1);
    // Staff make it, and then the customer may still cancel.
    await invoke(
      "record.update",
      { object: BOOKING, id, values: { state: "confirmed" } },
      context(admin),
    );
    expect(
      await call(
        "fixture.myUpdate",
        { object: BOOKING, id, values: { state: "cancelled" } },
        outside(customer),
      ),
    ).toMatchObject({ ok: true });
  });

  it("another customer's record is not theirs to move", async () => {
    const id = await booking(customer.personId);
    expect(
      await call(
        "fixture.myUpdate",
        { object: BOOKING, id, values: { state: "cancelled" } },
        outside(other),
      ),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await history(id)).toHaveLength(1);
  });
});
