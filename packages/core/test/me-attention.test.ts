// Stage 48 step 4 (ADR 0711): Needs your attention, against the real host. A member with a child
// staff linked to them has one of each of the eight kinds: a document due for them and for the
// child, a failing membership, a payment waiting for them to confirm, a deposit's balance, an
// unpaid held drop-in, a pass expiring in 3 days with uses left, a pass of the child's with none
// left and a trial ending in 5 days. A pass expiring in 10 days, a cancelled membership ending, a
// weekly membership's limit used up and a child's pass on an object that does not open to
// guardians are not listed. Each item goes once its cause is fixed; with the setting at 14 the
// 10-day pass is listed; another member's items never appear. The orders are made by the real
// order operations and a verified payment; the subscriptions are rows as the provider's verified
// events leave them (as agreement-erase.test.ts does).
//
// It also counts what one call runs on D1 (the local runtime enforces neither 1,000 statements
// per invocation nor 100 bound variables per statement): a fixed number, the same after another
// pack with holders and an agreement point is installed.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import type { ExtensionManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import type { ActingUser, AttentionItem, CustomerPrincipal } from "../src/index.ts";
import { publishAgreement } from "./agreement-fixtures.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, unique } from "./helpers.ts";
import { type Buyer, CURRENCY, createBuyer, outside, run } from "./order-fixtures.ts";

const ext = extId("att");
const KLASS = `${ext}.klass`;
const CAMP = `${ext}.camp`;
const PASS = `${ext}.pass`;
const TOKEN = `${ext}.token`;
const HIDDEN = `${ext}.hidden`;
const MEMBERSHIP = `${ext}.membership`;
const ENTRY = `${ext}.entry`;
const SESSION = `${ext}.session`;
const POINT = `att${Date.now().toString(36)}`;
const DAY = 86_400_000;

const HOLDER_STATES = [
  { value: "active", label: "Active" },
  { value: "void", label: "Void" },
];
const holderStates: NonNullable<ExtensionManifest["objects"][string]["states"]> = {
  field: "state",
  initial: "active",
  moves: [{ from: "active", to: "void", by: ["staff", "host"], final: true }],
};

/** A holder of N uses in all (a pass); `guardians` opens a child's to their parent. */
function passObject(label: string, guardians: boolean): ExtensionManifest["objects"][string] {
  return {
    label,
    plural: `${label}es`,
    titleField: "name",
    fields: {
      name: { type: "text", label: "Name", required: true },
      person: { type: "relation", label: "Person", to: "person" },
      uses: { type: "number", label: "Uses" },
      until: { type: "datetime", label: "Until" },
      state: { type: "select", label: "State", options: HOLDER_STATES },
    },
    states: holderStates,
    customer: {
      field: "person",
      ...(guardians ? { guardians: {} } : {}),
      read: ["name", "uses", "until", "state"],
      write: [],
    },
    allowance: {
      holds: {
        person: "person",
        uses: "uses",
        per: "total",
        until: "until",
        live: ["active"],
        spendsOn: [{ object: "entry" }],
      },
    },
  };
}

/** A spender kept once made: an entry at the door (as allowance.test.ts). */
function spenderObject(label: string): ExtensionManifest["objects"][string] {
  return {
    label,
    plural: `${label}s`,
    titleField: "name",
    fields: {
      name: { type: "text", label: "Name", required: true },
      person: { type: "relation", label: "Person", to: "person" },
      holder: { type: "text", label: "Paid by" },
      state: {
        type: "select",
        label: "State",
        options: [
          { value: "open", label: "Open" },
          { value: "in", label: "In" },
        ],
      },
    },
    states: { field: "state", initial: "open", moves: [{ from: "open", to: "in", by: ["staff"] }] },
    allowance: { spends: { person: "person", holder: "holder", spendIn: ["in"], returnIn: [] } },
  };
}

