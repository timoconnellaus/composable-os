// Stage 44 step 3, the review of PR #280 (ADR 0644, amended): what the independent review found,
// each as the fixed behaviour.
//   1. A minor who would pay where the payer must agree is refused (a parent or guardian buys
//      it), by order.start and subscription.start, and nothing of theirs satisfies it.
//   2. A guest's acceptance counts only for its own purchase: one made with a member's address
//      never satisfies that member's next booking or purchase (coordinator decision, owner to
//      confirm).
//   3. A guest's purchase with a minor's address stands; the child stays due (a guardian agrees)
//      and staff with agreements:manage are told, naming the order (coordinator decision, owner
//      to confirm).
//   4. order.setPerson takes only a Person with the order's address, and a minor only once
//      nothing is due for them.
//   5. A subscription checkout never confirmed loses its guest acceptances three days on.
// All text is fixture text.
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agreementsDue } from "../src/agreements/due.ts";
import {
  type ActingUser,
  type CustomerPrincipal,
  createInvoker,
  createRegistry,
  memoryEventSink,
  runAgreementsDue,
} from "../src/index.ts";
import { fixtureOperations } from "./customer-fixtures.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, unique } from "./helpers.ts";
import {
  CURRENCY,
  createBuyer,
  orderRegistry,
  outside,
  PUBLIC,
  refusal,
} from "./order-fixtures.ts";
import { paymentsDouble } from "./payments-double.ts";

const registry = createRegistry([...orderRegistry.list(), ...fixtureOperations]);
const invoker = createInvoker(registry);
const run = <T = Record<string, unknown>>(
  name: string,
  input: unknown,
  ctx: Parameters<typeof invoker.invokeByName>[2],
) => invoker.invokeByName(name, input, ctx) as Promise<T>;

const GYM = extId("rvw");
const PASS = `${GYM}.pass`;
const TICKET = `${GYM}.ticket`;
const SLOT = `${GYM}.slot`;
const VISIT = `${GYM}.visit`;
const PAYPASS = `${GYM}.paypass`;
const PAYPLAN = `${GYM}.payplan`;
const tag = Date.now().toString(36);
const MEMBERSHIP = `rm${tag}`;
const BOOKING = `rv${tag}`;
const EVENT = `re${tag}`;
const PAYER = `rp${tag}`;
const RETURN = "https://gym.example.com/account";
const DAY = 86_400_000;

let events: ReturnType<typeof memoryEventSink>;
const payments = paymentsDouble(() => events);
const { runtime } = payments;
let admin: ActingUser;
let pass: string;
let ticket: string;
let slot: string;
let paypass: string;
let payplan: string;

const staff = () => context(admin, { integrations: runtime, events });
const as = (principal: CustomerPrincipal | { kind: "public" }) =>
  outside(principal, { integrations: runtime, events });
const body = (text: string) => ({
  blocks: [{ type: "paragraph", content: [{ type: "text", text }] }],
});
interface Doc {
  id: string;
  versionId: string;
  kind: string;
}
async function publish(
  kind: "terms" | "waiver" | "health",
  points: string[],
  extra: Record<string, unknown> = {},
): Promise<Doc> {
  const { id } = await run<{ id: string }>(
    "agreement.create",
    { title: unique(`Fixture ${kind}`), kind },
    staff(),
  );
  const saved = await run<{ hash: string; rev: number }>(
    "agreement.draft.save",
    {
      id,
      body: body("Fixture text."),
      tickLabel: "I have read this fixture",
      ...(kind === "health" ? { questions: [{ key: "q1", text: "Q?", noteOnYes: false }] } : {}),
      ...extra,
    },
    staff(),
  );
  const { version } = await run<{ version: { id: string } }>(
    "agreement.publish",
    { documentId: id, draftHash: saved.hash, draftRev: saved.rev, number: 1, change: "small" },
    staff(),
  );
  await run("agreement.attach", { documentId: id, points }, staff());
  return { id, versionId: version.id, kind };
}
const guestAgrees = (docs: Doc[]) =>
  docs.map((d) => ({
    versionId: d.versionId,
    typedName: "Fixture Visitor",
    ...(d.kind === "health" ? { answers: [{ key: "q1", yes: false }] } : {}),
  }));
