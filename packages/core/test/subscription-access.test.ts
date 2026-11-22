// Stage 32a, build step 3, in the host (ADRs 0488 to 0490), against the payments gatekeeper's test
// double: the one-trial rule at subscription.start (used when the provider confirms it, held while
// a page is open, one trial under two starts at once, never a guest's), the `subscription` access
// source (access follows the holder and the state, and stops at a period's end), and staff ending
// one at once. The seam itself is unchanged: stage 42's access tests run as they were.
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ActingUser,
  accessProblems,
  getObject,
  holdsAccess,
  memoryEventSink,
  PAST_DUE_GRACE_DAYS,
  type PaymentsEvent,
  type ProviderSubscription,
  sweepSubscriptions,
} from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, unique } from "./helpers.ts";
import {
  type Buyer,
  CURRENCY,
  createBuyer,
  outside,
  PUBLIC,
  refusal,
  run,
} from "./order-fixtures.ts";
import { paymentsDouble } from "./payments-double.ts";

const SCHOOL = extId("academy");
const PLAN = `${SCHOOL}.plan`;
const COURSE = `${SCHOOL}.course`;
const RETURN = "https://shop.example.com/account";
const DAY = 86_400_000;

let events: ReturnType<typeof memoryEventSink>;
const payments = paymentsDouble(() => events);
const { gw, runtime } = payments;
let admin: ActingUser;
let plan: string;
let plan2: string;
let courses: string[];

const as = (buyer: Buyer) => outside(buyer.principal, { integrations: runtime, events });
const staff = () => context(admin, { integrations: runtime, events });

type Started = {
  subscriptionId: string;
  url: string;
  trialDays: number | null;
  noTrial: "sign_in" | "used" | null;
};

function subscribe(buyer: Buyer, planId = plan): Promise<Started> {
  return run<Started>(
    "subscription.start",
    { plan: { object: PLAN, id: planId }, returnUrl: RETURN },
    as(buyer),
  );
}

let clock = Date.now();
const later = () => {
  clock += 1000;
  return new Date(clock).toISOString();
};

function read(id: string, overrides: Partial<ProviderSubscription> = {}): ProviderSubscription {
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
    observedAt: later(),
    ...overrides,
  };
}

function deliver(
  trigger: Extract<PaymentsEvent, { kind: "subscription" }>["trigger"],
  subscription: ProviderSubscription,
) {
  return payments.deliver({
    kind: "subscription",
    provider: "fake",
    eventId: `fevt_${unique("s")}`,
    trigger,
    subscription,
    occurredAt: new Date().toISOString(),
  });
}

async function trials(personId: string) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM core_subscription_trial WHERE holder_person_id = ? ORDER BY created_at",
  )
    .bind(personId)
    .all<Record<string, unknown>>();
  return results;
}

async function notices(title: RegExp) {
  const { results } = await env.DB.prepare(
    "SELECT title FROM core_notifications WHERE user_id = ? ORDER BY created_at",
  )
    .bind(admin.id)
    .all<{ title: string }>();
  return results.filter((r) => title.test(r.title));
}

/** The provider's reference of the page a start opened. */
const pageOf = (subscriptionId: string) =>
  String(gw.subscriptions.find((s) => s.subscriptionId === subscriptionId)?.ref);

/** Sets what the provider says about a start's page. */
const page = (subscriptionId: string, status: "open" | "complete" | "expired" | "error") =>
  gw.pages.set(pageOf(subscriptionId), status);

/** Lets a hold lapse, as if its page had expired an hour ago (the provider still to be asked). */
async function lapse(checkoutId: string) {
  await env.DB.prepare("UPDATE core_subscription_trial SET held_until = ? WHERE checkout_id = ?")
    .bind(new Date(Date.now() - 3_600_000).toISOString(), checkoutId)
    .run();
}

/** Which of the school's courses `who` holds now (the seam's one question). */
async function held(who: Buyer, at?: string, ids: string[] = courses): Promise<string[]> {
  const object = getObject(COURSE);
  if (!object) throw new Error("no course object");
  const answer = await holdsAccess({ db: db.query, principal: who.principal }, object, ids, at);
  return [...answer].sort();
}

/** A customer whose subscription the provider has confirmed, on trial. */
async function member(label = "member"): Promise<{ buyer: Buyer; id: string }> {
  const buyer = await createBuyer(admin, label);
  const { subscriptionId: id } = await subscribe(buyer);
  await deliver("checkout_completed", read(id));
  return { buyer, id };
}