function fixture(id: string, point: string): ExtensionManifest {
  return manifest(id, {
    objects: {
      // A drop-in class: its places are held while its order is unpaid.
      klass: {
        label: "Class",
        plural: "Classes",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          price: { type: "currency", label: "Price", currency: CURRENCY },
          places: { type: "number", label: "Places" },
        },
        capacity: { places: "places" },
        sellable: { price: "price" },
        public: { read: ["name", "price"] },
      },
      // A camp paid by deposit, the balance by a date.
      camp: {
        label: "Camp",
        plural: "Camps",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          price: { type: "currency", label: "Price", currency: CURRENCY },
          depositAmount: { type: "currency", label: "Deposit", currency: CURRENCY },
          balanceDue: { type: "date", label: "Balance due" },
        },
        sellable: {
          price: "price",
          deposit: { amount: "depositAmount", balanceDue: "balanceDue" },
        },
        public: { read: ["name", "price", "depositAmount", "balanceDue"] },
      },
      pass: passObject("Pass", true),
      // The same kind of holder, which does not open to guardians: a child's is never the parent's.
      token: passObject("Token", false),
      // A weekly limit: used up, it renews by itself and is no "pass with no classes left".
      membership: {
        label: "Membership",
        plural: "Memberships",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          person: { type: "relation", label: "Person", to: "person" },
          uses: { type: "number", label: "Uses a week" },
          state: { type: "select", label: "State", options: HOLDER_STATES },
        },
        states: holderStates,
        customer: { field: "person", guardians: {}, read: ["name", "uses", "state"], write: [] },
        allowance: {
          holds: {
            person: "person",
            uses: "uses",
            per: "week",
            live: ["active"],
            spendsOn: [{ object: "session" }],
          },
        },
      },
      // A pass whose uses and end its customer may not read (the review of PR #359): an item
      // would tell them what their own record hides, so none is listed.
      hidden: {
        ...passObject("Hidden", true),
        customer: { field: "person", guardians: {}, read: ["name", "state"], write: [] },
      },
      entry: spenderObject("Entry"),
      session: spenderObject("Session"),
      // Only to declare the agreement point the documents are attached to.
      waivered: {
        label: "Waivered",
        plural: "Waivereds",
        titleField: "name",
        fields: { name: { type: "text", label: "Name", required: true } },
        agreements: { point, label: "Taking part" },
      },
    },
  });
}

let admin: ActingUser;
let member: Buyer;
let other: Buyer;
let childId: string;
let otherChildId: string;
const ids: Record<string, string> = {};

const iso = (offset: number) => new Date(Date.now() + offset).toISOString();
const as = (buyer: Buyer | CustomerPrincipal) =>
  outside("principal" in buyer ? buyer.principal : buyer);
const attention = (buyer: Buyer, db?: ReturnType<typeof createCrmDb>) =>
  run<{ days: number; items: AttentionItem[] }>(
    "me.attention",
    {},
    db ? outside(buyer.principal, { db }) : as(buyer),
  );
const create = async (object: string, values: Record<string, unknown>) =>
  (await run<{ id: string }>("record.create", { object, values }, context(admin))).id;
const pay = (orderId: string | undefined, amount: number) =>
  run(
    "fixture.verifiedPayment",
    { orderId, amount, eventId: unique("evt") },
    context(admin, { actor: "automation" }),
  );

async function child(guardian: Buyer, label: string): Promise<string> {
  const person = await run<{ id: string }>(
    "person.create",
    { givenName: `Child-${label}` },
    context(admin),
  );
  await run(
    "person.link.add",
    { guardianId: guardian.principal.personId, dependantId: person.id },
    context(admin),
  );
  return person.id;
}

