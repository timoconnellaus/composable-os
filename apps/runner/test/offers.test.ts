// Stage 34, build step 5: the Offers pack (packs/offers) in the real host, beside the packs it
// takes money off (Ticketing, Bookings with Programs, Memberships), installed the way a product
// that lists them installs them, with real D1, the real payments gatekeeper and its fake provider's
// page. Step 4's `discount` behaviour does the work; the pack only declares discounts and codes.
//
// What is checked: a person makes a 20% code live and a guest's ticket order gets it, paid on the
// provider's page; a member's price applies to a signed-in member's drop-in and not to a guest
// using their address; a batch of single-use codes, kept as their hash, each work once, and are
// never in the audit log; a per-person code works once for a person across +tag addresses; an
// expired or ended discount gives the one answer an unknown code gets; the assistant's draft is
// not live, and its "make live" and its writes of codes wait for a person (its "make codes" is
// refused: codes are shown once, to a person); a discount for drop-ins does not apply to a ticket.
import { env, exports } from "cloudflare:workers";
import {
  type ActingUser,
  type CustomerPrincipal,
  type ExtensionHost,
  type InvocationContext,
  invokeByName,
  type OutsideInvocationContext,
  refreshSchemaRegistry,
} from "@composable-os/core";
import { codeHash } from "@composable-os/sdk";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { integrationRuntime } from "../src/integrations/runtime.ts";
import { setPreset } from "./automation-fixture.ts";
import { createAdmin, db, host, refusal, run, unique } from "./helpers.ts";
import { packFiles } from "./pack-files.ts";

const PACKS: Record<string, Record<string, string>> = {
  programs: packFiles("programs"),
  bookings: packFiles("bookings"),
  memberships: packFiles("memberships"),
  ticketing: packFiles("ticketing"),
  offers: packFiles("offers"),
};

/** The extension host of a gym's deployment whose product lists these packs and Offers. */
const shippedHost: ExtensionHost = {
  ...host,
  shipped: async () => [
    ...(await host.shipped()).filter((s) => !(s.id in PACKS)),
    ...Object.keys(PACKS).map((id) => ({ id, version: "0.1.0" })),
  ],
  commitShipped: (id) =>
    PACKS[id]
      ? host.commit({
          id,
          files: PACKS[id],
          message: `Shipped ${id} 0.1.0`,
          author: { name: "Composable OS", email: "release@composableos.dev" },
        })
      : host.commitShipped(id),
};

const integrations = integrationRuntime(env);
const runner = exports.default as unknown as {
  gatekeeperFetch(vendor: string, request: Request): Promise<Response>;
};
const RETURN = "https://gym.test/thanks";
const HOUR = 3_600_000;
const DISCOUNT = "offers.discount";
const CODE = "offers.code";
const EVENT = "ticketing.event";
const TICKET_TYPE = "ticketing.tickettype";
const CLASS = "bookings.class";
const PLAN = "memberships.plan";
const NOT_VALID = "This code is not valid here";

let admin: ActingUser;
const staff = (extra: Partial<InvocationContext> = {}): InvocationContext => ({
  actor: "human",
  user: admin,
  origin: { surface: "ui" },
  db,
  integrations,
  extensionHost: shippedHost,
  ...extra,
});
const assistant = () => staff({ actor: "assistant", origin: { surface: "assistant" } });
const guest: OutsideInvocationContext = {
  principal: { kind: "public" },
  db,
  integrations,
  extensionHost: shippedHost,
};
const as = (principal: CustomerPrincipal): OutsideInvocationContext => ({
  principal,
  db,
  integrations,
  extensionHost: shippedHost,
});
const create = async (object: string, values: Record<string, unknown>) =>
  (await run<{ id: string }>("record.create", { object, values }, staff())).id;
const stateOf = async (id: string) =>
  (await run<{ values: { state: string } }>("record.get", { object: DISCOUNT, id }, staff())).values
    .state;

