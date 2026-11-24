// Stage 32a, build step 4, in the host (ADRs 0491 and 0492), against the payments gatekeeper's test
// double: continuation offers. Staff import a list (a person's door, people first, a dry run, a
// re-run that changes nothing); only the person an offer is for takes it, signed in as its
// address; it opens the provider's page free until the paid-up date, with no trial on top and no
// trial used; it is taken once, under two takes at once too; it expires on its date (under 48
// hours: charged at once); staff withdraw it; the report says who took theirs and when they are
// charged from.
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ActingUser,
  getObject,
  holdOfferStatements,
  holdsAccess,
  memoryEventSink,
  OFFER_MIN_FREE_MS,
  type PaymentsEvent,
  type ProviderSubscription,
  paidUpMoment,
  sweepSubscriptions,
} from "../src/index.ts";
import { erasedAddressHash } from "../src/records/erase-subject.ts";
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

const SCHOOL = extId("moving");
const PLAN = `${SCHOOL}.plan`;
const COURSE = `${SCHOOL}.course`;
const RETURN = "https://shop.example.com/account";
const DAY = 86_400_000;

let events: ReturnType<typeof memoryEventSink>;
const payments = paymentsDouble(() => events);
const { gw, runtime } = payments;
let admin: ActingUser;
let plan: string;
let course: string;

const as = (buyer: Buyer) => outside(buyer.principal, { integrations: runtime, events });
const staff = (overrides: Parameters<typeof context>[1] = {}) =>
  context(admin, { integrations: runtime, events, ...overrides });

type Started = {
  subscriptionId: string;
  url: string;
  trialDays: number | null;
  freeUntil: string | null;
  noTrial: string | null;
};
type ImportResult = {
  email: string;
  outcome: string;
  offerId: string | null;
  personId: string | null;
  freeUntil: string | null;
  note: string | null;
  signIn: string | null;
};

/** A date `days` from now, as the import's CSV gives it. */
const dateIn = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

function importOffers(
  rows: { email: string; freeUntil: string; reference?: string }[],
  options: { dryRun?: boolean; invite?: boolean; reissue?: boolean } = {},
  ctx = staff(),
) {
  return run<{ results: ImportResult[] }>(
    "subscription.offer.import",
    { plan: { object: PLAN, id: plan }, rows, ...options },
    ctx,
  );
}

function take(buyer: Buyer, offerId: string, planId = plan): Promise<Started> {
  return run<Started>(
    "subscription.start",
    { plan: { object: PLAN, id: planId }, returnUrl: RETURN, offerId },
    as(buyer),
  );
}