const startOrder = (
  object: string,
  id: string,
  ctx: Parameters<typeof run>[2],
  extra: Record<string, unknown> = {},
) =>
  run<{ id: string; token: string | null; total: number }>(
    "order.start",
    { lines: [{ object, id, quantity: 1 }], ...extra },
    ctx,
  );
const pay = (o: { id: string; total: number }) =>
  run(
    "fixture.verifiedPayment",
    { eventId: unique("evt"), orderId: o.id, amount: o.total },
    staff(),
  );
const dueOf = (error: { details: Record<string, unknown> }) =>
  (error.details.documents ?? []) as { documentId: string; reason?: string }[];
const dueIds = (error: { details: Record<string, unknown> }) =>
  dueOf(error)
    .map((d) => d.documentId)
    .sort();
const visitAs = (principal: CustomerPrincipal) =>
  run<{ id: string }>("fixture.myCreate", { object: VISIT, values: { slot } }, as(principal));
const markMinor = (personId: string) =>
  run("agreement.setMinor", { personId, minor: true }, staff());

let waiver: Doc;
let health: Doc;
let payerTerms: Doc;

beforeAll(async () => {
  admin = await createUser("admin");
  const sellable = (point: string, recurring = false) => ({
    label: "X",
    plural: "Xs",
    titleField: "name",
    fields: {
      name: { type: "text" as const, label: "Name", required: true },
      price: { type: "currency" as const, label: "Price", currency: CURRENCY },
    },
    sellable: {
      price: "price",
      ...(recurring ? { recurring: { interval: "month" as const } } : {}),
    },
    public: { read: ["name", "price"] },
    agreements: { point, label: "P" },
  });
  await reconcile(
    manifest(GYM, {
      objects: {
        pass: sellable(MEMBERSHIP),
        ticket: sellable(EVENT),
        paypass: sellable(PAYER),
        payplan: sellable(PAYER, true),
        slot: {
          label: "Slot",
          plural: "Slots",
          titleField: "name",
          fields: { name: { type: "text", label: "Name", required: true } },
          public: { read: ["name"] },
        },
        visit: {
          label: "Visit",
          plural: "Visits",
          titleField: "title",
          fields: {
            title: { type: "text", label: "Title" },
            slot: { type: "relation", label: "Slot", to: `${GYM}.slot`, required: true },
            person: { type: "relation", label: "Person", to: "person" },
            state: {
              type: "select",
              label: "State",
              options: [
                { value: "booked", label: "Booked" },
                { value: "cancelled", label: "Cancelled" },
              ],
            },
          },
          states: {
            field: "state",
            initial: "booked",
            moves: [{ from: "booked", to: "cancelled", by: ["staff", "customer"], final: true }],
          },
          customer: {
            field: "person",
            read: ["person", "slot", "state"],
            write: ["slot", "state"],
            createOnly: ["slot"],
          },
          agreements: {
            point: BOOKING,
            label: "Before a visit",
            enter: ["booked"],
            person: "person",
          },
        },
      },
    }),
  );
  await run(
    "order.settings.update",
    { currency: CURRENCY, returnOrigins: ["https://gym.example.com"] },
    staff(),
  );
  const create = async (object: string, values: Record<string, unknown>) =>
    (await run<{ id: string }>("record.create", { object, values }, staff())).id;
  pass = await create(PASS, { name: "Ten", price: 90 });
  ticket = await create(TICKET, { name: "Open day", price: 1 });
  paypass = await create(PAYPASS, { name: "Paid", price: 50 });
  payplan = await create(PAYPLAN, { name: "Monthly", price: 30 });
  slot = await create(SLOT, { name: "Morning" });
  await payments.connect(admin.id);
  // One waiver at a ticket, a membership and a visit (a business's one waiver everywhere).
  waiver = await publish("waiver", [EVENT, MEMBERSHIP, BOOKING]);
  health = await publish("health", [BOOKING]);
  // The payer's terms on a point of their own.
  payerTerms = await publish("terms", [PAYER], { who: "payer" });
}, 120_000);

beforeEach(() => {
  events = memoryEventSink();
});

