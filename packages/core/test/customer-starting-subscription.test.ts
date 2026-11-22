// Anyone starting a subscription (ADR 0459): on top of the sign-up mode, an address with no account
// may get a sign-in code while the host has a plan on sale to the public. Off by default; a human
// admin's to change. Asking writes nothing; the account and its Person come at sign-in, as for
// the other modes. The trial rule is unchanged: one per Person per plan object (ADR 0489), so a
// new address is a new Person and a new trial, and the same Person never gets a second.
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  findPlanOnSale,
  forgetPlanOnSale,
  hasPlanOnSale,
  PLANS_LOOKED_AT,
} from "../src/customers/plan-on-sale.ts";
import {
  type ActingUser,
  checkCodeRequestLimit,
  customerCodeReason,
  customerMayGetCode,
  invoke,
  linkCustomer,
  mailboxKey,
  memoryEventSink,
  memoryRateLimit,
  newId,
  type ProviderSubscription,
  watchSubscriberSignup,
} from "../src/index.ts";
import { erasedAddressHash } from "../src/records/erase-subject.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { auditChanges, context, createUser, db, unique } from "./helpers.ts";
import { CURRENCY, createBuyer, outside, run } from "./order-fixtures.ts";
import { paymentsDouble } from "./payments-double.ts";

const SCHOOL = extId("studio");
const PLAN = `${SCHOOL}.plan`;
const PRIVATE_PLAN = `${SCHOOL}.staffplan`;
const RETURN = "https://shop.example.com/account";
const DAY = 86_400_000;

let events: ReturnType<typeof memoryEventSink>;
const payments = paymentsDouble(() => events);
let admin: ActingUser;
let plan: string;

const address = (label: string) => `${unique(label)}@visitors.test`.toLowerCase();

const update = (input: Record<string, unknown>, by = admin, extra = {}) =>
  invoke("customer.settings.update", input, context(by, extra as never));

const create = async (object: string, values: Record<string, unknown>) =>
  ((await run("record.create", { object, values }, context(admin))) as { id: string }).id;

async function count(table: "core_customer" | "core_person" | "core_customer_invite") {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

/** A customer account made at first sign-in, as Better Auth's hook makes it, then linked. */
async function signIn(email: string) {
  const id = newId("customer");
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_customer (id, email, email_verified, created_at, updated_at) VALUES (?, ?, 1, ?, ?)",
  )
    .bind(id, email, now, now)
    .run();
  const linked = await linkCustomer(db, id);
  if (!linked.personId) throw new Error("not linked");
  return { kind: "customer" as const, customerId: id, personId: linked.personId };
}

type Started = { subscriptionId: string; trialDays: number | null; noTrial: string | null };

const start = (principal: Awaited<ReturnType<typeof signIn>>) =>
  run<Started>(
    "subscription.start",
    { plan: { object: PLAN, id: plan }, returnUrl: RETURN },
    outside(principal, { integrations: payments.runtime, events }),
  );

function confirmed(id: string): ProviderSubscription {
  return {
    provider: "fake",
    ref: `fsub_${id}`,
    customerRef: `fcus_${id}`,
    subscriptionId: id,
    status: "trialing",
    amount: 2900,
    currency: CURRENCY,
    interval: "month",
    cancelAtPeriodEnd: false,
    cancelAt: null,
    trialEnd: new Date(Date.now() + 7 * DAY).toISOString(),
    currentPeriodStart: new Date().toISOString(),
    currentPeriodEnd: new Date(Date.now() + 7 * DAY).toISOString(),
    canceledAt: null,
    endedAt: null,
    endReason: null,
    observedAt: new Date().toISOString(),
  };
}

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(
    manifest(SCHOOL, {
      objects: {
        plan: {
          label: "Plan",
          plural: "Plans",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            price: { type: "currency", label: "Price per month", currency: CURRENCY },
            trialDays: { type: "number", label: "Trial days" },
          },
          sellable: { price: "price", recurring: { interval: "month", trialDays: "trialDays" } },
          public: { read: ["name", "price", "trialDays"] },
        },
        // A plan the public cannot read: never "on sale" to a new visitor.
        staffplan: {
          label: "Staff plan",
          plural: "Staff plans",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            price: { type: "currency", label: "Price per month", currency: CURRENCY },
          },
          sellable: { price: "price", recurring: { interval: "month" } },
        },
      },
    }),
  );
});

beforeEach(() => {
  events = memoryEventSink();
});

afterAll(() => update({ signup: "invite_only", startingSubscription: false }));