function subscribe(buyer: Buyer): Promise<Started> {
  return run<Started>(
    "subscription.start",
    { plan: { object: PLAN, id: plan }, returnUrl: RETURN },
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
    trialEnd: null,
    currentPeriodStart: new Date().toISOString(),
    currentPeriodEnd: new Date(Date.now() + 30 * DAY).toISOString(),
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

/** The provider confirms the page a take opened, free until `trialEnd`. */
const confirm = (started: Started) =>
  deliver(
    "checkout_completed",
    read(started.subscriptionId, {
      status: started.freeUntil ? "trialing" : "active",
      trialEnd: started.freeUntil,
      currentPeriodEnd: started.freeUntil ?? new Date(Date.now() + 30 * DAY).toISOString(),
    }),
  );

async function offer(id: string) {
  return env.DB.prepare("SELECT * FROM core_subscription_offer WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
}

async function count(sql: string, ...binds: unknown[]) {
  const row = await env.DB.prepare(sql)
    .bind(...binds)
    .first<{ n: number }>();
  return Number(row?.n);
}

/** The page a start opened, as the provider was asked for it. */
const pageOf = (subscriptionId: string) =>
  gw.subscriptions.find((s) => s.subscriptionId === subscriptionId);

/** A customer imported with an offer `days` ahead. */
async function moving(days = 20, label = "moving"): Promise<{ buyer: Buyer; offerId: string }> {
  const buyer = await createBuyer(admin, label);
  const { results } = await importOffers([{ email: buyer.email, freeUntil: dateIn(days) }]);
  const offerId = results[0]?.offerId;
  if (!offerId) throw new Error(`not imported: ${JSON.stringify(results)}`);
  return { buyer, offerId };
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
  course = await create(COURSE, { title: "Handstands" });
  await payments.connect(admin.id);
});

beforeEach(() => {
  events = memoryEventSink();
});

describe("the paid-up date", () => {
  it("is the start of that day in the organisation's time zone, or a moment as given", () => {
    expect(paidUpMoment("2026-12-15", "UTC")).toBe("2026-12-15T00:00:00.000Z");
    // Sydney is 11 hours ahead in December: the day starts the evening before, in UTC.
    expect(paidUpMoment("2026-12-15", "Australia/Sydney")).toBe("2026-12-14T13:00:00.000Z");
    expect(paidUpMoment("2026-07-15", "Europe/London")).toBe("2026-07-14T23:00:00.000Z");
    expect(paidUpMoment("2026-12-15T09:30:00+10:00", "UTC")).toBe("2026-12-14T23:30:00.000Z");
    expect(paidUpMoment("2026-12-15T09:30:00.250-05:30", "UTC")).toBe("2026-12-15T15:00:00.250Z");
    // Never rolled forward into extra free days: an impossible day or time is not a date.
    for (const bad of [
      "2026-02-30",
      "15/12/2026",
      "tomorrow",
      "2026-12-15T09:30",
      "",
      "2026-02-30T00:00Z",
      "2026-12-15T24:00Z",
      "2026-12-15T23:60:00Z",
      "2026-12-15T10:00:00+15:00",
      "2026-13-01T00:00Z",
    ]) {
      expect(paidUpMoment(bad, "UTC")).toBeNull();
    }
  });
});

describe("the import", () => {
  it("is a dry run first, matches people by address, never creates one, and a re-run changes nothing", async () => {
    const a = await createBuyer(admin, "imp-a");
    const b = await createBuyer(admin, "imp-b");
    const stranger = `${unique("nobody")}@elsewhere.example`;
    const rows = [
      { email: a.email.toUpperCase(), freeUntil: dateIn(20), reference: "old-1" },
      { email: b.email, freeUntil: dateIn(1) },
      { email: stranger, freeUntil: dateIn(20) },
      { email: "not an address", freeUntil: dateIn(20) },
      { email: `${unique("bad")}@x.example`, freeUntil: "next tuesday" },
      { email: a.email, freeUntil: dateIn(25) },
    ];
    const people = await count("SELECT count(*) AS n FROM core_person");
    const dry = await importOffers(rows, { dryRun: true });
    expect(dry.results.map((r) => [r.outcome, r.note])).toEqual([
      ["created", null],
      ["created", "under_48_hours"],
      ["unmatched", "no person has this address"],
      ["invalid", "not an email address"],
      ["invalid", "the paid-up date is not a real date (YYYY-MM-DD) or moment with its offset"],
      ["invalid", "twice"],
    ]);
    expect(dry.results[0]?.personId).toBe(a.principal.personId);
    expect(
      await count(
        "SELECT count(*) AS n FROM core_subscription_offer WHERE email IN (?, ?)",
        a.email,
        b.email,
      ),
    ).toBe(0);

    const done = await importOffers(rows);
    expect(done.results.map((r) => r.outcome)).toEqual(dry.results.map((r) => r.outcome));
    const first = await offer(String(done.results[0]?.offerId));
    expect(first).toMatchObject({
      email: a.email,
      person_id: a.principal.personId,
      free_until: `${dateIn(20)}T00:00:00.000Z`,
      reference: "old-1",
      imported_by: admin.id,
    });
    // Nobody was created for the stranger, and no offer either.
    expect(await count("SELECT count(*) AS n FROM core_person")).toBe(people);
    expect(
      await count("SELECT count(*) AS n FROM core_subscription_offer WHERE email = ?", stranger),
    ).toBe(0);

    // The same list again: nothing changes.
    const again = await importOffers(rows.slice(0, 2));
    expect(again.results.map((r) => r.outcome)).toEqual(["unchanged", "unchanged"]);
    // A changed date updates an offer not yet taken.
    const moved = await importOffers([
      { email: a.email, freeUntil: dateIn(30), reference: "old-1" },
    ]);
    expect(moved.results[0]).toMatchObject({ outcome: "updated", offerId: first?.id });
    expect((await offer(String(first?.id)))?.free_until).toBe(`${dateIn(30)}T00:00:00.000Z`);
  });

  it("is a person's, with subscriptions:manage: no AI actor, no customer, no member without it", async () => {
    const a = await createBuyer(admin, "imp-who");
    const rows = [{ email: a.email, freeUntil: dateIn(20) }];
    for (const actor of ["assistant", "mcp", "automation", "extension"] as const) {
      expect((await refusal(importOffers(rows, {}, staff({ actor })))).code).toBe("forbidden");
    }
    const member = await createUser("member");
    expect(
      (await refusal(importOffers(rows, {}, context(member, { integrations: runtime })))).code,
    ).toBe("forbidden");
    expect(
      (
        await refusal(
          run(
            "subscription.offer.import",
            { plan: { object: PLAN, id: plan }, rows },
            outside(a.principal),
          ),
        )
      ).code,
    ).toMatch(/forbidden|not_found|unknown/);
    expect(
      await count("SELECT count(*) AS n FROM core_subscription_offer WHERE email = ?", a.email),
    ).toBe(0);
  });

  it("invites the addresses to sign in only when asked, and only with users:manage", async () => {
    const person = await run<{ id: string }>(
      "person.create",
      { emails: [{ email: `${unique("invitee")}@moving.example` }] },
      staff(),
    );
    const email = (
      await env.DB.prepare("SELECT email FROM core_person_emails WHERE person_id = ?")
        .bind(person.id)
        .first<{ email: string }>()
    )?.email as string;
    const rows = [{ email, freeUntil: dateIn(20) }];
    expect((await importOffers(rows)).results[0]?.signIn).toBeNull();
    expect(
      await count("SELECT count(*) AS n FROM core_customer_invite WHERE email = ?", email),
    ).toBe(0);
    const manager = await createUser("member");
    // A member granted subscriptions:manage alone (ADR 0449), not users:manage.
    await env.DB.prepare("UPDATE core_user SET granted_permissions = ? WHERE id = ?")
      .bind(JSON.stringify(["subscriptions:manage"]), manager.id)
      .run();
    // With the grant they import; inviting is users:manage's.
    expect(
      (await importOffers(rows, {}, context(manager, { integrations: runtime }))).results[0]
        ?.outcome,
    ).toBe("unchanged");
    const refused = await refusal(
      importOffers(rows, { invite: true }, context(manager, { integrations: runtime })),
    );
    expect(refused.code).toBe("forbidden");
    const invited = await importOffers(rows, { invite: true });
    expect(invited.results[0]).toMatchObject({ outcome: "unchanged", signIn: "invited" });
    expect(
      await count("SELECT count(*) AS n FROM core_customer_invite WHERE email = ?", email),
    ).toBe(1);
    expect((await importOffers(rows, { invite: true })).results[0]?.signIn).toBe("invited_before");
  });
});

describe("taking an offer", () => {
  it("opens the provider's page free until the paid-up date, with no trial, for its own person only", async () => {
    const { buyer, offerId } = await moving(20, "taker");
    const freeUntil = `${dateIn(20)}T00:00:00.000Z`;
    // Someone else, signed in: not found, whatever the offer is.
    const other = await createBuyer(admin, "other");
    expect((await refusal(take(other, offerId))).code).toBe("not_found");
    // A guest typing the address, or staff for them: never.
    expect(
      (
        await refusal(
          run(
            "subscription.start",
            { plan: { object: PLAN, id: plan }, returnUrl: RETURN, email: buyer.email, offerId },
            outside(PUBLIC, { integrations: runtime, events }),
          ),
        )
      ).details,
    ).toMatchObject({ rule: "offer_sign_in" });
    expect(
      (
        await refusal(
          run(
            "subscription.start",
            { plan: { object: PLAN, id: plan }, returnUrl: RETURN, email: buyer.email, offerId },
            staff(),
          ),
        )
      ).details,
    ).toMatchObject({ rule: "offer_sign_in" });
    // Its own person, signed in as its address.
    const started = await take(buyer, offerId);
    expect(started).toMatchObject({ trialDays: null, freeUntil, noTrial: null });
    const sent = pageOf(started.subscriptionId);
    expect(sent).toMatchObject({ trialEnd: freeUntil, amount: 2900 });
    expect(sent).not.toHaveProperty("trialDays");
    // The same person again while the page is open: that page.
    expect((await take(buyer, offerId)).url).toBe(started.url);

    // The provider confirms: taken by that subscription, holding every course, no trial used.
    await confirm(started);
    expect(await offer(offerId)).toMatchObject({
      subscription_id: started.subscriptionId,
      charged_from_start: 0,
    });
    expect(
      await count(
        "SELECT count(*) AS n FROM core_subscription_trial WHERE holder_person_id = ?",
        buyer.principal.personId,
      ),
    ).toBe(0);
    const object = getObject(COURSE);
    if (!object) throw new Error("no course object");
    expect([
      ...(await holdsAccess({ db: db.query, principal: buyer.principal }, object, [course])),
    ]).toEqual([course]);
    // Nothing was charged: no order for the person.
    expect(
      await count(
        "SELECT count(*) AS n FROM core_order WHERE person_id = ?",
        buyer.principal.personId,
      ),
    ).toBe(0);
    // Used once; and no trial while the subscription from it runs (no cancel-and-restart onto a
    // trial during the continuation).
    expect((await refusal(take(buyer, offerId))).details).toMatchObject({ rule: "offer_taken" });
    expect(await subscribe(buyer)).toMatchObject({ trialDays: null, noTrial: "continuation" });
    await deliver(
      "updated",
      read(started.subscriptionId, {
        status: "trialing",
        trialEnd: started.freeUntil,
        cancelAtPeriodEnd: true,
      }),
    );
    expect(await subscribe(buyer)).toMatchObject({ trialDays: null, noTrial: "continuation" });
    // Not offered to them any more.
    expect(
      (await run<{ offers: unknown[] }>("subscription.offer.mine", {}, as(buyer))).offers,
    ).toEqual([]);
    // Once it has ended, the continuation was not the trial: a returning subscriber gets it once.
    await deliver(
      "deleted",
      read(started.subscriptionId, {
        status: "canceled",
        trialEnd: started.freeUntil,
        endedAt: new Date().toISOString(),
      }),
    );
    expect(await subscribe(buyer)).toMatchObject({ trialDays: 7, noTrial: null });
  });

  it("is the address's: the same Person signed in under another address cannot take it", async () => {
    const { buyer, offerId } = await moving(20, "twoaddr");
    // Their account moves to another address of theirs.
    const second = `${unique("second")}@buyers.example`;
    await env.DB.prepare("UPDATE core_customer SET email = ? WHERE id = ?")
      .bind(second, buyer.principal.customerId)
      .run();
    expect((await refusal(take(buyer, offerId))).code).toBe("not_found");
    expect(
      (await run<{ offers: unknown[] }>("subscription.offer.mine", {}, as(buyer))).offers,
    ).toEqual([]);
  });

  it("gives one page to two takes at once", async () => {
    const { buyer, offerId } = await moving(20, "race");
    const outcomes = await Promise.allSettled([take(buyer, offerId), take(buyer, offerId)]);
    const won = outcomes.filter(
      (o) => o.status === "fulfilled",
    ) as PromiseFulfilledResult<Started>[];
    const held = await offer(offerId);
    if (won.length === 2) {
      expect(new Set(won.map((o) => o.value.subscriptionId)).size).toBe(1);
    } else {
      expect(won).toHaveLength(1);
      const lost = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
      // Refused by the one-page trigger or, read before the first committed, by the version.
      expect(lost.reason).toMatchObject({ code: "conflict" });
      expect(["offer_held", "offer_changed"]).toContain(
        (lost.reason as { details: { rule: string } }).details.rule,
      );
    }
    expect(held?.checkout_id).toBe(won[0]?.value.subscriptionId);
    // The losing take recorded nothing: one checkout names the offer.
    expect(
      await count(
        "SELECT count(*) AS n FROM core_subscription_checkout WHERE offer_id = ?",
        offerId,
      ),
    ).toBe(1);
  });

  it("releases a page only once the provider says it expired; one it says was completed is taken", async () => {
    const { buyer, offerId } = await moving(20, "release");
    const first = await take(buyer, offerId);
    gw.pages.set(String(pageOf(first.subscriptionId)?.ref), "expired");
    const second = await take(buyer, offerId);
    expect(second.subscriptionId).not.toBe(first.subscriptionId);
    expect((await offer(offerId))?.checkout_id).toBe(second.subscriptionId);
    gw.pages.set(String(pageOf(second.subscriptionId)?.ref), "error");
    expect((await refusal(take(buyer, offerId))).details).toMatchObject({
      rule: "offer_unconfirmed",
    });
    gw.pages.set(String(pageOf(second.subscriptionId)?.ref), "complete");
    expect((await refusal(take(buyer, offerId))).details).toMatchObject({ rule: "offer_taken" });
  });

  it("with under 48 hours left is charged at once, with no trial; once the date passes it cannot be taken", async () => {
    const soon = await createBuyer(admin, "soon");
    const at = new Date(Date.now() + OFFER_MIN_FREE_MS - 3_600_000).toISOString();
    const { results } = await importOffers([{ email: soon.email, freeUntil: at }]);
    expect(results[0]).toMatchObject({ outcome: "created", note: "under_48_hours" });
    expect(
      (await run<{ offers: { chargedNow: boolean }[] }>("subscription.offer.mine", {}, as(soon)))
        .offers[0],
    ).toMatchObject({ chargedNow: true });
    const started = await take(soon, String(results[0]?.offerId));
    expect(started).toMatchObject({ trialDays: null, freeUntil: null, noTrial: null });
    expect(pageOf(started.subscriptionId)).not.toHaveProperty("trialEnd");
    await confirm(started);
    expect(await offer(String(results[0]?.offerId))).toMatchObject({
      subscription_id: started.subscriptionId,
      charged_from_start: 1,
    });

    // Taken charged at once: no trial while that subscription runs.
    expect(await subscribe(soon)).toMatchObject({ trialDays: null, noTrial: "continuation" });

    // Past: imported as it is (the report says so) and never taken; the offer expired untaken,
    // so the one-trial rule alone applies (a continuation is not the trial).
    const late = await createBuyer(admin, "late");
    const past = await importOffers([{ email: late.email, freeUntil: dateIn(-3) }]);
    expect(past.results[0]).toMatchObject({ outcome: "created", note: "past" });
    expect((await refusal(take(late, String(past.results[0]?.offerId)))).details).toMatchObject({
      rule: "offer_expired",
    });
    expect(await subscribe(late)).toMatchObject({ trialDays: 7, noTrial: null });
  });

  it("is withdrawn by staff, a person, and then cannot be taken; a taken one cannot be withdrawn", async () => {
    const { buyer, offerId } = await moving(20, "withdrawn");
    for (const actor of ["assistant", "mcp", "automation"] as const) {
      expect(
        (
          await refusal(
            run("subscription.offer.withdraw", { id: offerId, reason: "x" }, staff({ actor })),
          )
        ).code,
      ).toBe("forbidden");
    }
    // While it can be taken, starting without it gives no trial (the offer is their free time).
    expect(await subscribe(buyer)).toMatchObject({ trialDays: null, noTrial: "continuation" });
    await run("subscription.offer.withdraw", { id: offerId, reason: "Not a subscriber" }, staff());
    expect((await refusal(take(buyer, offerId))).details).toMatchObject({
      rule: "offer_withdrawn",
    });
    // Withdrawn: no longer a continuing subscriber, so the plan's trial is theirs.
    expect(await subscribe(buyer)).toMatchObject({ trialDays: 7, noTrial: null });

    const taken = await moving(20, "taken");
    await confirm(await take(taken.buyer, taken.offerId));
    expect(
      (
        await refusal(
          run("subscription.offer.withdraw", { id: taken.offerId, reason: "x" }, staff()),
        )
      ).details,
    ).toMatchObject({ rule: "offer_taken" });
  });

  it("withdrawn while its page was open and completed anyway: taken, and staff are told", async () => {
    const { buyer, offerId } = await moving(20, "late-withdraw");
    const started = await take(buyer, offerId);
    const out = await run<{ pageOpen: boolean }>(
      "subscription.offer.withdraw",
      { id: offerId, reason: "Mistake" },
      staff(),
    );
    expect(out.pageOpen).toBe(true);
    await confirm(started);
    expect((await offer(offerId))?.subscription_id).toBe(started.subscriptionId);
    const { results } = await env.DB.prepare(
      "SELECT title FROM core_notifications WHERE user_id = ? AND title = ?",
    )
      .bind(admin.id, "A withdrawn continuation offer was taken")
      .all();
    expect(results).toHaveLength(1);
  });
});

describe("the report", () => {
  it("lists who took their offer and when they are charged from, and who has not", async () => {
    const taken = await moving(20, "rep-taken");
    const started = await take(taken.buyer, taken.offerId);
    await confirm(started);
    const open = await moving(25, "rep-open");
    const takenPage = await run<{
      items: { id: string; chargesFrom: string | null; status: string; subscriptionId: string }[];
      counts: Record<string, number>;
    }>("subscription.offer.list", { status: "taken", limit: 200 }, staff());
    const row = takenPage.items.find((i) => i.id === taken.offerId);
    expect(row).toMatchObject({
      status: "taken",
      subscriptionId: started.subscriptionId,
      chargesFrom: `${dateIn(20)}T00:00:00.000Z`,
    });
    expect(takenPage.items.every((i) => i.status === "taken")).toBe(true);
    const openPage = await run<{ items: { id: string; status: string }[] }>(
      "subscription.offer.list",
      { status: "open", limit: 200 },
      staff(),
    );
    expect(openPage.items.map((i) => i.id)).toContain(open.offerId);
    expect(openPage.items.map((i) => i.id)).not.toContain(taken.offerId);
    expect(takenPage.counts.taken).toBeGreaterThanOrEqual(1);
    expect(takenPage.counts.open).toBeGreaterThanOrEqual(1);

    // Paged by address: every offer once.
    const all: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await run<{ items: { id: string }[]; nextCursor: string | null }>(
        "subscription.offer.list",
        { limit: 2, ...(cursor ? { cursor } : {}) },
        staff(),
      );
      all.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(await count("SELECT count(*) AS n FROM core_subscription_offer"));

    const csv = await run<{ csv: string; rowCount: number }>(
      "subscription.offer.export",
      { status: "taken" },
      staff(),
    );
    const lines = csv.csv.trim().split("\n");
    expect(lines[0]).toMatch(/^email,name,reference,paid_up_to,status,taken_at,charges_from/);
    expect(lines.find((l) => l.startsWith(taken.buyer.email))).toContain(started.subscriptionId);
    expect(csv.rowCount).toBe(lines.length - 1);
    // A member without subscriptions:manage reads none of it.
    const member = await createUser("member");
    expect((await refusal(run("subscription.offer.list", {}, context(member)))).code).toBe(
      "forbidden",
    );
  });
});

describe("a person merge and an erasure", () => {
  it("moves an offer to the survivor; erasing the person deletes it", async () => {
    const { buyer, offerId } = await moving(20, "merged");
    const survivor = await run<{ id: string }>(
      "person.create",
      { givenName: "Survivor", emails: [{ email: `${unique("surv")}@moving.example` }] },
      staff(),
    );
    await run(
      "person.merge",
      { survivorId: survivor.id, mergedId: buyer.principal.personId },
      staff(),
    );
    expect((await offer(offerId))?.person_id).toBe(survivor.id);
    await run("person.erase", { id: survivor.id }, staff());
    expect(await offer(offerId)).toBeNull();
  });
});

describe("review of step 4", () => {
  it("corrects an offer whose page was abandoned: the provider's word releases it, and an unanswered ask is reported", async () => {
    const { buyer, offerId } = await moving(20, "abandoned");
    const first = await take(buyer, offerId);
    const ref = String(pageOf(first.subscriptionId)?.ref);
    const row = [{ email: buyer.email, freeUntil: dateIn(25) }];
    // Still open at the provider: held, kept.
    expect((await importOffers(row)).results[0]).toMatchObject({
      outcome: "conflict",
      note: "held",
    });
    // The provider cannot be asked: held, not known to be closed.
    gw.pages.set(ref, "error");
    expect((await importOffers(row)).results[0]).toMatchObject({
      outcome: "conflict",
      note: "held_unconfirmed",
    });
    // Expired uncompleted: released, and the correction is written.
    gw.pages.set(ref, "expired");
    expect((await importOffers(row, { dryRun: true })).results[0]?.outcome).toBe("updated");
    expect((await offer(offerId))?.checkout_id).toBe(first.subscriptionId);
    expect((await importOffers(row)).results[0]).toMatchObject({ outcome: "updated" });
    expect(await offer(offerId)).toMatchObject({
      checkout_id: null,
      free_until: `${dateIn(25)}T00:00:00.000Z`,
    });
    // Taken again: the new date.
    const second = await take(buyer, offerId);
    expect(second.freeUntil).toBe(`${dateIn(25)}T00:00:00.000Z`);
    // The report shows the page as the provider says it is.
    const listed = await run<{ items: { id: string; page: string | null }[] }>(
      "subscription.offer.list",
      { status: "open", limit: 200 },
      staff(),
    );
    expect(listed.items.find((i) => i.id === offerId)?.page).toBe("open");
    // A withdrawal says whether a page may still be completed, from the provider's word.
    gw.pages.set(String(pageOf(second.subscriptionId)?.ref), "expired");
    expect(
      await run("subscription.offer.withdraw", { id: offerId, reason: "Moved" }, staff()),
    ).toMatchObject({ pageOpen: false });
  });

  it("reissues a withdrawn address only when staff ask for it, recorded; the withdrawn offer stays", async () => {
    const { buyer, offerId } = await moving(20, "reissue");
    await run("subscription.offer.withdraw", { id: offerId, reason: "By mistake" }, staff());
    const row = [{ email: buyer.email, freeUntil: dateIn(20) }];
    expect((await importOffers(row)).results[0]).toMatchObject({
      outcome: "conflict",
      note: "withdrawn",
      offerId,
    });
    const again = await importOffers(row, { reissue: true });
    const fresh = again.results[0]?.offerId as string;
    expect(again.results[0]).toMatchObject({ outcome: "created", note: "reissued" });
    expect(fresh).not.toBe(offerId);
    expect(await offer(offerId)).toMatchObject({ reissued_as: fresh });
    expect((await offer(offerId))?.withdrawn_at).not.toBeNull();
    const changes = await env.DB.prepare(
      "SELECT c.diff FROM core_audit_changes c JOIN core_audit a ON a.id = c.audit_id WHERE c.record_id = ? AND a.operation = 'subscription.offer.import'",
    )
      .bind(fresh)
      .all<{ diff: string }>();
    expect(changes.results.map((c) => JSON.parse(c.diff).reissuedFrom?.after)).toEqual([offerId]);
    // The fresh one is takeable; the withdrawn one is not.
    expect((await refusal(take(buyer, offerId))).details).toMatchObject({
      rule: "offer_withdrawn",
    });
    expect((await take(buyer, fresh)).freeUntil).toBe(`${dateIn(20)}T00:00:00.000Z`);
    // A re-run with reissue makes no third offer.
    expect((await importOffers(row, { reissue: true })).results[0]).toMatchObject({
      outcome: "unchanged",
      offerId: fresh,
    });
  });

  it("refuses an impossible moment with the row, never rolled forward", async () => {
    const a = await createBuyer(admin, "moment");
    const { results } = await importOffers([{ email: a.email, freeUntil: "2026-02-30T00:00Z" }]);
    expect(results[0]?.outcome).toBe("invalid");
  });

  it("commits a take only on the offer as it read it, and an import only on the offer as it read it", async () => {
    for (let i = 0; i < 3; i += 1) {
      const { buyer, offerId } = await moving(20, `race${i}`);
      const outcomes = await Promise.allSettled([
        take(buyer, offerId),
        importOffers([{ email: buyer.email, freeUntil: dateIn(30) }]),
      ]);
      for (const o of outcomes) {
        if (o.status === "rejected") expect(o.reason).toMatchObject({ code: "conflict" });
      }
      // Whatever won, a page held from the offer is for the date the offer has now.
      const now = await offer(offerId);
      if (now?.checkout_id) {
        const checkout = await env.DB.prepare(
          "SELECT trial_end FROM core_subscription_checkout WHERE id = ?",
        )
          .bind(now.checkout_id)
          .first<{ trial_end: string }>();
        expect(checkout?.trial_end).toBe(now.free_until);
      }
    }
    // Two imports at once: never both written over each other unseen.
    const { buyer } = await moving(20, "twoimports");
    const both = await Promise.allSettled([
      importOffers([{ email: buyer.email, freeUntil: dateIn(31) }]),
      importOffers([{ email: buyer.email, freeUntil: dateIn(32) }]),
    ]);
    for (const o of both) {
      if (o.status === "rejected") {
        expect(o.reason).toMatchObject({ code: "conflict", details: { rule: "offer_changed" } });
      }
    }
  });

  it("refuses a write from an older read of the offer, and records nothing of it", async () => {
    const { offerId } = await moving(20, "stale");
    const version = Number((await offer(offerId))?.version);
    // Another change lands first (as a take or a withdrawal would).
    await env.DB.prepare(
      "UPDATE core_subscription_offer SET reference = 'meanwhile', version = version + 1 WHERE id = ?",
    )
      .bind(offerId)
      .run();
    // A write made from the older read is refused by the database.
    await expect(
      env.DB.prepare("UPDATE core_subscription_offer SET free_until = ?, version = ? WHERE id = ?")
        .bind(new Date(Date.now() + 90 * DAY).toISOString(), version + 1, offerId)
        .run(),
    ).rejects.toThrow(/core_subscription_offer_stale/);
    expect((await offer(offerId))?.reference).toBe("meanwhile");
    // A take prepared before that change: its hold is written at the version it read, and the
    // database refuses it, so the page it opened (on the old terms) is never handed out.
    const hold = holdOfferStatements({ db: db.query, now: new Date().toISOString() } as never, {
      offerId,
      releaseCheckoutId: null,
      version,
      checkoutId: "sbs_stale_take",
      checkoutRef: "fcs_stale_take",
      url: "https://pay.example/stale",
      expiresAt: null,
    });
    await expect(db.batch(hold)).rejects.toThrow(/core_subscription_offer_stale/);
    expect((await offer(offerId))?.checkout_id).toBeNull();
  });

  it("records each invite the import writes, and a dry run predicts an address that cannot be invited", async () => {
    const ok = await run<{ id: string }>(
      "person.create",
      { emails: [{ email: `${unique("inv")}@moving.example` }] },
      staff(),
    );
    const blocked = await run<{ id: string }>(
      "person.create",
      { emails: [{ email: `${unique("erased")}@moving.example` }] },
      staff(),
    );
    const emailOf = async (id: string) =>
      (
        await env.DB.prepare("SELECT email FROM core_person_emails WHERE person_id = ?")
          .bind(id)
          .first<{ email: string }>()
      )?.email as string;
    const good = await emailOf(ok.id);
    const bad = await emailOf(blocked.id);
    // The address is on the erased list (an earlier person with it was erased).
    await env.DB.prepare(
      "INSERT INTO core_erased_address (hash, object_type, erased_at) VALUES (?, 'person', ?)",
    )
      .bind(await erasedAddressHash(bad), new Date().toISOString())
      .run();
    const rows = [
      { email: bad, freeUntil: dateIn(20) },
      { email: good, freeUntil: dateIn(20) },
    ];
    const dry = await importOffers(rows, { dryRun: true, invite: true });
    expect(dry.results.map((r) => r.signIn)).toEqual(["invite_refused", "invited"]);
    const done = await importOffers(rows, { invite: true });
    expect(done.results.map((r) => [r.outcome, r.signIn])).toEqual([
      ["created", "invite_refused"],
      ["created", "invited"],
    ]);
    const recorded = await env.DB.prepare(
      "SELECT object_type FROM core_audit_changes WHERE record_id = ?",
    )
      .bind(good)
      .all<{ object_type: string }>();
    expect(recorded.results.map((r) => r.object_type)).toContain("customer_invite");
  });

  it("keeps the report a person's, counts by status and refuses a cursor it did not give", async () => {
    for (const actor of ["assistant", "mcp", "automation"] as const) {
      for (const name of ["subscription.offer.list", "subscription.offer.export"]) {
        expect((await refusal(run(name, {}, staff({ actor })))).code).toBe("forbidden");
      }
    }
    for (const cursor of ["nope", btoa(JSON.stringify({ x: 1 })), btoa('{"e":1,"i":"a"}')]) {
      expect((await refusal(run("subscription.offer.list", { cursor }, staff()))).code).toBe(
        "invalid_input",
      );
    }
    const { counts } = await run<{ counts: Record<string, number> }>(
      "subscription.offer.list",
      {},
      staff(),
    );
    const { results } = await env.DB.prepare(
      "SELECT subscription_id, withdrawn_at, free_until FROM core_subscription_offer",
    ).all<{ subscription_id: string | null; withdrawn_at: string | null; free_until: string }>();
    const now = new Date().toISOString();
    const by = (f: (r: (typeof results)[number]) => boolean) => results.filter(f).length;
    expect(counts).toEqual({
      taken: by((r) => r.subscription_id !== null),
      withdrawn: by((r) => !r.subscription_id && r.withdrawn_at !== null),
      expired: by((r) => !r.subscription_id && !r.withdrawn_at && r.free_until <= now),
      open: by((r) => !r.subscription_id && !r.withdrawn_at && r.free_until > now),
    });
  });

  it("follows its plan to the only live record when its own is gone; with none or several, ask us, and staff are told", async () => {
    const create = async (name: string) =>
      (
        await run<{ id: string }>(
          "record.create",
          { object: PLAN, values: { name, price: 29, trialDays: 7 } },
          staff(),
        )
      ).id;
    const old = await create("Every course, old");
    const buyer = await createBuyer(admin, "follows");
    const { results } = await run<{ results: { offerId: string }[] }>(
      "subscription.offer.import",
      { plan: { object: PLAN, id: old }, rows: [{ email: buyer.email, freeUntil: dateIn(20) }] },
      staff(),
    );
    const offerId = results[0]?.offerId as string;
    await run("record.delete", { object: PLAN, id: old }, staff());
    // `plan` is the object's only live record: the offer follows to it.
    const mine = await run<{ offers: { id: string; planId: string; askUs: boolean }[] }>(
      "subscription.offer.mine",
      {},
      as(buyer),
    );
    expect(mine.offers.find((o) => o.id === offerId)).toMatchObject({
      planId: plan,
      askUs: false,
    });
    // Another plan record on sale: no single one to follow to. The member asks; staff are told.
    const other = await create("Every course, new");
    try {
      const later = await run<{ offers: { id: string; askUs: boolean }[] }>(
        "subscription.offer.mine",
        {},
        as(buyer),
      );
      expect(later.offers.find((o) => o.id === offerId)?.askUs).toBe(true);
      expect((await refusal(take(buyer, offerId, plan))).details).toMatchObject({
        rule: "offer_plan",
      });
      expect((await sweepSubscriptions(db, new Date().toISOString())).offerPlansGone).toBe(1);
      const { results: told } = await env.DB.prepare(
        "SELECT title FROM core_notifications WHERE user_id = ? AND title = ?",
      )
        .bind(admin.id, "Continuation offers have no plan to be taken on")
        .all();
      expect(told).toHaveLength(1);
    } finally {
      await run("record.delete", { object: PLAN, id: other }, staff());
    }
    // One live record again: it follows, and the take opens free until the date.
    const started = await take(buyer, offerId, plan);
    expect(started.freeUntil).toBe(`${dateIn(20)}T00:00:00.000Z`);
  });
});

describe("the report's bound variables", () => {
  it("lists a full page of untaken offers within D1's 100 bound variables a statement", async () => {
    // More untaken offers, each its own Person's, than one statement may bind: the report reads
    // their running subscriptions in one statement.
    const now = new Date().toISOString();
    const freeUntil = new Date(Date.now() + 20 * DAY).toISOString();
    const people = Array.from({ length: 120 }, () => unique("bulk"));
    await env.DB.batch(
      people.flatMap((id) => [
        env.DB.prepare(
          "INSERT INTO core_person (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)",
        ).bind(id, "Bulk member", now, now),
        env.DB.prepare(
          `INSERT INTO core_subscription_offer
             (id, plan_object, plan_id, email, person_id, free_until, imported_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          `sof_${id}`,
          PLAN,
          plan,
          `${id}@bulk.example.com`.toLowerCase(),
          id,
          freeUntil,
          admin.id,
          now,
          now,
        ),
      ]),
    );
    const page = await run<{ items: { personId: string | null }[] }>(
      "subscription.offer.list",
      { status: "open", limit: 200 },
      staff(),
    );
    expect(page.items.filter((i) => i.personId && people.includes(i.personId))).toHaveLength(120);
  });
});