describe("1: a minor never pays where the payer must agree", () => {
  it("is refused an order and a subscription, and nothing of theirs or a guardian's for them satisfies it", async () => {
    const kid = await createBuyer(admin, "minor");
    await markMinor(kid.principal.personId);
    const order = await refusal(startOrder(PAYPASS, paypass, as(kid.principal)));
    expect(order.details).toMatchObject({ rule: "agreements_due", reason: "minor_payer" });
    expect(order.message).toMatch(/parent or guardian needs to buy this/);
    expect(dueIds(order)).toEqual([payerTerms.id]);
    const sub = await refusal(
      run(
        "subscription.start",
        { plan: { object: PAYPLAN, id: payplan }, returnUrl: RETURN },
        as(kid.principal),
      ),
    );
    expect(sub.details).toMatchObject({ rule: "agreements_due", reason: "minor_payer" });
    // The child cannot agree to it, and staff starting it for the child's address are refused too.
    const own = await refusal(
      run(
        "me.agreements.accept",
        { versionId: payerTerms.versionId, typedName: "Fixture Kid" },
        as(kid.principal),
      ),
    );
    expect(own.code).not.toBe(undefined);
    const desk = await refusal(startOrder(PAYPASS, paypass, staff(), { email: kid.email }));
    expect(desk.details.reason).toBe("minor_payer");
    // An adult is asked for the payer's terms as usual, and buys once agreed.
    const adult = await createBuyer(admin, "adult");
    const asked = await refusal(startOrder(PAYPASS, paypass, as(adult.principal)));
    expect(asked.details.reason).toBeUndefined();
    await run(
      "me.agreements.accept",
      { versionId: payerTerms.versionId, typedName: "Fixture Adult" },
      as(adult.principal),
    );
    expect((await startOrder(PAYPASS, paypass, as(adult.principal))).id).toMatch(/^ord_/);
  });
});

describe("2: a guest's acceptance counts only for its own purchase", () => {
  it("a guest ticket bought with a member's address never satisfies the member's next visit or purchase", async () => {
    const member = await createBuyer(admin, "member");
    expect(dueIds(await refusal(visitAs(member.principal)))).toEqual([waiver.id, health.id].sort());
    const o = await startOrder(TICKET, ticket, as(PUBLIC), {
      email: member.email,
      agreements: guestAgrees([waiver]),
    });
    await pay(o);
    // Settled to the member (the evidence of that purchase), and counting for nothing after it.
    const row = await env.DB.prepare(
      "SELECT person_id FROM core_agreement_acceptance WHERE order_id = ?",
    )
      .bind(o.id)
      .first<{ person_id: string }>();
    expect(row?.person_id).toBe(member.principal.personId);
    expect(dueIds(await refusal(visitAs(member.principal)))).toEqual([waiver.id, health.id].sort());
    expect(dueIds(await refusal(startOrder(PASS, pass, as(member.principal))))).toEqual([
      waiver.id,
    ]);
    // Their own acceptance does.
    await run(
      "me.agreements.accept",
      { versionId: waiver.versionId, typedName: "Fixture Member" },
      as(member.principal),
    );
    expect((await startOrder(PASS, pass, as(member.principal))).id).toMatch(/^ord_/);
  });
});

describe("3: a guest's purchase with a minor's address", () => {
  it("stands; the child stays due for a guardian, and staff with agreements:manage are told", async () => {
    const kid = await createBuyer(admin, "minorg");
    await markMinor(kid.principal.personId);
    const o = await startOrder(PASS, pass, as(PUBLIC), {
      email: kid.email,
      agreements: guestAgrees([waiver]),
    });
    await pay(o);
    const row = await env.DB.prepare("SELECT person_id, state FROM core_order WHERE id = ?")
      .bind(o.id)
      .first<{ person_id: string; state: string }>();
    expect(row).toEqual({ person_id: kid.principal.personId, state: "paid" });
    const notices = await env.DB.prepare(
      "SELECT user_id, title, body, human_only FROM core_notifications WHERE dedupe_key = ?",
    )
      .bind(`agreement-guest-minor:${o.id}`)
      .all<{ user_id: string; title: string; body: string; human_only: number }>();
    expect(notices.results.map((n) => n.user_id)).toContain(admin.id);
    for (const n of notices.results) {
      expect(n.human_only).toBe(1);
      expect(n.body).toContain(o.id);
      expect(n.body).not.toContain(waiver.id);
      expect(n.body).not.toMatch(/Fixture waiver/);
    }
    // The child is still asked, for a guardian: the guest's acceptance counts for nothing.
    const { due } = await agreementsDue(db.query, {
      point: BOOKING,
      participant: kid.principal.personId,
      payer: null,
      now: new Date().toISOString(),
    });
    expect(due.find((d) => d.documentId === waiver.id)?.reason).toBe("guardian");
    expect(dueIds(await refusal(visitAs(kid.principal)))).toContain(waiver.id);
  });
});