/** A signed-in customer with exactly this address (a +tag kept, as they typed it). */
async function customerAt(email: string): Promise<CustomerPrincipal> {
  const person = (await invokeByName(
    "person.create",
    { givenName: "Given", emails: [{ email }] },
    staff(),
  )) as { id: string };
  const customerId = `cus_${unique("off").toLowerCase()}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_customer (id, person_id, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
  )
    .bind(customerId, person.id, email, now, now)
    .run();
  return { kind: "customer", customerId, personId: person.id };
}

/** A draft discount made through the pack, then made live by a person through the pack. */
async function liveDiscount(values: Record<string, unknown>): Promise<string> {
  const draft = await run<{ id: string; state: string }>(
    "x.offers.draftDiscount",
    { name: unique("Deal"), ...values },
    staff(),
  );
  expect(draft.state).toBe("draft");
  const live = await run<{ state: string }>(
    "x.offers.activateDiscount",
    { discountId: draft.id },
    staff(),
  );
  expect(live.state).toBe("active");
  return draft.id;
}

const word = (prefix: string) =>
  unique(prefix)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
const email = () => `${unique("guest")}@buyers.test`.toLowerCase();

interface Order {
  id: string;
  state: string;
  total: number;
  discount: number;
  token: string | null;
  deal: { kind: string; title: string; amount: number } | null;
}

let ticketType: string;
let yoga: string;
let spin: string;

/** A guest's (or a customer's) order of one $45.00 ticket, with a code. */
function buyTicket(code: string | undefined, ctx: OutsideInvocationContext = guest) {
  return run<Order>(
    "order.start",
    {
      lines: [{ object: TICKET_TYPE, id: ticketType }],
      ...(ctx.principal.kind === "public" ? { email: email() } : {}),
      ...(code ? { code } : {}),
    },
    ctx,
  );
}

/** The fake provider's page: pay `order`, then wait for the verified payment. */
async function pay(order: { id: string; token: string | null }, ctx: OutsideInvocationContext) {
  const checkout = await run<{ url: string; amount: number }>(
    "order.checkout",
    { id: order.id, ...(order.token ? { token: order.token } : {}), returnUrl: RETURN },
    ctx,
  );
  const paid = await runner.gatekeeperFetch(
    "payments",
    new Request(checkout.url, {
      method: "POST",
      body: new URLSearchParams({ outcome: "pay" }),
      redirect: "manual",
    }),
  );
  expect(paid.status).toBe(303);
  await vi.waitFor(
    async () =>
      expect((await run<{ state: string }>("order.get", { id: order.id }, staff())).state).toBe(
        "paid",
      ),
    { timeout: 20_000 },
  );
  return checkout;
}

/** A class of `classType` in three hours. */
async function klass(classType: string): Promise<string> {
  const startsAt = new Date(Date.now() + 3 * HOUR).toISOString();
  return create(CLASS, {
    classType,
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + HOUR).toISOString(),
    timezone: "UTC",
    places: 20,
  });
}

type Bought = { result: string; orderId: string; total: number; token: string | null };
const dropIn = (classId: string, ctx: OutsideInvocationContext, extra = {}) =>
  run<Bought>("x.bookings.buy", { classId, ...extra }, ctx);

beforeAll(async () => {
  admin = await createAdmin();
  await setPreset("balanced");
  await refreshSchemaRegistry(db.query);
  for (const id of ["programs", "bookings", "memberships", "ticketing", "offers"]) {
    await run("extension.install", { id, shipped: true }, staff());
  }
  await refreshSchemaRegistry(db.query);
  await run(
    "order.settings.update",
    { currency: "AUD", returnOrigins: ["https://gym.test"] },
    staff(),
  );
  await run("integration.setVendor", { vendor: "payments", enabled: true }, staff());
  const payments = await run<{ connection: { id: string } }>(
    "connection.create",
    { vendor: "payments", scope: "org" },
    staff(),
  );
  await run(
    "connection.bindResource",
    { id: payments.connection.id, url: "payments://merchant/fake" },
    staff(),
  );
  const event = await create(EVENT, { name: unique("Open day"), places: 500 });
  await run("record.update", { object: EVENT, id: event, values: { status: "on_sale" } }, staff());
  ticketType = await create(TICKET_TYPE, { event, name: unique("Entry"), price: 45 });
  yoga = await create("programs.classtype", { name: unique("Yoga"), "bookings.dropInPrice": 25 });
  spin = await create("programs.classtype", { name: unique("Spin") });
}, 180_000);

describe("a promo code (criterion 1, through the pack)", () => {
  it("a person makes a 20% code live, and a guest's ticket order gets it", async () => {
    const code = word("SPRING");
    const id = await liveDiscount({ kind: "percent", percent: 20, code: code.toLowerCase() });
    // The host keeps the word folded.
    expect(
      (await run<{ values: { code: string } }>("record.get", { object: DISCOUNT, id }, staff()))
        .values.code,
    ).toBe(code);
    const order = await buyTicket(code.toLowerCase());
    expect(order).toMatchObject({ total: 3_600, discount: 900 });
    expect(order.deal).toMatchObject({ kind: "code", amount: 900 });
    const checkout = await pay(order, guest);
    expect(checkout.amount).toBe(3_600);
    const use = await env.DB.prepare(
      "SELECT state, amount FROM core_discount_use WHERE order_id = ? AND discount_id = ?",
    )
      .bind(order.id, id)
      .first();
    expect(use).toEqual({ state: "used", amount: 900 });
    // The pack's list reads the host's record of it.
    const listed = await run<{ discounts: { id: string; used: number; given: number }[] }>(
      "x.offers.discounts",
      { state: "active" },
      staff(),
    );
    expect(listed.discounts.find((d) => d.id === id)).toMatchObject({ used: 1, given: 900 });
  });

  it("a code shorter than six characters is the host's refusal, in plain words", async () => {
    const short = await refusal(
      run(
        "x.offers.draftDiscount",
        { name: "Short", kind: "percent", percent: 5, code: "ab1" },
        staff(),
      ),
    );
    expect(short.message).toMatch(/6 to 64 letters or digits/);
  });
});

describe("a member's price (criterion 7, through the pack)", () => {
  it("applies to a signed-in member's drop-in, and not to a guest using their address", async () => {
    // A plan for spin classes: its member pays for a yoga class as a drop-in.
    const plan = await create(PLAN, {
      title: unique("Spin plan "),
      price: 40,
      uses: 3,
      per: "week",
      classTypes: [spin],
      status: "on_sale",
    });
    const address = `${unique("member")}@members.test`.toLowerCase();
    const member = await customerAt(address);
    const started = await run<{ url: string }>(
      "subscription.start",
      { plan: { object: PLAN, id: plan }, returnUrl: RETURN },
      as(member),
    );
    const paid = await runner.gatekeeperFetch(
      "payments",
      new Request(started.url, {
        method: "POST",
        body: new URLSearchParams({ outcome: "pay" }),
        redirect: "manual",
      }),
    );
    expect(paid.status).toBe(303);
    await vi.waitFor(
      async () => {
        const row = await env.DB.prepare(
          "SELECT state FROM core_subscription WHERE holder_person_id = ?",
        )
          .bind(member.personId)
          .first<{ state: string }>();
        expect(["trialing", "active"]).toContain(row?.state);
      },
      { timeout: 20_000 },
    );
    await liveDiscount({
      kind: "price",
      amount: 15,
      automatic: true,
      who: "members",
      appliesTo: ["bookings.booking"],
    });
    const mine = await dropIn(await klass(yoga), as(member));
    expect(mine).toMatchObject({ result: "pending", total: 1_500 });
    const theirs = await dropIn(await klass(yoga), guest, { email: address });
    expect(theirs).toMatchObject({ result: "pending", total: 2_500 });
  });
});

describe("single-use codes (kept as their hash)", () => {
  it("a person makes a batch; each code works once; no code is in a record or the audit log", async () => {
    const id = await liveDiscount({ kind: "amount", amount: 10 });
    const batch = await run<{ made: number; complete: boolean; codes: string[] }>(
      "x.offers.generateCodes",
      { discountId: id, count: 3, batch: "Newsletter" },
      staff(),
    );
    expect(batch).toMatchObject({ made: 3, complete: true });
    const [first, second] = batch.codes as [string, string];
    const once = await buyTicket(first.toLowerCase());
    expect(once).toMatchObject({ total: 3_500, discount: 1_000 });
    await pay(once, guest);
    expect((await refusal(buyTicket(first))).message).toBe(NOT_VALID);
    expect(await buyTicket(second)).toMatchObject({ total: 3_500 });
    // Kept as their hash only: in the records, the audit log and the record history.
    const stored = JSON.stringify(
      (
        await run<{ items: unknown[] }>(
          "record.list",
          { object: CODE, filter: { field: "discount", op: "eq", value: id } },
          staff(),
        )
      ).items,
    );
    expect(stored).toContain(await codeHash(first));
    const audit = await env.DB.prepare("SELECT * FROM core_audit").all();
    const changes = await env.DB.prepare("SELECT * FROM core_audit_changes").all();
    for (const code of batch.codes) {
      expect(stored).not.toContain(code);
      expect(JSON.stringify(audit.results)).not.toContain(code);
      expect(JSON.stringify(changes.results)).not.toContain(code);
    }
    // The batch, as the pack reports it: never a code.
    const batches = await run<{ batches: { batch: string; made: number; used: number }[] }>(
      "x.offers.codeBatches",
      { discountId: id },
      staff(),
    );
    expect(batches.batches).toEqual([
      expect.objectContaining({ batch: "Newsletter", made: 3, used: 1, working: 3 }),
    ]);
    // A leaked code is voided by a person typing it.
    expect(await run("x.offers.voidCodes", { discountId: id, codes: [second] }, staff())).toEqual({
      voided: 1,
      remaining: 0,
    });
    expect((await refusal(buyTicket(second))).message).toBe(NOT_VALID);
  });
});

describe("one per person, across addresses (criterion 6, through the pack)", () => {
  it("a per-person code works once for a person, a +tag address counting as the same", async () => {
    const code = word("FRIEND");
    await liveDiscount({ kind: "percent", percent: 10, code, perPerson: 1 });
    const local = unique("pat").toLowerCase();
    const one = await customerAt(`${local}+one@people.test`);
    const two = await customerAt(`${local}+two@people.test`);
    const first = await buyTicket(code, as(one));
    expect(first.discount).toBe(450);
    expect((await refusal(buyTicket(code, as(one)))).message).toBe(NOT_VALID);
    expect((await refusal(buyTicket(code, as(two)))).message).toBe(NOT_VALID);
    // A guest never gets a per-person deal.
    expect((await refusal(buyTicket(code))).message).toBe(NOT_VALID);
  });
});

describe("the one answer", () => {
  it("an expired, an ended and an unknown code are refused alike", async () => {
    const expired = word("OLDSALE");
    await liveDiscount({
      kind: "percent",
      percent: 10,
      code: expired,
      from: "2024-01-01",
      until: "2024-01-31",
    });
    const ended = word("ENDSALE");
    const id = await liveDiscount({ kind: "percent", percent: 10, code: ended });
    expect(await buyTicket(ended)).toMatchObject({ discount: 450 });
    expect(
      (await run<{ state: string }>("x.offers.endDiscount", { discountId: id }, staff())).state,
    ).toBe("ended");
    const answers = await Promise.all(
      [expired, ended, word("NOSUCHCODE")].map(async (code) => refusal(buyTicket(code))),
    );
    for (const answer of answers) {
      expect(answer).toMatchObject({
        code: "invalid_input",
        message: NOT_VALID,
        details: { rule: "code_not_valid", field: "code" },
      });
    }
    // An ended discount is not made live again.
    expect(
      (await refusal(run("x.offers.activateDiscount", { discountId: id }, staff()))).code,
    ).toBeTruthy();
    expect(await stateOf(id)).toBe("ended");
  });
});

describe("the assistant drafts; a person decides (criterion 20)", () => {
  it("its draft is not live, and its make live and its codes wait for a person", async () => {
    const code = word("AIDRAFT");
    const draft = await run<{ id: string; state: string }>(
      "x.offers.draftDiscount",
      { name: "The assistant's idea", kind: "percent", percent: 30, code },
      assistant(),
    );
    expect(draft.state).toBe("draft");
    expect((await refusal(buyTicket(code))).message).toBe(NOT_VALID);

    const asked = await refusal(
      run("x.offers.activateDiscount", { discountId: draft.id }, assistant()),
    );
    expect(asked.code).toBe("pending_approval");
    expect(await stateOf(draft.id)).toBe("draft");
    expect((await refusal(buyTicket(code))).message).toBe(NOT_VALID);

    // Making codes is a person's at the screen: the assistant cannot ask for them...
    const codes = await refusal(
      run("x.offers.generateCodes", { discountId: draft.id, count: 5 }, assistant()),
    );
    expect(codes.code).toBe("forbidden");
    // ...nor write one: a code's terms are the pack's tools' only...
    const written = await refusal(
      run(
        "record.createMany",
        {
          object: CODE,
          records: [{ discount: draft.id, word: await codeHash(word("SNEAKY")), uses: 1 }],
        },
        assistant(),
      ),
    );
    expect(written.code).toBe("invalid_input");
    // ...and its switching a void code back on waits for a person (the host's, ADR 0693).
    const made = await run<{ codes: string[] }>(
      "x.offers.generateCodes",
      { discountId: draft.id, count: 1 },
      staff(),
    );
    const voidCode = made.codes[0] as string;
    await run("x.offers.voidCodes", { discountId: draft.id, codes: [voidCode] }, staff());
    const [codeRecord] = (
      await run<{ items: { id: string }[] }>(
        "record.list",
        { object: CODE, filter: { field: "discount", op: "eq", value: draft.id } },
        staff(),
      )
    ).items;
    const back = await refusal(
      run(
        "record.update",
        { object: CODE, id: codeRecord?.id, values: { active: true } },
        assistant(),
      ),
    );
    expect(back.code).toBe("pending_approval");
    const voided = await run(
      "x.offers.voidBatch",
      { discountId: draft.id, batch: "x" },
      assistant(),
    ).catch((e: { code?: string }) => e.code);
    expect(voided).toBe("pending_approval");
    // Codes typed to void are a person's at the screen (review of PR #479, item 4): the
    // assistant's request is refused, so no code waits in clear in a pending action.
    const typed = await refusal(
      run("x.offers.voidCodes", { discountId: draft.id, codes: [voidCode] }, assistant()),
    );
    expect(typed.code).toBe("forbidden");
    const pending = await env.DB.prepare("SELECT input, simulated FROM core_pending_action").all();
    expect(JSON.stringify(pending.results)).not.toContain(voidCode);

    // A person approves the assistant's request: it is live, and the code works.
    const approve = (confirm?: string) =>
      run<{ results: { status: string }[] }>(
        "approval.approve",
        { actionIds: [String(asked.details?.actionId)], ...(confirm ? { confirm } : {}) },
        staff(),
      );
    const decided = await approve().catch(
      async (error: { details?: { confirmLabel?: string } }) => {
        const label = error.details?.confirmLabel;
        if (!label) throw error;
        return approve(label);
      },
    );
    expect(decided.results.map((r) => r.status)).toEqual(["applied"]);
    expect(await stateOf(draft.id)).toBe("active");
    expect(await buyTicket(code)).toMatchObject({ discount: 1_350 });

    // Its change to the live discount's terms waits too, through the pack or not.
    expect(
      (
        await refusal(
          run("x.offers.changeDiscount", { discountId: draft.id, percent: 90 }, assistant()),
        )
      ).code,
    ).toBe("pending_approval");
    expect(
      (
        await refusal(
          run(
            "record.update",
            { object: DISCOUNT, id: draft.id, values: { percent: 90 } },
            assistant(),
          ),
        )
      ).code,
    ).toBe("pending_approval");
    expect(await buyTicket(code)).toMatchObject({ discount: 1_350 });
  });
});

describe("what a discount covers", () => {
  it("one for drop-ins does not apply to a ticket", async () => {
    const code = word("CLASSONLY");
    await liveDiscount({ kind: "percent", percent: 50, code, appliesTo: ["bookings.booking"] });
    expect((await refusal(buyTicket(code))).message).toBe(NOT_VALID);
    const answer = await run<{ valid: boolean; message: string | null }>(
      "discount.check",
      { code, lines: [{ object: TICKET_TYPE, id: ticketType }] },
      guest,
    );
    expect(answer).toMatchObject({ valid: false, message: NOT_VALID });
  });
});

// --- The review of PR #479 ----------------------------------------------------------------------

/** A person approves `actionId`, answering the confirmation it may ask for. */
async function approveAs(actionId: string) {
  const approve = (confirm?: string) =>
    run<{ results: { status: string }[] }>(
      "approval.approve",
      { actionIds: [actionId], ...(confirm ? { confirm } : {}) },
      staff(),
    );
  return approve().catch(async (error: { details?: { confirmLabel?: string } }) => {
    const label = error.details?.confirmLabel;
    if (!label) throw error;
    return approve(label);
  });
}

describe("a person approves the terms they were shown (review item 1)", () => {
  it("approving the assistant's make live is refused once it changed the terms after asking", async () => {
    const code = word("BAITSWITCH");
    const draft = await run<{ id: string }>(
      "x.offers.draftDiscount",
      { name: "Ten off", kind: "percent", percent: 10, code },
      assistant(),
    );
    const asked = await refusal(
      run("x.offers.activateDiscount", { discountId: draft.id }, assistant()),
    );
    expect(asked.code).toBe("pending_approval");
    const actionId = String(asked.details?.actionId);
    // The approval says the terms in words.
    const row = await env.DB.prepare("SELECT simulated FROM core_pending_action WHERE id = ?")
      .bind(actionId)
      .first<{ simulated: string }>();
    const notes = (JSON.parse(row?.simulated ?? "{}") as { notes?: string[] }).notes ?? [];
    expect(notes.join(" ")).toContain('It names the discount "Ten off" as it is now');
    expect(notes.join(" ")).toContain("Percentage off: 10");
    // A draft is anyone's to edit: the assistant raises it to 90% after asking.
    await run(
      "record.update",
      { object: DISCOUNT, id: draft.id, values: { percent: 90 } },
      assistant(),
    );
    const refused = await refusal(approveAs(actionId));
    expect(refused).toMatchObject({ code: "conflict", details: { rule: "discount_changed" } });
    expect(refused.message).toContain("Percentage off 10 → 90");
    expect(await stateOf(draft.id)).toBe("draft");
    expect((await refusal(buyTicket(code))).message).toBe(NOT_VALID);
  });

  it("approving it with the terms unchanged makes those terms live", async () => {
    const code = word("STEADY");
    const draft = await run<{ id: string }>(
      "x.offers.draftDiscount",
      { name: "Twenty off", kind: "percent", percent: 20, code },
      assistant(),
    );
    const asked = await refusal(
      run("x.offers.activateDiscount", { discountId: draft.id }, assistant()),
    );
    expect((await approveAs(String(asked.details?.actionId))).results[0]?.status).toBe("applied");
    expect(await buyTicket(code)).toMatchObject({ discount: 900 });
  });
});

describe("a discount past its draft is changed only by a person (review item 2)", () => {
  it("the assistant's change to a paused or an ended discount waits for a person", async () => {
    const code = word("PAUSEDTEN");
    const id = await liveDiscount({ kind: "percent", percent: 10, code });
    await run("x.offers.pauseDiscount", { discountId: id }, staff());
    const asked = await refusal(
      run("record.update", { object: DISCOUNT, id, values: { percent: 90 } }, assistant()),
    );
    expect(asked.code).toBe("pending_approval");
    // A person resumes it: the terms are the ones a person approved.
    await run("x.offers.activateDiscount", { discountId: id }, staff());
    expect(await buyTicket(code)).toMatchObject({ discount: 450 });
    await run("x.offers.endDiscount", { discountId: id }, staff());
    const ended = await refusal(
      run("record.update", { object: DISCOUNT, id, values: { until: "2099-01-01" } }, assistant()),
    );
    expect(ended.code).toBe("pending_approval");
    // A draft stays anyone's to edit.
    const draft = await run<{ id: string }>(
      "x.offers.draftDiscount",
      { name: "Idea", kind: "percent", percent: 5 },
      assistant(),
    );
    await run(
      "record.update",
      { object: DISCOUNT, id: draft.id, values: { percent: 6 } },
      assistant(),
    );
  });
});

describe("a person's tools under every approval policy (review item 3)", () => {
  for (const preset of ["cautious", "balanced", "autonomous"] as const) {
    it(`a person makes codes and makes a discount live (${preset})`, async () => {
      await setPreset(preset);
      try {
        const before = await env.DB.prepare(
          "SELECT count(*) AS n FROM core_pending_action WHERE status = 'pending'",
        ).first<{ n: number }>();
        const id = await liveDiscount({ kind: "amount", amount: 5 });
        const batch = await run<{ made: number; complete: boolean; codes: string[] }>(
          "x.offers.generateCodes",
          { discountId: id, count: 60 },
          staff(),
        );
        expect(batch).toMatchObject({ made: 60, complete: true });
        expect(await buyTicket(batch.codes[59] as string)).toMatchObject({ discount: 500 });
        const after = await env.DB.prepare(
          "SELECT count(*) AS n FROM core_pending_action WHERE status = 'pending'",
        ).first<{ n: number }>();
        // Nothing of a person's own tools was left waiting.
        expect(after?.n).toBe(before?.n);
      } finally {
        await setPreset("balanced");
      }
    });
  }

  it("an assistant's call of a person's tool still waits under autonomous", async () => {
    await setPreset("autonomous");
    try {
      const draft = await run<{ id: string }>(
        "x.offers.draftDiscount",
        { name: "Autonomous idea", kind: "percent", percent: 5 },
        assistant(),
      );
      expect(
        (await refusal(run("x.offers.activateDiscount", { discountId: draft.id }, assistant())))
          .code,
      ).toBe("pending_approval");
      expect(await stateOf(draft.id)).toBe("draft");
    } finally {
      await setPreset("balanced");
    }
  });
});

// Batch 20261126 (PR #491 beside #479): every discount state but `ended` is guarded (each move out
// is a person's tool), so a draft, live or paused discount is Trashed only by a person who may use
// those tools (`offers:manage`), never by the assistant, whatever the preset (ADR 0863). Codes
// have no states and keep their own Trash rules; an ended discount is final, so not held here.
describe("the Trash of a discount (ADR 0863)", () => {
  it("the assistant never Trashes a live discount; a person who manages offers does", async () => {
    const id = await liveDiscount({ kind: "percent", percent: 10 });
    await setPreset("autonomous");
    try {
      const refused = await refusal(run("record.delete", { object: DISCOUNT, id }, assistant()));
      expect(refused.code).toBe("forbidden");
      expect((refused.details as { rule?: string } | undefined)?.rule).toBe("state_trash");
      expect(refused.message).toContain("pauseDiscount or endDiscount");
      expect(await stateOf(id)).toBe("active");
    } finally {
      await setPreset("balanced");
    }
    await run("record.delete", { object: DISCOUNT, id }, staff());
    expect((await refusal(run("record.get", { object: DISCOUNT, id }, staff()))).code).toBe(
      "not_found",
    );
  });
});

// --- The second review of PR #479 ---------------------------------------------------------------

describe("approving two requests together (second review, S2)", () => {
  it("the assistant's change to 90% and its make live, approved at once: the make live is refused", async () => {
    await setPreset("cautious");
    try {
      const code = word("TOGETHER");
      const draft = await run<{ id: string }>(
        "x.offers.draftDiscount",
        { name: "Together", kind: "percent", percent: 10, code },
        staff(),
      );
      const update = await refusal(
        run(
          "record.update",
          { object: DISCOUNT, id: draft.id, values: { percent: 90 } },
          assistant(),
        ),
      );
      expect(update.code).toBe("pending_approval");
      const activate = await refusal(
        run("x.offers.activateDiscount", { discountId: draft.id }, assistant()),
      );
      expect(activate.code).toBe("pending_approval");
      const updateId = String(update.details?.actionId);
      const activateId = String(activate.details?.actionId);
      // Its words say another request names the same discount.
      const row = await env.DB.prepare("SELECT simulated FROM core_pending_action WHERE id = ?")
        .bind(activateId)
        .first<{ simulated: string }>();
      expect(row?.simulated).toContain(updateId);
      const approve = (confirm?: string) =>
        run<{ results: { actionId: string; status: string; error: unknown }[] }>(
          "approval.approve",
          { actionIds: [updateId, activateId], ...(confirm ? { confirm } : {}) },
          staff(),
        );
      const decided = await approve().catch(
        async (error: { details?: { confirmLabel?: string } }) => {
          const label = error.details?.confirmLabel;
          if (!label) throw error;
          return approve(label);
        },
      );
      const byId = new Map(decided.results.map((r) => [r.actionId, r]));
      expect(byId.get(updateId)?.status).toBe("applied");
      expect(byId.get(activateId)?.status).toBe("failed");
      expect(JSON.stringify(byId.get(activateId)?.error)).toContain("discount_changed");
      expect(await stateOf(draft.id)).toBe("draft");
      expect((await refusal(buyTicket(code))).message).toBe(NOT_VALID);
    } finally {
      await setPreset("balanced");
    }
  });
});

describe("what does not depend on the terms is always approvable (second review, M2)", () => {
  it("ending a discount whose terms a person changed after the assistant asked", async () => {
    const code = word("LEAKED");
    const id = await liveDiscount({ kind: "percent", percent: 10, code });
    const asked = await refusal(run("x.offers.endDiscount", { discountId: id }, assistant()));
    expect(asked.code).toBe("pending_approval");
    await run("record.update", { object: DISCOUNT, id, values: { percent: 20 } }, staff());
    expect((await approveAs(String(asked.details?.actionId))).results[0]?.status).toBe("applied");
    expect(await stateOf(id)).toBe("ended");
  });
});