describe("whether a plan is on sale", () => {
  it("needs the orders' currency, a payments connection and a live public plan priced above nothing", async () => {
    expect(await hasPlanOnSale(db.query)).toBe(false); // no currency yet
    await run(
      "order.settings.update",
      { currency: CURRENCY, returnOrigins: ["https://shop.example.com"] },
      context(admin),
    );
    await create(PRIVATE_PLAN, { name: "Staff only", price: 10 });
    const free = await create(PLAN, { name: "Free", price: 0 });
    expect(await hasPlanOnSale(db.query)).toBe(false); // no payments connection
    await payments.connect(admin.id);
    // A plan the public cannot read, and one with nothing to pay: neither can be started.
    expect(await hasPlanOnSale(db.query)).toBe(false);
    plan = await create(PLAN, { name: "Every class", price: 29, trialDays: 7 });
    expect(await hasPlanOnSale(db.query)).toBe(true);
    // In the Trash, it is not on sale.
    await invoke("record.delete", { object: PLAN, id: plan }, context(admin));
    expect(await hasPlanOnSale(db.query)).toBe(false);
    await invoke("record.restore", { object: PLAN, id: plan }, context(admin));
    expect(await hasPlanOnSale(db.query)).toBe(true);
    await invoke("record.delete", { object: PLAN, id: free }, context(admin));
  });
});

describe("who may get a code", () => {
  it("off (the default): a new address gets nothing, plan or no plan", async () => {
    expect(await hasPlanOnSale(db.query)).toBe(true);
    for (const signup of ["invite_only", "buyers"] as const) {
      await update({ signup });
      expect(await customerCodeReason(db.query, address("new"))).toBeNull();
    }
    const got = (await invoke("customer.settings.get", {}, context(admin))) as {
      startingSubscription: boolean;
      planOnSale: boolean;
    };
    expect(got).toMatchObject({ startingSubscription: false, planOnSale: true });
  });

  it("on, with a plan on sale: any new address; with none on sale: no new address", async () => {
    await update({ signup: "invite_only", startingSubscription: true });
    expect(await customerCodeReason(db.query, address("visitor"))).toBe("subscription");
    expect(await customerMayGetCode(db.query, address("visitor"))).toBe(true);
    await invoke("record.delete", { object: PLAN, id: plan }, context(admin));
    expect(await customerCodeReason(db.query, address("visitor"))).toBeNull();
    await invoke("record.restore", { object: PLAN, id: plan }, context(admin));
  });

  it("adds to the mode: members plus buyers plus anyone starting a subscription", async () => {
    await update({ signup: "buyers", startingSubscription: true });
    const invited = address("invited");
    await invoke("customer.invite", { email: invited }, context(admin));
    const buyer = address("buyer");
    const at = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO core_order (id, email, currency, total, paid, state, placed_as, created_at, updated_at)
       VALUES (?, ?, ?, 5000, 5000, 'paid', 'public', ?, ?)`,
    )
      .bind(newId("order"), buyer, CURRENCY, at, at)
      .run();
    const member = await createBuyer(admin, "member");
    expect(await customerCodeReason(db.query, invited)).toBe("invite");
    expect(await customerCodeReason(db.query, buyer)).toBe("buyer");
    expect(await customerCodeReason(db.query, member.email)).toBe("account");
    expect(await customerCodeReason(db.query, address("stranger"))).toBe("subscription");
    // Turned off again, the buyer and the member still may; the stranger may not.
    await update({ startingSubscription: false });
    expect(await customerCodeReason(db.query, buyer)).toBe("buyer");
    expect(await customerCodeReason(db.query, address("stranger"))).toBeNull();
    await update({ signup: "invite_only", startingSubscription: true });
  });

  it("never an erased address, nor a disabled account", async () => {
    const erased = address("erased");
    await env.DB.prepare(
      "INSERT INTO core_erased_address (hash, object_type, erased_at) VALUES (?, 'person', ?)",
    )
      .bind(await erasedAddressHash(erased), new Date().toISOString())
      .run();
    expect(await customerCodeReason(db.query, erased)).toBeNull();
    const member = await createBuyer(admin, "disabled");
    await env.DB.prepare("UPDATE core_customer SET status = 'disabled' WHERE email = ?")
      .bind(member.email)
      .run();
    expect(await customerCodeReason(db.query, member.email)).toBeNull();
  });

  it("asking writes nothing: no account, no Person, no invite until the code is entered", async () => {
    const before = await Promise.all([
      count("core_customer"),
      count("core_person"),
      count("core_customer_invite"),
    ]);
    for (let i = 0; i < 5; i += 1) await customerCodeReason(db.query, address("ask"));
    expect(
      await Promise.all([
        count("core_customer"),
        count("core_person"),
        count("core_customer_invite"),
      ]),
    ).toEqual(before);
  });
});

describe("the trial, unchanged", () => {
  it("a new visitor who confirmed their address gets the trial once; a second address is a second Person and a second trial", async () => {
    await update({ startingSubscription: true });
    const email = address("trial");
    expect(await customerCodeReason(db.query, email)).toBe("subscription");
    const visitor = await signIn(email); // no Person had the address: one is made at sign-in
    const first = await start(visitor);
    expect(first).toMatchObject({ trialDays: 7, noTrial: null });
    await payments.deliver({
      kind: "subscription",
      provider: "fake",
      eventId: `fevt_${unique("s")}`,
      trigger: "checkout_completed",
      subscription: confirmed(first.subscriptionId),
      occurredAt: new Date().toISOString(),
    });
    // The same Person again: no second trial.
    expect(await start(visitor)).toMatchObject({ trialDays: null, noTrial: "used" });
    // Another address they control is another Person until staff merge them: another trial.
    const other = await signIn(address("trial-again"));
    expect(other.personId).not.toBe(visitor.personId);
    expect(await start(other)).toMatchObject({ trialDays: 7, noTrial: null });
  });
});

describe("changing it", () => {
  it("is a human admin's: refused to MCP, the assistant, automations and a member; audited", async () => {
    for (const extra of [
      { actor: "mcp", origin: { surface: "mcp", clientId: "c", clientName: "T", sessionId: "s" } },
      { actor: "assistant", origin: { surface: "assistant", sessionId: "ath_1" } },
      { actor: "automation", origin: { surface: "automation", automationId: "aut_1" } },
    ]) {
      await expect(update({ startingSubscription: true }, admin, extra)).rejects.toMatchObject({
        code: "forbidden",
      });
    }
    const member = await createUser("member");
    await expect(update({ startingSubscription: true }, member)).rejects.toMatchObject({
      code: "forbidden",
    });
    await update({ startingSubscription: false });
    await update({ startingSubscription: true });
    const changes = await auditChanges("customer_signup_subscribers");
    expect(changes.at(-1)?.diff).toEqual({
      startingSubscription: { before: false, after: true },
    });
  });

  it("is not on MCP", async () => {
    const { coreRegistry } = await import("../src/index.ts");
    const op = coreRegistry.get("customer.settings.update");
    expect(op?.mcp?.expose).toBe(false);
    expect(op?.actors).toEqual(["human"]);
  });
});

describe("people already in the records (review of ADR 0459)", () => {
  it("an address that already has a Person with history gets a code, links to that Person and sees its orders", async () => {
    await update({ signup: "invite_only", startingSubscription: true });
    const email = address("contact");
    const person = await invoke(
      "person.create",
      { givenName: "Known", emails: [{ email }] },
      context(admin),
    );
    const orderId = newId("order");
    const at = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO core_order (id, person_id, email, currency, total, paid, state, placed_as, created_at, updated_at)
       VALUES (?, ?, ?, ?, 5000, 5000, 'paid', 'staff', ?, ?)`,
    )
      .bind(orderId, person.id, email, CURRENCY, at, at)
      .run();
    // Not a buyer by the mode (invite only), not invited: the switch alone lets them in.
    expect(await customerCodeReason(db.query, email)).toBe("subscription");
    const customer = await signIn(email);
    expect(customer.personId).toBe(person.id);
    const mine = await run<{ id: string; state: string }>(
      "order.get",
      { id: orderId },
      outside(customer),
    );
    expect(mine).toMatchObject({ id: orderId, state: "paid" });
  });
});

