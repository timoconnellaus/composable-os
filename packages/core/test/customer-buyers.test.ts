// Customer sign-in for buyers (ADR 0458): with sign-up `buyers`, a code goes to an address staff
// invited, one with an account, or the buyer's address of an order a verified payment was applied
// to. A checkout only started (pending, expired, cancelled unpaid) never counts. `invite_only` and
// `open` are unchanged. Changing the mode is a human admin's, audited.
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, customerMayGetCode, invoke, linkCustomer, newId } from "../src/index.ts";
import { erasedAddressHash } from "../src/records/erase-subject.ts";
import { auditChanges, context, createUser, db, unique } from "./helpers.ts";

let admin: ActingUser;

const setSignup = (signup: "open" | "buyers" | "invite_only", by = admin, extra = {}) =>
  invoke("customer.settings.update", { signup }, context(by, extra as never));

/** An order for `email` in `state` with `paid` applied, as stage 25 leaves one. */
async function order(email: string, state: string, paid: number, personId: string | null = null) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO core_order (id, person_id, email, currency, total, paid, state, placed_as, created_at, updated_at)
     VALUES (?, ?, ?, 'EUR', 5000, ?, ?, 'public', ?, ?)`,
  )
    .bind(newId("order"), personId, email, paid, state, now, now)
    .run();
}

const address = (label: string) => `${unique(label)}@buyers.test`.toLowerCase();

beforeAll(async () => {
  admin = await createUser("admin");
});
afterAll(() => setSignup("invite_only"));

describe("sign-up `buyers`", () => {
  it("sends a code to the buyer of a paid, part-paid, or refunded-after-payment order", async () => {
    await setSignup("buyers");
    for (const [state, paid] of [
      ["paid", 5000],
      ["part_paid", 1000],
      ["refunded", 5000],
      ["cancelled", 1000],
    ] as const) {
      const email = address(state);
      await order(email, state, paid);
      expect(await customerMayGetCode(db.query, email), state).toBe(true);
    }
  });

  it("never for a checkout only started, an expired one, or one cancelled unpaid", async () => {
    await setSignup("buyers");
    for (const state of ["pending", "expired", "cancelled"]) {
      const email = address(`unpaid-${state}`);
      await order(email, state, 0);
      expect(await customerMayGetCode(db.query, email), state).toBe(false);
    }
    expect(await customerMayGetCode(db.query, address("nobody"))).toBe(false);
  });

  it("still sends to an invited address and an account, and never to an erased address", async () => {
    await setSignup("buyers");
    const invited = address("invited");
    await invoke("customer.invite", { email: invited }, context(admin));
    expect(await customerMayGetCode(db.query, invited)).toBe(true);
    const erased = address("erased");
    await order(erased, "paid", 5000);
    await env.DB.prepare(
      "INSERT INTO core_erased_address (hash, object_type, erased_at) VALUES (?, 'person', ?)",
    )
      .bind(await erasedAddressHash(erased), new Date().toISOString())
      .run();
    expect(await customerMayGetCode(db.query, erased)).toBe(false);
  });

  it("`invite_only` gives a buyer nothing; `open` gives anyone a code", async () => {
    const buyer = address("buyer");
    await order(buyer, "paid", 5000);
    await setSignup("invite_only");
    expect(await customerMayGetCode(db.query, buyer)).toBe(false);
    await setSignup("open");
    expect(await customerMayGetCode(db.query, address("anyone"))).toBe(true);
    await setSignup("buyers");
    expect(await customerMayGetCode(db.query, buyer)).toBe(true);
  });

  it("a buyer's first sign-in links the account to the buyer's Person, or waits for a merge", async () => {
    await setSignup("buyers");
    const now = new Date().toISOString();
    // One Person with the address (the order made or matched it): linked, and the order is theirs.
    const email = address("linked");
    const person = await invoke(
      "person.create",
      { givenName: "Buyer", emails: [{ email }] },
      context(admin),
    );
    await order(email, "paid", 5000, person.id);
    const id = newId("customer");
    await env.DB.prepare(
      "INSERT INTO core_customer (id, email, email_verified, created_at, updated_at) VALUES (?, ?, 1, ?, ?)",
    )
      .bind(id, email, now, now)
      .run();
    expect(await linkCustomer(db, id)).toMatchObject({ linkState: "linked", personId: person.id });
    // An order whose address matched several People belongs to no one (ADR 0428); its buyer's
    // account then waits for staff to merge them, by the same linkCustomer path an invited
    // customer takes (customer-accounts.test.ts and customer-erase.test.ts cover it).
  });
});

describe("changing who may sign in", () => {
  it("is a human admin's: refused to MCP, the assistant, automations and a member; audited", async () => {
    for (const extra of [
      { actor: "mcp", origin: { surface: "mcp", clientId: "c", clientName: "T", sessionId: "s" } },
      { actor: "assistant", origin: { surface: "assistant", sessionId: "ath_1" } },
      { actor: "automation", origin: { surface: "automation", automationId: "aut_1" } },
    ]) {
      await expect(setSignup("open", admin, extra)).rejects.toMatchObject({ code: "forbidden" });
    }
    const member = await createUser("member");
    await expect(setSignup("open", member)).rejects.toMatchObject({ code: "forbidden" });
    await setSignup("invite_only");
    await setSignup("buyers");
    const changes = await auditChanges("customer_signup");
    expect(changes.at(-1)?.diff).toEqual({ signup: { before: "invite_only", after: "buyers" } });
  });
});