const staffStart = (email: string, ctx = staff()) =>
  run<Started>(
    "subscription.start",
    { plan: { object: PLAN, id: plan }, returnUrl: RETURN, email },
    ctx,
  );

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
        course: {
          label: "Course",
          plural: "Courses",
          titleField: "title",
          fields: { title: { type: "text", label: "Title", required: true } },
          public: { read: ["title"] },
          access: {
            sources: [
              { kind: "subscription", options: { plans: `${SCHOOL}.plan`, covers: "all" } },
            ],
          },
        },
      },
    }),
  );
  await run(
    "order.settings.update",
    { currency: CURRENCY, returnOrigins: ["https://shop.example.com"] },
    context(admin),
  );
  const create = async (object: string, values: Record<string, unknown>) =>
    ((await run("record.create", { object, values }, context(admin))) as { id: string }).id;
  plan = await create(PLAN, { name: "Every course", price: 29, trialDays: 7 });
  plan2 = await create(PLAN, { name: "Every course, again", price: 29, trialDays: 14 });
  courses = [
    await create(COURSE, { title: "Handstands" }),
    await create(COURSE, { title: "Hips" }),
  ];
  await payments.connect(admin.id);
});

beforeEach(() => {
  events = memoryEventSink();
});

describe("one free trial per person per plan object", () => {
  it("is used when the provider confirms it; a page is released only once the provider says it expired", async () => {
    const buyer = await createBuyer(admin, "trial");
    const first = await subscribe(buyer);
    expect(first).toMatchObject({ trialDays: 7, noTrial: null });
    expect(gw.subscriptions.at(-1)).toMatchObject({ trialDays: 7 });
    // Its hold lapsed, but the provider says the page is still open (a late completion could
    // come): not released, no second trial.
    await lapse(first.subscriptionId);
    expect(await subscribe(buyer, plan2)).toMatchObject({ trialDays: null, noTrial: "held" });
    // The provider says it expired uncompleted: released, and the trial is theirs again.
    page(first.subscriptionId, "expired");
    const second = await subscribe(buyer);
    expect(second).toMatchObject({ trialDays: 7, noTrial: null });
    expect(second.subscriptionId).not.toBe(first.subscriptionId);
    // The provider confirms the second: from now on the trial is used, on any plan of the object.
    await deliver("checkout_completed", read(second.subscriptionId));
    const rows = await trials(buyer.principal.personId);
    expect(rows.map((r) => [r.checkout_id, r.used_at !== null, r.released_at !== null])).toEqual([
      [first.subscriptionId, false, true],
      [second.subscriptionId, true, false],
    ]);
    for (const p of [plan, plan2]) {
      const again = await subscribe(buyer, p);
      expect(again).toMatchObject({ trialDays: null, noTrial: "used" });
      // The provider's page asks for the first payment at once: no trial is sent.
      expect(gw.subscriptions.at(-1)).not.toHaveProperty("trialDays");
    }
  });

  it("counts a page the provider says was completed as used, before its confirmation arrives", async () => {
    const buyer = await createBuyer(admin, "completed");
    const first = await subscribe(buyer);
    await lapse(first.subscriptionId);
    page(first.subscriptionId, "complete");
    expect(await subscribe(buyer)).toMatchObject({ trialDays: null, noTrial: "used" });
    expect((await trials(buyer.principal.personId))[0]?.used_at).not.toBeNull();
  });

  it("gives no trial while the provider cannot be asked about an earlier page, and says why", async () => {
    const buyer = await createBuyer(admin, "unasked");
    const first = await subscribe(buyer);
    await lapse(first.subscriptionId);
    page(first.subscriptionId, "error");
    expect(await subscribe(buyer)).toMatchObject({ trialDays: null, noTrial: "unconfirmed" });
    // Once the provider answers that it expired, the trial is given.
    page(first.subscriptionId, "expired");
    expect(await subscribe(buyer)).toMatchObject({ trialDays: 7, noTrial: null });
  });

  it("gives the same page, with the terms it was opened with, only to whoever opened it, and only while it is open", async () => {
    const buyer = await createBuyer(admin, "again");
    const sent = gw.subscriptions.length;
    const first = await subscribe(buyer);
    // The plan's price changes meanwhile: the page goes back with what it was opened at.
    await run("record.update", { object: PLAN, id: plan, values: { price: 35 } }, context(admin));
    try {
      const again = await subscribe(buyer);
      expect(again).toMatchObject({
        subscriptionId: first.subscriptionId,
        url: first.url,
        amount: 2900,
        trialDays: 7,
      });
      expect(gw.subscriptions.length).toBe(sent + 1);
      // Staff starting one for the same person: never handed that page; a fresh one, no trial.
      const byStaff = await staffStart(buyer.email);
      expect(byStaff.subscriptionId).not.toBe(first.subscriptionId);
      expect(byStaff.url).not.toBe(first.url);
      expect(byStaff).toMatchObject({ trialDays: null, noTrial: "held" });
      // Another plan of the same object while that page is open: a fresh page, no trial.
      expect(await subscribe(buyer, plan2)).toMatchObject({ trialDays: null, noTrial: "held" });
      // Once the provider says the page was completed, it is never handed out again.
      page(first.subscriptionId, "complete");
      const after = await subscribe(buyer);
      expect(after.url).not.toBe(first.url);
      expect(after).toMatchObject({ noTrial: "used" });
    } finally {
      await run("record.update", { object: PLAN, id: plan, values: { price: 29 } }, context(admin));
    }
  });

  it("gives one trial to two starts at once: the database refuses the second hold", async () => {
    const buyer = await createBuyer(admin, "race");
    const outcomes = await Promise.allSettled([subscribe(buyer), subscribe(buyer)]);
    const won = outcomes.filter((o) => o.status === "fulfilled");
    const lost = outcomes.filter((o) => o.status === "rejected");
    // Both read no hold; both opened a page; only one batch could take the trial.
    const rows = await trials(buyer.principal.personId);
    expect(rows).toHaveLength(1);
    if (won.length === 2) {
      // The second read the first's hold and got its page back.
      const ids = won.map((o) => (o as PromiseFulfilledResult<Started>).value.subscriptionId);
      expect(new Set(ids).size).toBe(1);
    } else {
      expect(won).toHaveLength(1);
      expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({
        code: "conflict",
        details: { rule: "trial_held" },
      });
      const { results } = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM core_subscription_checkout WHERE holder_person_id = ?",
      )
        .bind(buyer.principal.personId)
        .all<{ n: number }>();
      // Nothing of the refused start was recorded.
      expect(results[0]?.n).toBe(1);
    }
  });

  it("never gives a guest a trial, so a guest cannot spend someone else's or learn if they had one", async () => {
    const victim = await createBuyer(admin, "victim");
    const guest = outside(PUBLIC, { integrations: runtime, events });
    const asGuest = () =>
      run<Started>(
        "subscription.start",
        { plan: { object: PLAN, id: plan }, returnUrl: RETURN, email: victim.email },
        guest,
      );
    const before = await asGuest();
    expect(before).toMatchObject({ trialDays: null, noTrial: "sign_in" });
    expect(gw.subscriptions.at(-1)).not.toHaveProperty("trialDays");
    // The guest completes the provider's page with their own card: a paid subscription, no trial.
    await deliver(
      "checkout_completed",
      read(before.subscriptionId, { status: "active", trialEnd: null }),
    );
    expect(await trials(victim.principal.personId)).toEqual([]);
    // The person themselves, signed in, still gets their trial.
    expect(await subscribe(victim)).toMatchObject({ trialDays: 7, noTrial: null });
    // And a guest's answer is the same for an address that has had a trial.
    expect(await asGuest()).toMatchObject({ trialDays: null, noTrial: "sign_in" });
  });

  it("is given by staff only with subscriptions:manage and as a person; otherwise none, and why", async () => {
    const buyer = await createBuyer(admin, "byStaff");
    // A member of staff without the permission (records:write only): no trial, nothing held.
    const writer = await createUser("member");
    const plain = await staffStart(buyer.email, context(writer, { integrations: runtime, events }));
    expect(plain).toMatchObject({ trialDays: null, noTrial: "permission" });
    expect(await trials(buyer.principal.personId)).toEqual([]);
    // An admin, but through an automation rather than a person: none either.
    const automated = await staffStart(
      buyer.email,
      context(admin, { integrations: runtime, events, actor: "automation" }),
    );
    expect(automated).toMatchObject({ trialDays: null, noTrial: "permission" });
    const started = await staffStart(buyer.email);
    expect(started).toMatchObject({ trialDays: 7, noTrial: null });
    await deliver("checkout_completed", read(started.subscriptionId));
    expect(await subscribe(buyer)).toMatchObject({ noTrial: "used" });
  });

  it("tells staff of a second trial confirmed after its hold was released", async () => {
    const buyer = await createBuyer(admin, "late");
    const first = await subscribe(buyer);
    page(first.subscriptionId, "expired");
    const second = await subscribe(buyer);
    await deliver("checkout_completed", read(second.subscriptionId));
    // A confirmation for the first page arrives all the same (the provider's word was wrong).
    await deliver("checkout_completed", read(first.subscriptionId));
    expect(await notices(/second free trial/)).toHaveLength(1);
  });

  it("does not count a free time until a date (a continuation) as the trial", async () => {
    const buyer = await createBuyer(admin, "continuing");
    // What step 4's continuation will open: free until a date, no trial days.
    const id = `sbs_${unique("c")}`;
    await env.DB.prepare(
      `INSERT INTO core_subscription_checkout (id, provider, ref, payer_person_id, holder_person_id,
        email, placed_as, plan_object, plan_id, plan_title, amount, currency, interval, trial_end,
        created_at) VALUES (?, 'fake', ?, ?, ?, ?, 'customer', ?, ?, 'Every course', 2900, ?,
        'month', ?, ?)`,
    )
      .bind(
        id,
        `fcs_${id}`,
        buyer.principal.personId,
        buyer.principal.personId,
        buyer.email,
        PLAN,
        plan,
        CURRENCY,
        new Date(Date.now() + 20 * DAY).toISOString(),
        new Date().toISOString(),
      )
      .run();
    const told = (await notices(/second free trial/)).length;
    await deliver(
      "checkout_completed",
      read(id, { trialEnd: new Date(Date.now() + 20 * DAY).toISOString() }),
    );
    expect(await notices(/second free trial/)).toHaveLength(told);
    // Free time, not the trial: they still get the plan's trial.
    expect(await subscribe(buyer)).toMatchObject({ trialDays: 7, noTrial: null });
  });

  it("survives a malformed expiry from the gatekeeper: the page is still recorded and held", async () => {
    const buyer = await createBuyer(admin, "malformed");
    gw.nextExpiresAt = "not a moment";
    const started = await subscribe(buyer);
    expect(started).toMatchObject({ trialDays: 7, expiresAt: null });
    const [hold] = await trials(buyer.principal.personId);
    expect(Date.parse(String(hold?.held_until))).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  });
});