describe("the per-address limit counts the mailbox", () => {
  it("folds plus tags on every domain, and Gmail's dots, for the key only", async () => {
    expect(mailboxKey("a+1@example.com")).toBe("a@example.com");
    expect(mailboxKey("first.last+x@googlemail.com")).toBe("firstlast@gmail.com");
    expect(mailboxKey("first.last@example.com")).toBe("first.last@example.com");
    const limit = memoryRateLimit(2);
    await checkCodeRequestLimit(limit, "a+1@example.com");
    await checkCodeRequestLimit(limit, "a+2@example.com");
    await expect(checkCodeRequestLimit(limit, "A+3@Example.com")).rejects.toMatchObject({
      code: "rate_limited",
    });
    // Another mailbox has its own allowance.
    await checkCodeRequestLimit(limit, "b+1@example.com");
    const gmail = memoryRateLimit(1);
    await checkCodeRequestLimit(gmail, "pat.lee@gmail.com");
    await expect(checkCodeRequestLimit(gmail, "patlee+t@googlemail.com")).rejects.toMatchObject({
      code: "rate_limited",
    });
  });
});

describe("what is on sale, worked out", () => {
  it("needs the return origins subscription.start needs", async () => {
    forgetPlanOnSale();
    expect(await hasPlanOnSale(db.query)).toBe(true);
    await run("order.settings.update", { returnOrigins: [] }, context(admin));
    expect(await hasPlanOnSale(db.query)).toBe(false);
    await run(
      "order.settings.update",
      { returnOrigins: ["https://shop.example.com"] },
      context(admin),
    );
    expect(await hasPlanOnSale(db.query)).toBe(true);
  });

  it("a code request may reuse the answer for a minute; the account-creation check never does", async () => {
    await update({ startingSubscription: true });
    forgetPlanOnSale();
    expect(await findPlanOnSale(db.query, undefined, { memo: true })).toMatchObject({
      state: "on_sale",
      plan: { object: PLAN, id: plan, title: "Every class" },
    });
    await invoke("record.delete", { object: PLAN, id: plan }, context(admin));
    expect((await findPlanOnSale(db.query, undefined, { memo: true })).state).toBe("on_sale");
    const email = address("memo");
    expect(await customerCodeReason(db.query, email, undefined, { memo: true })).toBe(
      "subscription",
    );
    // Better Auth's second check, when the account would be made: worked out again.
    expect(await customerMayGetCode(db.query, email)).toBe(false);
    await invoke("record.restore", { object: PLAN, id: plan }, context(admin));
    forgetPlanOnSale();
  });
});