describe("4: order.setPerson", () => {
  it("takes only a Person with the order's address, and a minor only once nothing is due", async () => {
    const email = `${unique("addr")}@buyers.example`.toLowerCase();
    const o = await startOrder(TICKET, ticket, as(PUBLIC), {
      email,
      agreements: guestAgrees([waiver]),
    });
    await pay(o);
    // The address matched a Person made with it, so it already has one; a stranger is refused.
    const other = await createBuyer(admin, "stranger");
    await env.DB.prepare("UPDATE core_order SET person_id = NULL WHERE id = ?").bind(o.id).run();
    const wrong = await refusal(
      run("order.setPerson", { id: o.id, personId: other.principal.personId }, staff()),
    );
    expect(wrong.details).toMatchObject({ rule: "order_person" });
    // A minor with the address: refused while anything is due for them.
    const kidId = (
      await run<{ id: string }>(
        "person.list",
        { filter: { field: "primaryEmail", op: "eq", value: email }, limit: 1 },
        staff(),
      ).then((page) => (page as unknown as { items: { id: string }[] }).items[0] ?? { id: "" })
    ).id;
    expect(kidId).toBeTruthy();
    await markMinor(kidId);
    const minor = await refusal(run("order.setPerson", { id: o.id, personId: kidId }, staff()));
    expect(minor.details.rule).toBe("agreements_due");
    // Once a guardian's paper form is recorded for them, it goes through.
    await run(
      "agreement.recordPaper",
      {
        personId: kidId,
        versionId: waiver.versionId,
        signedOn: new Date().toISOString().slice(0, 10),
        typedName: "Fixture Parent",
        signedBy: "Fixture parent",
      },
      staff(),
    );
    await run("order.setPerson", { id: o.id, personId: kidId }, staff());
  });
});

describe("5: an unconfirmed subscription checkout", () => {
  it("loses its guest acceptances three days on, and not before", async () => {
    const email = `${unique("subg")}@buyers.example`.toLowerCase();
    const plain = await publish("waiver", [PAYER]);
    try {
      const started = await run<{ subscriptionId: string }>(
        "subscription.start",
        {
          plan: { object: PAYPLAN, id: payplan },
          returnUrl: RETURN,
          email,
          agreements: guestAgrees([payerTerms, plain]),
        },
        as(PUBLIC),
      );
      const count = async () =>
        Number(
          (
            await env.DB.prepare(
              "SELECT count(*) AS n FROM core_agreement_acceptance WHERE subscription_checkout = ?",
            )
              .bind(started.subscriptionId)
              .first<{ n: number }>()
          )?.n,
        );
      expect(await count()).toBe(2);
      // An hour's first minute: the cron looks for unconfirmed acceptances then (ADR 0130).
      const onTheHour = (t: number) => new Date(Math.floor(t / 3_600_000) * 3_600_000);
      await runAgreementsDue(db, { clock: () => onTheHour(Date.now() + 2 * DAY) });
      expect(await count()).toBe(2);
      // Past the three days, but not on the hour: left for the hour's first minute.
      await runAgreementsDue(db, {
        clock: () => new Date(onTheHour(Date.now() + 4 * DAY).getTime() + 15 * 60_000),
      });
      expect(await count()).toBe(2);
      await runAgreementsDue(db, { clock: () => onTheHour(Date.now() + 4 * DAY) });
      expect(await count()).toBe(0);
    } finally {
      await run("agreement.retire", { documentId: plain.id }, staff());
    }
  });
});