describe("the subscription access source", () => {
  it("gives every live course, ones added later too, to the holder while it runs", async () => {
    const { buyer, id } = await member("holder");
    expect(await held(buyer)).toEqual([...courses].sort());
    const later = (
      (await run(
        "record.create",
        { object: COURSE, values: { title: "Later" } },
        context(admin),
      )) as { id: string }
    ).id;
    const object = getObject(COURSE);
    if (!object) throw new Error("no course");
    const reader = { db: db.query, principal: buyer.principal };
    expect([...(await holdsAccess(reader, object, [later]))]).toEqual([later]);
    // Someone else, with no subscription, holds none; nor does the public.
    const other = await createBuyer(admin, "nobody");
    expect(await held(other)).toEqual([]);
    expect([...(await holdsAccess({ db: db.query, principal: PUBLIC }, object, courses))]).toEqual(
      [],
    );
    // Past due: the provider is retrying, the member keeps everything (decision 4).
    await deliver("invoice_payment_failed", read(id, { status: "past_due", trialEnd: null }));
    expect(await held(buyer)).toEqual([...courses].sort());
    // Unpaid (the provider stopped retrying and marked it so): nothing.
    await deliver("updated", read(id, { status: "unpaid", trialEnd: null }));
    expect(await held(buyer)).toEqual([]);
    await deliver("updated", read(id, { status: "active", trialEnd: null }));
    expect(await held(buyer)).toEqual([...courses].sort());
    // The provider gave up and ended it: access stops.
    await deliver(
      "deleted",
      read(id, { status: "canceled", endReason: "payment_failed", endedAt: later_() }),
    );
    expect(await held(buyer)).toEqual([]);
  });

  it("keeps access until a cancelled period ends and not a minute after, before the provider says so", async () => {
    const { buyer, id } = await member("ending");
    const end = new Date(Date.now() + 2 * DAY).toISOString();
    await deliver(
      "updated",
      read(id, {
        status: "active",
        trialEnd: null,
        cancelAtPeriodEnd: true,
        currentPeriodEnd: end,
      }),
    );
    expect(await held(buyer)).toEqual([...courses].sort());
    const minuteBefore = new Date(Date.parse(end) - 60_000).toISOString();
    expect(await held(buyer, minuteBefore)).toEqual([...courses].sort());
    expect(await held(buyer, end)).toEqual([]);
    expect(await held(buyer, new Date(Date.parse(end) + 60_000).toISOString())).toEqual([]);
    // Resumed before then (the provider confirms): it keeps running past that moment.
    await deliver("updated", read(id, { status: "active", trialEnd: null, currentPeriodEnd: end }));
    expect(await held(buyer, new Date(Date.parse(end) + 60_000).toISOString())).toEqual(
      [...courses].sort(),
    );
    // A date set at the provider another way ends it the same.
    await deliver(
      "updated",
      read(id, { status: "active", trialEnd: null, currentPeriodEnd: end, cancelAt: end }),
    );
    expect(await held(buyer, end)).toEqual([]);
  });

  it("follows the holder, never the payer", async () => {
    const { buyer: payer, id } = await member("payer");
    const child = await createBuyer(admin, "child");
    // 32a has no way to name another holder (ADR 0487); 32b will. Set as it will be.
    await env.DB.prepare("UPDATE core_subscription SET holder_person_id = ? WHERE id = ?")
      .bind(child.principal.personId, id)
      .run();
    expect(await held(child)).toEqual([...courses].sort());
    expect(await held(payer)).toEqual([]);
  });

  it("gives nothing while paused or incomplete", async () => {
    const { buyer, id } = await member("paused");
    await deliver("paused", read(id, { status: "paused", trialEnd: null }));
    expect(await held(buyer)).toEqual([]);
  });

  it("refuses a declaration that does not hold together, so it gives no one access", () => {
    const course = getObject(COURSE);
    if (!course) throw new Error("no course");
    const wrong = (options: Record<string, unknown>) =>
      accessProblems({
        ...course,
        access: { sources: [{ kind: "subscription", options: options as never }] },
      });
    expect(wrong({ plans: PLAN, covers: "all" })).toEqual([]);
    expect(wrong({ plans: PLAN, covers: "some" })).toEqual([
      'access.sources.0: covers must be "all" (every live record)',
    ]);
    expect(wrong({ plans: COURSE, covers: "all" })[0]).toMatch(/same extension/);
    expect(wrong({ plans: "person", covers: "all" })[0]).toMatch(/same extension/);
    expect(wrong({ plans: PLAN, covers: "all", list: ["x"] })[0]).toMatch(/no option "list"/);
  });
});