describe("a plan going on sale while the switch is on", () => {
  const opened = async () => {
    const { results } = await env.DB.prepare(
      "SELECT body FROM core_notifications WHERE user_id = ? AND title = 'Customer sign-up is now open to anyone'",
    )
      .bind(admin.id)
      .all<{ body: string }>();
    return results;
  };

  it("is reported to admins once, with who changed the plan, and audited; turning it on is not", async () => {
    // Turned on while a plan is on sale: the admin did that themselves, nothing to report.
    await update({ startingSubscription: false });
    await update({ startingSubscription: true });
    expect(await watchSubscriberSignup(db)).toMatchObject({ opened: false });
    expect(await opened()).toHaveLength(0);
    // The plan leaves sale, then comes back (restored by a member of staff).
    await invoke("record.delete", { object: PLAN, id: plan }, context(admin));
    expect(await watchSubscriberSignup(db)).toMatchObject({ opened: false });
    await invoke("record.restore", { object: PLAN, id: plan }, context(admin));
    expect(await watchSubscriberSignup(db)).toMatchObject({ opened: true });
    expect(await watchSubscriberSignup(db)).toMatchObject({ opened: false });
    const notices = await opened();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.body).toContain("Every class went on sale (last changed by admin user)");
    expect(notices[0]?.body).toContain("including people already in your records");
    const audit = await env.DB.prepare(
      "SELECT actor, result FROM core_audit WHERE operation = 'customer.signupOpened'",
    ).all<{ actor: string; result: string }>();
    expect(audit.results).toHaveLength(1);
    expect(JSON.parse(audit.results[0]?.result ?? "{}")).toMatchObject({
      plan: { object: PLAN, id: plan },
      changedBy: { userId: admin.id, actor: "human" },
    });
  });

  it("is not looked at while the switch is off", async () => {
    await update({ startingSubscription: false });
    expect(await watchSubscriberSignup(db)).toEqual({ found: null, opened: false });
    await update({ startingSubscription: true });
  });
});

describe("when it cannot be answered", () => {
  it("gives no code and tells admins once that the switch is doing nothing", async () => {
    // Plans priced in another currency pass the SQL narrowing but none can be sold: more of them
    // than are looked at, and none on sale, is no answer.
    const OTHER = extId("aaa");
    await reconcile(
      manifest(OTHER, {
        objects: {
          plan: {
            label: "Plan",
            plural: "Plans",
            titleField: "name",
            fields: {
              name: { type: "text", label: "Name", required: true },
              price: { type: "currency", label: "Price", currency: "EUR" },
            },
            sellable: { price: "price", recurring: { interval: "month" } },
            public: { read: ["name", "price"] },
          },
        },
      }),
    );
    await invoke("record.delete", { object: PLAN, id: plan }, context(admin));
    for (let i = 0; i <= PLANS_LOOKED_AT; i += 1) {
      await create(`${OTHER}.plan`, { name: `Euro ${i}`, price: 10 });
    }
    forgetPlanOnSale();
    expect(await findPlanOnSale(db.query)).toMatchObject({ state: "unknown" });
    expect(await customerCodeReason(db.query, address("unknown"))).toBeNull();
    await watchSubscriberSignup(db);
    await watchSubscriberSignup(db);
    const { results } = await env.DB.prepare(
      "SELECT title FROM core_notifications WHERE user_id = ? AND title = 'Anyone starting a subscription is doing nothing'",
    )
      .bind(admin.id)
      .all();
    expect(results).toHaveLength(1);
  });
});