/** A subscription as the provider's verified events leave it. */
async function subscription(
  payer: Buyer,
  title: string,
  state: string,
  extra: Record<string, string | number | null> = {},
): Promise<string> {
  const id = `sbs_${unique("att")}`;
  const now = new Date().toISOString();
  const columns = {
    id,
    payer_person_id: payer.principal.personId,
    holder_person_id: payer.principal.personId,
    email: payer.email,
    placed_as: "customer",
    plan_object: MEMBERSHIP,
    plan_id: "plan",
    plan_title: title,
    amount: 4900,
    currency: CURRENCY,
    interval: "month",
    state,
    provider: "fake",
    provider_ref: `fsub_${id}`,
    cancel_at_period_end: 0,
    current_period_end: iso(20 * DAY),
    observed_at: now,
    created_at: now,
    updated_at: now,
    version: 0,
    ...extra,
  };
  const names = Object.keys(columns);
  await env.DB.prepare(
    `INSERT INTO core_subscription (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
  )
    .bind(...Object.values(columns))
    .run();
  return id;
}

/** Moves a subscription as a later verified event would. */
async function moveSubscription(
  id: string | undefined,
  set: Record<string, string | number | null>,
) {
  const names = Object.keys(set);
  await env.DB.prepare(
    `UPDATE core_subscription SET ${names.map((n) => `${n} = ?`).join(", ")}, version = version + 1 WHERE id = ?`,
  )
    .bind(...Object.values(set), id)
    .run();
}

async function liveDocument(title: string): Promise<string> {
  const call = (name: string, input: unknown) => run(name, input, context(admin));
  return (await publishAgreement(call, "waiver", { title, text: "Fixture text.", points: [POINT] }))
    .id;
}

/** Everything one person of the member's family has, the orders and passes made for real. */
async function giveEverything(buyer: Buyer, kid: string, tag: string) {
  const out: Record<string, string> = {};
  out.failing = await subscription(buyer, `Failing-${tag}`, "past_due", {
    failing_since: iso(-2 * DAY),
  });
  out.confirm = await subscription(buyer, `Confirm-${tag}`, "incomplete");
  out.trial = await subscription(buyer, `Trial-${tag}`, "trialing", { trial_end: iso(5 * DAY) });
  // Cancelled by them: it ends as they asked, and is not listed (decision 2).
  out.cancelled = await subscription(buyer, `Cancelled-${tag}`, "active", {
    cancel_at_period_end: 1,
    current_period_end: iso(3 * DAY),
  });
  out.cancelledTrial = await subscription(buyer, `CancelledTrial-${tag}`, "trialing", {
    trial_end: iso(4 * DAY),
    cancel_at_period_end: 1,
  });

  const klass = await create(KLASS, { name: `DropIn-${tag}`, price: 25, places: 10 });
  const held = await run<{ id: string; total: number }>(
    "order.start",
    { lines: [{ object: KLASS, id: klass }] },
    as(buyer),
  );
  out.held = held.id;
  const balanceDue = new Date(Date.now() + 20 * DAY).toISOString().slice(0, 10);
  const camp = await create(CAMP, {
    name: `Camp-${tag}`,
    price: 300,
    depositAmount: 100,
    balanceDue,
  });
  const deposit = await run<{ id: string }>(
    "order.start",
    { lines: [{ object: CAMP, id: camp }], pay: "deposit" },
    as(buyer),
  );
  await pay(deposit.id, 10_000);
  out.deposit = deposit.id;

  const me = buyer.principal.personId;
  out.expiring = await create(PASS, {
    name: `Ten-${tag}`,
    person: me,
    uses: 10,
    until: iso(3 * DAY),
  });
  out.later = await create(PASS, {
    name: `Five-${tag}`,
    person: me,
    uses: 5,
    until: iso(10 * DAY),
  });
  // The child's pass of one, used, and a token of one, used: only the pass opens to guardians.
  out.childPass = await create(PASS, {
    name: `ChildPass-${tag}`,
    person: kid,
    uses: 1,
    until: iso(30 * DAY),
  });
  out.childToken = await create(TOKEN, {
    name: `ChildToken-${tag}`,
    person: kid,
    uses: 1,
    until: iso(25 * DAY),
  });
  await create(ENTRY, { name: unique("In"), person: kid, state: "in" });
  await create(ENTRY, { name: unique("In"), person: kid, state: "in" });
  // A weekly membership of one, used this week: it renews by itself.
  out.weekly = await create(MEMBERSHIP, { name: `Weekly-${tag}`, person: me, uses: 1 });
  await create(SESSION, { name: unique("In"), person: me, state: "in" });
  return out;
}

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(fixture(ext, POINT));
  await run("order.settings.update", { currency: CURRENCY }, context(admin));
  member = await createBuyer(admin, "member");
  other = await createBuyer(admin, "other");
  childId = await child(member, "m");
  otherChildId = await child(other, "o");
  Object.assign(ids, await giveEverything(member, childId, "m"));
  const theirs = await giveEverything(other, otherChildId, "o");
  for (const [k, v] of Object.entries(theirs)) ids[`other.${k}`] = v;
  // Published after the orders: a document due holds every order at its point.
  ids.doc = await liveDocument("Fixture waiver");
}, 120_000);

const summary = (items: AttentionItem[]) =>
  items.map((i) => `${i.kind} ${i.record.id} ${i.person.self ? "self" : i.person.id}`);

describe("me.attention lists the eight kinds (stage 48 criterion 3)", () => {
  it("lists, soonest first, one of each, and nothing that needs nothing", async () => {
    const { days, items } = await attention(member);
    expect(days).toBe(7);
    expect(summary(items).sort()).toEqual(
      [
        `agree ${ids.doc} self`,
        `agree ${ids.doc} ${childId}`,
        `card_failing ${ids.failing} self`,
        `confirm_payment ${ids.confirm} self`,
        `balance_due ${ids.deposit} self`,
        `finish_paying ${ids.held} self`,
        `pass_expiring ${ids.expiring} self`,
        `pass_used_up ${ids.childPass} ${childId}`,
        `trial_ending ${ids.trial} self`,
      ].sort(),
    );
    // Soonest first.
    const moments = items.map((i) => i.at ?? "~");
    expect(moments).toEqual([...moments].sort());
    const by = (kind: string) => items.find((i) => i.kind === kind) as AttentionItem;
    expect(by("card_failing")).toMatchObject({
      record: { object: "subscription", title: "Failing-m" },
      amount: 4900,
      currency: CURRENCY,
    });
    expect(by("balance_due")).toMatchObject({
      record: { object: "order", title: "Camp-m" },
      amount: 20_000,
    });
    expect(by("finish_paying")).toMatchObject({ record: { title: "DropIn-m" }, amount: 2500 });
    expect(by("pass_expiring")).toMatchObject({
      record: { object: PASS, title: "Ten-m" },
      usesLeft: 10,
      amount: null,
    });
    expect(by("pass_used_up")).toMatchObject({
      person: { id: childId, name: "Child-m", self: false },
      record: { title: "ChildPass-m" },
      usesLeft: 0,
    });
    expect(by("trial_ending").at).toBeTruthy();
    // Not listed: the 10-day pass, the cancellations, the weekly limit, the child's token.
    const listed = JSON.stringify(items);
    for (const id of [ids.later, ids.cancelled, ids.cancelledTrial, ids.weekly, ids.childToken]) {
      expect(listed).not.toContain(id);
    }
  });

  it("never shows another member's items, nor their child's", async () => {
    const listed = JSON.stringify(await attention(member));
    for (const [key, id] of Object.entries(ids)) {
      if (key.startsWith("other.")) expect(listed, key).not.toContain(id);
    }
    expect(listed).not.toContain(otherChildId);
    expect(listed).not.toContain(other.principal.personId);
    // And theirs are theirs.
    const theirs = await attention(other);
    expect(theirs.items.some((i) => i.record.id === ids["other.failing"])).toBe(true);
    expect(JSON.stringify(theirs)).not.toContain(childId);
  });

  it("looks as far ahead as the setting: at 14 the 10-day pass is listed; only a human admin sets it", async () => {
    for (const ctx of [
      context(await createUser("member")),
      context(admin, { actor: "assistant" }),
      context(admin, { actor: "mcp" }),
    ]) {
      await expect(run("customer.settings.update", { attentionDays: 14 }, ctx)).rejects.toThrow();
    }
    await expect(
      run("customer.settings.update", { attentionDays: 31 }, context(admin)),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await run("customer.settings.update", { attentionDays: 14 }, context(admin));
    const { days, items } = await attention(member);
    expect(days).toBe(14);
    expect(items.some((i) => i.kind === "pass_expiring" && i.record.id === ids.later)).toBe(true);
    await run("customer.settings.update", { attentionDays: 7 }, context(admin));
    expect((await attention(member)).items.some((i) => i.record.id === ids.later)).toBe(false);
  });

  it("is outside MCP and the assistant, and staff do not reach it", async () => {
    await expect(run("me.attention", {}, context(admin))).rejects.toThrow();
  });
});

describe("me.attention is bounded (stage 48 criterion 4)", () => {
  /** What one call ran on D1: each statement's bound variables. */
  let ran: number[] = [];
  const counted = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          return new Proxy(statement, {
            get(inner, name) {
              if (name === "bind") {
                return (...values: unknown[]) => {
                  ran.push(values.length);
                  return inner.bind(...values);
                };
              }
              const value = Reflect.get(inner, name);
              if (typeof value === "function") {
                if (name === "all" || name === "first" || name === "run" || name === "raw") {
                  ran.push(0);
                }
                return value.bind(inner);
              }
              return value;
            },
          });
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const countedDb = createCrmDb(counted);

  async function measure(buyer: Buyer = member): Promise<number[]> {
    ran = [];
    await attention(buyer, countedDb);
    return ran;
  }

  it("reads a fixed number of statements, each well under 100 bound variables, whatever the packs", async () => {
    const before = await measure();
    expect(before.length).toBeGreaterThan(0);
    expect(before.length).toBeLessThan(40);
    expect(Math.max(...before)).toBeLessThan(100);
    // Another pack with a pass, a weekly holder and an agreement point: nothing more is read.
    await reconcile(fixture(extId("atx"), `atx${Date.now().toString(36)}`));
    const after = await measure();
    expect(after.length).toBe(before.length);
  });

  // The review of PR #359, finding 1: one seam read per holder object made the count grow with
  // every pack a member holds a pass in.
  it("reads the same statements with passes listed in two packs as in one", async () => {
    const buyer = await createBuyer(admin, "packs");
    const me = buyer.principal.personId;
    await create(PASS, { name: "PackOne", person: me, uses: 3, until: iso(2 * DAY) });
    const one = await measure(buyer);
    const second = extId("atp");
    await reconcile(fixture(second, `atp${Date.now().toString(36)}`));
    await create(`${second}.pass`, { name: "PackTwo", person: me, uses: 3, until: iso(2 * DAY) });
    const two = await measure(buyer);
    const { items } = await attention(buyer);
    expect(
      items
        .filter((i) => i.kind === "pass_expiring")
        .map((i) => i.record.title)
        .sort(),
    ).toEqual(["PackOne", "PackTwo"]);
    expect(two.length).toBe(one.length);
    expect(Math.max(...two)).toBeLessThan(100);
  });

  // Finding 2: a statement per Person of the family, and the family's ids bound in one.
  it("reads the same statements, binding no more, for a family of 30 as for a family of one", async () => {
    const guardian = await createBuyer(admin, "family");
    await child(guardian, "f0");
    const small = await measure(guardian);
    for (let n = 1; n < 30; n += 1) await child(guardian, `f${n}`);
    const large = await measure(guardian);
    const { items } = await attention(guardian);
    // The document is due for them and for each of the 30 children.
    expect(items.filter((i) => i.kind === "agree")).toHaveLength(31);
    expect(large.length).toBe(small.length);
    expect(Math.max(...large)).toBe(Math.max(...small));
  });
});

// Finding 3: `usesLeft` and `at` come from the host's row, so a pass whose object hides its uses
// and its end from the customer is not listed at all.
describe("a pass is listed only where its customer reads its uses and its end", () => {
  it("lists nothing of a pass whose object hides them, beside one that shows them", async () => {
    const buyer = await createBuyer(admin, "hidden");
    const me = buyer.principal.personId;
    const hidden = await create(HIDDEN, {
      name: "HiddenA",
      person: me,
      uses: 4,
      until: iso(2 * DAY),
    });
    const shown = await create(PASS, { name: "ShownA", person: me, uses: 4, until: iso(2 * DAY) });
    const mine = await run<{ items: { values: Record<string, unknown> }[] }>(
      "my.list",
      { object: HIDDEN },
      as(buyer),
    );
    expect(mine.items.map((i) => Object.keys(i.values).sort())).toEqual([["name", "state"]]);
    const { items } = await attention(buyer);
    expect(items.map((i) => i.record.id)).toContain(shown);
    expect(JSON.stringify(items)).not.toContain(hidden);
  });
});

describe("each item goes once its cause is fixed", () => {
  it("agreeing, paying, confirming, the trial ending, a cancel, a renewed pass and a new one", async () => {
    const due = await run<{ people: { personId: string; due: { version: { id: string } }[] }[] }>(
      "me.agreements.due",
      {},
      as(member),
    );
    for (const person of due.people) {
      for (const doc of person.due) {
        await run(
          "me.agreements.accept",
          {
            versionId: doc.version.id,
            typedName: "Fixture Name",
            ...(person.personId === member.principal.personId
              ? {}
              : { forPersonId: person.personId }),
          },
          as(member),
        );
      }
    }
    await moveSubscription(ids.failing, { state: "active", failing_since: null });
    await moveSubscription(ids.confirm, { state: "active" });
    await moveSubscription(ids.trial, { state: "active", trial_end: iso(-1000) });
    await pay(ids.deposit, 20_000);
    await run("order.cancel", { id: ids.held }, as(member));
    // Renewed: its own end moves past the days.
    await run(
      "record.update",
      { object: PASS, id: ids.expiring, values: { until: iso(40 * DAY) } },
      context(admin),
    );
    // A newer pass for the child takes over from the used one.
    await create(PASS, { name: "ChildNew", person: childId, uses: 5, until: iso(60 * DAY) });

    const { items } = await attention(member);
    expect(summary(items)).toEqual([]);
    // The other member's are still theirs.
    expect((await attention(other)).items.length).toBeGreaterThan(0);
  });
});

// Finding 4: me.agreements.due never shows a version whose stored text does not match its hash
// (a row written past the triggers), so Needs your attention does not list it either. Last in the
// file: the trigger is lifted to make the row, then put back.
describe("a document is listed as me.agreements.due answers it", () => {
  it("leaves out a version whose stored text does not match its hash", async () => {
    const buyer = await createBuyer(admin, "tamper");
    const doc = await liveDocument("Fixture tampered");
    const before = await attention(buyer);
    expect(before.items.some((i) => i.kind === "agree" && i.record.id === doc)).toBe(true);
    await env.DB.prepare("DROP TRIGGER core_agreement_version_no_update").run();
    try {
      await env.DB.prepare("UPDATE core_agreement_version SET body = ? WHERE document_id = ?")
        .bind(JSON.stringify({ blocks: [] }), doc)
        .run();
    } finally {
      await env.DB.prepare(
        `CREATE TRIGGER core_agreement_version_no_update
         BEFORE UPDATE ON core_agreement_version
         BEGIN
           SELECT RAISE(ABORT, 'core_agreement_version_immutable');
         END`,
      ).run();
    }
    const due = await run<{ people: { due: { documentId: string }[] }[] }>(
      "me.agreements.due",
      {},
      as(buyer),
    );
    expect(due.people.flatMap((p) => p.due).some((d) => d.documentId === doc)).toBe(false);
    const after = await attention(buyer);
    expect(after.items.some((i) => i.record.id === doc)).toBe(false);
  });
});