describe("staff end a subscription at once", () => {
  it("asks the provider to end it now with subscriptions:manage; a customer cannot", async () => {
    const { buyer, id } = await member("endNow");
    const asked = await run<{ requested: boolean }>(
      "subscription.cancel",
      { id, reason: "Asked by phone", now: true },
      staff(),
    );
    expect(asked.requested).toBe(true);
    expect(gw.changes.at(-1)).toMatchObject({
      method: "cancelSubscription",
      request: { subscriptionId: id, when: "now", reason: "Asked by phone" },
    });
    const own = await refusal(run("subscription.cancel", { id, now: true }, as(buyer)));
    expect(own.code).toBe("invalid_input");
    // Nobody but staff with the permission: a member of staff without it is refused.
    const member_ = await createUser("member");
    const refused = await refusal(
      run(
        "subscription.cancel",
        { id, now: true, reason: "x" },
        context(member_, { integrations: runtime, events }),
      ),
    );
    expect(refused.code).toBe("forbidden");
  });
});

describe("access with no event, and only for live records (review of 32a)", () => {
  it("answers held only for live records of the object: not a trashed or made-up id", async () => {
    const { buyer } = await member("liveOnly");
    const doomed = (
      (await run(
        "record.create",
        { object: COURSE, values: { title: "Gone" } },
        context(admin),
      )) as {
        id: string;
      }
    ).id;
    await run("record.delete", { object: COURSE, id: doomed }, context(admin));
    const asked = [...courses, doomed, "rec_made_up"];
    expect(await held(buyer, undefined, asked)).toEqual([...courses].sort());
  });

  it("past due gives access only until it has been failing 30 days; staff are told once when it lapses", async () => {
    const { buyer, id } = await member("longFailing");
    await deliver("invoice_payment_failed", read(id, { status: "past_due", trialEnd: null }));
    expect(await held(buyer)).toEqual([...courses].sort());
    // Failing for 30 days and an hour, the provider still not ending it.
    const since = new Date(Date.now() - (PAST_DUE_GRACE_DAYS * DAY + 3_600_000)).toISOString();
    await env.DB.prepare("UPDATE core_subscription SET failing_since = ? WHERE id = ?")
      .bind(since, id)
      .run();
    expect(await held(buyer)).toEqual([]);
    const before = (await notices(/no longer gives access/)).length;
    const now = new Date().toISOString();
    expect((await sweepSubscriptions(db, now)).pastDueLapsed).toBeGreaterThanOrEqual(1);
    await sweepSubscriptions(db, now);
    expect(await notices(/no longer gives access/)).toHaveLength(before + 1);
  });

  it("keeps an active member's access when events stop arriving, and tells staff once", async () => {
    const { buyer, id } = await member("silent");
    const ended = new Date(Date.now() - 3.5 * DAY).toISOString();
    await env.DB.prepare(
      "UPDATE core_subscription SET state = 'active', current_period_end = ?, version = version + 1 WHERE id = ?",
    )
      .bind(ended, id)
      .run();
    // A webhook outage must not lock out a paying member.
    expect(await held(buyer)).toEqual([...courses].sort());
    const before = (await notices(/events are not arriving/)).length;
    const now = new Date().toISOString();
    expect((await sweepSubscriptions(db, now)).eventsMissing).toBeGreaterThanOrEqual(1);
    await sweepSubscriptions(db, now);
    expect(await notices(/events are not arriving/)).toHaveLength(before + 1);
  });
});

describe("a person merge moves their subscriptions (review of 32a)", () => {
  it("keeps access, self-service and the trial rule with the survivor", async () => {
    // A guest's address, made a Person by staff starting a trial for it (Person A), confirmed.
    const guestEmail = `${unique("guest")}@buyers.example`.toLowerCase();
    const started = await staffStart(guestEmail);
    await deliver("checkout_completed", read(started.subscriptionId));
    const sub = await env.DB.prepare("SELECT holder_person_id FROM core_subscription WHERE id = ?")
      .bind(started.subscriptionId)
      .first<{ holder_person_id: string }>();
    const personA = String(sub?.holder_person_id);
    // Later they sign up under another address (Person B), with a page of their own still open.
    const b = await createBuyer(admin, "signedUp");
    const open = await subscribe(b);
    expect(open).toMatchObject({ trialDays: 7 });
    expect(await held(b)).toEqual([]);
    // Staff merge A into B.
    await run("person.merge", { survivorId: b.principal.personId, mergedId: personA }, staff());
    // B holds every course, sees the subscription as theirs and can cancel it.
    expect(await held(b)).toEqual([...courses].sort());
    const mine = await run<{ items: { id: string }[] }>("subscription.list", {}, as(b));
    expect(mine.items.map((s) => s.id)).toContain(started.subscriptionId);
    await run("subscription.cancel", { id: started.subscriptionId }, as(b));
    expect(gw.changes.at(-1)).toMatchObject({
      method: "cancelSubscription",
      request: { subscriptionId: started.subscriptionId },
    });
    // One trial row is kept for the plan object (A's used one), and B gets no second trial.
    const rows = await trials(b.principal.personId);
    expect(rows.map((r) => r.checkout_id)).toEqual([started.subscriptionId]);
    expect(await trials(personA)).toEqual([]);
    expect(await subscribe(b)).toMatchObject({ trialDays: null, noTrial: "used" });
    const checkout = await env.DB.prepare(
      "SELECT payer_person_id, holder_person_id FROM core_subscription_checkout WHERE id = ?",
    )
      .bind(started.subscriptionId)
      .first();
    expect(checkout).toEqual({
      payer_person_id: b.principal.personId,
      holder_person_id: b.principal.personId,
    });
  });
});

function later_() {
  return new Date().toISOString();
}
