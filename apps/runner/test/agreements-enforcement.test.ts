// Stage 44 step 3 (ADR 0644) on the shipped packs: Programs, Bookings, Memberships, Ticketing and
// Courses in the real host and sandbox, with the real payments gatekeeper and its fake provider.
// The points the packs declare, and every pack path that pays or books asking them:
//   - with nothing attached, a ticket and a course sell exactly as before; with a waiver on
//     `event`, a ticket's guest checkout needs it (criterion 13);
//   - a member is refused a pass (x.memberships.buy), a membership (subscription.start) and a
//     booking (x.bookings.book, a drop-in x.bookings.buy) until they agree; a parent booking a
//     child needs a guardian's acceptance; staff are refused x.bookings.bookFor and
//     x.memberships.givePass for a Person with something due (criterion 1);
//   - a visitor's drop-in carries their acceptances in x.bookings.buy, recorded with the order and
//     no Person, theirs once the verified payment matches the address (criterion 6);
//   - after "agree again" the host still promotes a waiter, an existing booking stays booked and a
//     coach unticks a name; the next booking asks (criterion 3);
//   - an enrolment staff give (x.courses.enrol, record.create) and a ticket made by hand ask as
//     buying one does; undoing a check-in asks nobody; the courses import's enrolments are
//     students moving over and are not asked (issue #281).
// The generic rules (the race, every bump, HTTP, the assistant and MCP) are in
// packages/core/test/agreement-enforcement.test.ts. All text is fixture text.
import { env, exports } from "cloudflare:workers";
import {
  type ActingUser,
  type CustomerPrincipal,
  type ExtensionHost,
  type InvocationContext,
  invokeByName,
  type OutsideInvocationContext,
  refreshSchemaRegistry,
  runWaitlistDue,
} from "@composable-os/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { integrationRuntime } from "../src/integrations/runtime.ts";
import { setPreset } from "./automation-fixture.ts";
import { createAdmin, db, host, unique } from "./helpers.ts";

const packFiles = (glob: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(glob)
      .map(([path, text]) => [path.split("/").pop() as string, text] as const)
      .filter(([name]) => name !== "vitest.config.ts"),
  );
const files: Record<string, Record<string, string>> = {
  programs: packFiles(
    import.meta.glob<string>("../../../packs/programs/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ),
  bookings: packFiles(
    import.meta.glob<string>("../../../packs/bookings/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ),
  memberships: packFiles(
    import.meta.glob<string>("../../../packs/memberships/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ),
  ticketing: packFiles(
    import.meta.glob<string>("../../../packs/ticketing/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ),
  content: packFiles(
    import.meta.glob<string>("../../../packs/content/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ),
  courses: packFiles(
    import.meta.glob<string>("../../../packs/courses/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ),
};
const OURS = new Set(Object.keys(files));
const shippedHost: ExtensionHost = {
  ...host,
  shipped: async () => [
    ...(await host.shipped()).filter((s) => !OURS.has(s.id)),
    ...[...OURS].map((id) => ({ id, version: "0.1.0" })),
  ],
  commitShipped: (id) =>
    files[id]
      ? host.commit({
          id,
          files: files[id] as Record<string, string>,
          message: `Shipped ${id} 0.1.0`,
          author: { name: "Composable OS", email: "release@composableos.dev" },
        })
      : host.commitShipped(id),
};

const integrations = integrationRuntime(env);
const runner = exports.default as unknown as {
  gatekeeperFetch(vendor: string, request: Request): Promise<Response>;
};
const RETURN = "https://gym.test/classes";
const HOUR = 3_600_000;
const CLASS = "bookings.class";
const BOOKING = "bookings.booking";
const PLAN = "memberships.plan";
const PASSTYPE = "memberships.passtype";

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
const run = <T = Record<string, unknown>>(
  name: string,
  input: unknown,
  ctx: InvocationContext | OutsideInvocationContext,
) => invokeByName(name, input, ctx) as Promise<T>;
const create = async (object: string, values: Record<string, unknown>) =>
  (await run<{ id: string }>("record.create", { object, values }, staff())).id;
const get = async (object: string, id: string) =>
  (await run<{ values: Record<string, unknown> }>("record.get", { object, id }, staff())).values;

/**
 * A refusal, as the host's own: a pack tool's call the host refused comes back as the tool's
 * error, carrying the host's code and details inside (`extension_error`).
 */
async function refusal(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    const e = error as { code?: string; message?: string; details?: Record<string, unknown> };
    const inner = e.code === "extension_error" ? (e.details ?? {}) : null;
    return {
      code: inner ? (inner.code as string | undefined) : e.code,
      message: e.message,
      details: ((inner ? inner.details : e.details) ?? {}) as Record<string, unknown>,
    };
  }
  throw new Error("expected a refusal");
}
const dueIds = (error: { details: Record<string, unknown> }) =>
  ((error.details.documents ?? []) as { documentId: string }[]).map((d) => d.documentId).sort();

interface Member {
  principal: CustomerPrincipal;
  email: string;
}
async function member(label: string): Promise<Member> {
  const tag = unique(label).toLowerCase();
  const email = `${tag}@agree.test`;
  const person = await run<{ id: string }>(
    "person.create",
    { givenName: `Given-${tag}`, emails: [{ email }] },
    staff(),
  );
  const customerId = `cus_${tag}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_customer (id, person_id, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
  )
    .bind(customerId, person.id, email, now, now)
    .run();
  return { principal: { kind: "customer", customerId, personId: person.id }, email };
}
const visitor = () => `${unique("visitor")}@agree.test`.toLowerCase();

const body = (text: string) => ({
  blocks: [{ type: "paragraph", content: [{ type: "text", text }] }],
});
interface Doc {
  id: string;
  versionId: string;
  kind: string;
}
async function publish(kind: "terms" | "waiver" | "health", points: string[]): Promise<Doc> {
  const { id } = await run<{ id: string }>(
    "agreement.create",
    { title: unique(`Fixture ${kind}`), kind },
    staff(),
  );
  const saved = await run<{ hash: string; rev: number }>(
    "agreement.draft.save",
    {
      id,
      body: body("Fixture text: not a real document."),
      tickLabel: "I have read this fixture",
      ...(kind === "health"
        ? { questions: [{ key: "q1", text: "Fixture question?", noteOnYes: false }] }
        : {}),
    },
    staff(),
  );
  const { version } = await run<{ version: { id: string } }>(
    "agreement.publish",
    { documentId: id, draftHash: saved.hash, draftRev: saved.rev, number: 1, change: "small" },
    staff(),
  );
  if (points.length) await run("agreement.attach", { documentId: id, points }, staff());
  return { id, versionId: version.id, kind };
}
async function agreeAgain(doc: Doc): Promise<void> {
  const saved = await run<{ hash: string; rev: number }>(
    "agreement.draft.save",
    { id: doc.id, body: body(unique("Fixture text, changed")) },
    staff(),
  );
  const got = await run<{ versions: unknown[] }>("agreement.get", { id: doc.id }, staff());
  const { version } = await run<{ version: { id: string } }>(
    "agreement.publish",
    {
      documentId: doc.id,
      draftHash: saved.hash,
      draftRev: saved.rev,
      number: got.versions.length + 1,
      change: "agree_again",
    },
    staff(),
  );
  doc.versionId = version.id;
}
const answersFor = (doc: Doc) =>
  doc.kind === "health" ? { answers: [{ key: "q1", yes: false }] } : {};
const accept = (who: Member, doc: Doc, forPersonId?: string) =>
  run(
    "me.agreements.accept",
    {
      versionId: doc.versionId,
      typedName: "Fixture Name",
      ...(forPersonId ? { forPersonId } : {}),
      ...answersFor(doc),
    },
    as(who.principal),
  );
const guestAgrees = (docs: Doc[]) =>
  docs.map((d) => ({ versionId: d.versionId, typedName: "Fixture Visitor", ...answersFor(d) }));

async function klass(type: string, startsIn: number, places = 10): Promise<string> {
  const startsAt = new Date(Date.now() + startsIn).toISOString();
  return create(CLASS, {
    classType: type,
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + HOUR).toISOString(),
    timezone: "UTC",
    places,
  });
}

async function payUrl(url: string) {
  const paid = await runner.gatekeeperFetch(
    "payments",
    new Request(url, {
      method: "POST",
      body: new URLSearchParams({ outcome: "pay" }),
      redirect: "manual",
    }),
  );
  expect(paid.status).toBe(303);
}

let yoga: string;
let passType: string;
let plan: string;
let waiver: Doc;
let terms: Doc;
let health: Doc;

beforeAll(async () => {
  admin = await createAdmin();
  await setPreset("balanced");
  await refreshSchemaRegistry(db.query);
  for (const id of ["programs", "bookings", "memberships", "ticketing", "content", "courses"]) {
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
  yoga = await create("programs.classtype", { name: unique("Yoga"), "bookings.dropInPrice": 20 });
  passType = await create(PASSTYPE, {
    title: unique("Ten classes "),
    price: 100,
    uses: 10,
    validDays: 60,
    status: "on_sale",
  });
  plan = await create(PLAN, {
    title: unique("Unlimited "),
    price: 50,
    uses: 30,
    per: "month",
    status: "on_sale",
  });
}, 180_000);

describe("the points the packs declare", () => {
  it("memberships, passes, bookings, tickets and courses each mark theirs", async () => {
    const { items } = await run<{
      items: { point: string; objects: string[]; inlineStep: boolean }[];
    }>("agreement.points", {}, staff());
    const at = (point: string) => [...(items.find((p) => p.point === point)?.objects ?? [])].sort();
    expect(at("membership")).toEqual(["memberships.pass", PASSTYPE, PLAN].sort());
    expect(at("booking")).toEqual([BOOKING]);
    expect(at("event")).toEqual(["ticketing.ticket", "ticketing.tickettype"]);
    expect(at("course")).toEqual([
      "courses.bundle",
      "courses.course",
      "courses.enrolment",
      "courses.plan",
    ]);
    // Stage 44 step 5: Memberships' and Bookings' screens let a person agree on the way;
    // Ticketing's and Courses' do not yet, so the admin is warned when attaching there.
    const inline = (point: string) => items.find((p) => p.point === point)?.inlineStep;
    expect([inline("membership"), inline("booking")]).toEqual([true, true]);
    expect([inline("event"), inline("course")]).toEqual([false, false]);
  });
});

describe("Ticketing and Courses sell as before with nothing attached (criterion 13)", () => {
  it("a ticket and a course sell to a guest; a waiver on `event` makes the ticket's guest checkout need it", async () => {
    const event = await create("ticketing.event", { name: unique("Open day"), places: 50 });
    await run(
      "record.update",
      { object: "ticketing.event", id: event, values: { status: "on_sale" } },
      staff(),
    );
    const type = await create("ticketing.tickettype", { event, name: unique("Entry"), price: 15 });
    const buyTicket = (extra: Record<string, unknown> = {}) =>
      run<{ id: string }>(
        "x.ticketing.orderStart",
        { lines: [{ ticketTypeId: type, quantity: 1 }], email: visitor(), ...extra },
        guest,
      );
    expect((await buyTicket()).id).toMatch(/^ord_/);
    const course = await create("courses.course", { title: unique("Basics"), price: 30 });
    await run("record.publish", { object: "courses.course", id: course }, staff());
    expect(
      (await run<{ id: string }>("x.courses.buy", { courseId: course, email: visitor() }, guest))
        .id,
    ).toMatch(/^ord_/);

    const eventWaiver = await publish("waiver", ["event"]);
    try {
      const refused = await refusal(buyTicket());
      expect(refused.details.rule).toBe("agreements_due");
      expect(dueIds(refused)).toEqual([eventWaiver.id]);
      const bought = await buyTicket({ agreements: guestAgrees([eventWaiver]) });
      const rows = await env.DB.prepare(
        "SELECT by, person_id FROM core_agreement_acceptance WHERE order_id = ?",
      )
        .bind(bought.id)
        .all<{ by: string; person_id: string | null }>();
      expect(rows.results).toEqual([{ by: "guest", person_id: null }]);
      // What a visitor typed never reaches the audit log, from the tool or the order.
      const audit = await env.DB.prepare(
        "SELECT input FROM core_audit WHERE operation IN ('x.ticketing.orderStart', 'order.start') AND input LIKE '%Fixture Visitor%'",
      ).all();
      expect(audit.results).toEqual([]);
    } finally {
      await run("agreement.retire", { documentId: eventWaiver.id }, staff());
    }
  });
});

describe("no way round on the shipped packs (criterion 1)", () => {
  beforeAll(async () => {
    // The criterion's fixture: a waiver and terms at `membership`; the waiver and a health form
    // at `booking`.
    waiver = await publish("waiver", ["membership", "booking"]);
    terms = await publish("terms", ["membership"]);
    health = await publish("health", ["booking"]);
  }, 60_000);

  it("a member is refused a pass, a membership, a booking and a drop-in until they agree", async () => {
    const m = await member("joiner");
    const pass = await refusal(run("x.memberships.buy", { passTypeId: passType }, as(m.principal)));
    expect(pass.details.rule).toBe("agreements_due");
    expect(dueIds(pass)).toEqual([waiver.id, terms.id].sort());
    const sub = await refusal(
      run(
        "subscription.start",
        { plan: { object: PLAN, id: plan }, returnUrl: RETURN },
        as(m.principal),
      ),
    );
    expect(sub.details.rule).toBe("agreements_due");
    const id = await klass(yoga, 5 * HOUR);
    const booked = await refusal(run("x.bookings.book", { classId: id }, as(m.principal)));
    expect(booked.details.rule).toBe("agreements_due");
    expect(dueIds(booked)).toEqual([waiver.id, health.id].sort());
    const dropIn = await refusal(run("x.bookings.buy", { classId: id }, as(m.principal)));
    expect(dropIn.details.rule).toBe("agreements_due");
    expect(await get(CLASS, id)).toMatchObject({ held: 0, taken: 0 });

    await accept(m, waiver);
    await accept(m, terms);
    expect(
      (await run<{ id: string }>("x.memberships.buy", { passTypeId: passType }, as(m.principal)))
        .id,
    ).toMatch(/^ord_/);
    const started = await run<{ url: string }>(
      "subscription.start",
      { plan: { object: PLAN, id: plan }, returnUrl: RETURN },
      as(m.principal),
    );
    expect(started.url).toBeTruthy();
    // The booking point still asks for the health form.
    expect(dueIds(await refusal(run("x.bookings.book", { classId: id }, as(m.principal))))).toEqual(
      [health.id],
    );
    await accept(m, health);
    const bought = await run<{ result: string }>(
      "x.bookings.buy",
      { classId: id },
      as(m.principal),
    );
    expect(bought.result).toBe("pending");
  });

  it("a parent books a linked child only with a guardian's acceptance for the child", async () => {
    const parent = await member("parent");
    for (const doc of [waiver, health]) await accept(parent, doc);
    const child = (
      await run<{ id: string }>("person.create", { givenName: unique("Kid") }, staff())
    ).id;
    await run(
      "person.link.add",
      { guardianId: parent.principal.personId, dependantId: child },
      staff(),
    );
    const id = await klass(yoga, 5 * HOUR);
    const refused = await refusal(
      run("x.bookings.buy", { classId: id, forPersonId: child }, as(parent.principal)),
    );
    expect(refused.details.rule).toBe("agreements_due");
    for (const doc of [waiver, health]) await accept(parent, doc, child);
    const bought = await run<{ result: string; bookingId: string }>(
      "x.bookings.buy",
      { classId: id, forPersonId: child },
      as(parent.principal),
    );
    expect(bought.result).toBe("pending");
    expect((await get(BOOKING, bought.bookingId)).person).toBe(child);
  });

  it("staff are refused a booking and a pass by hand for a Person with something due", async () => {
    const m = await member("desk");
    const id = await klass(yoga, 5 * HOUR);
    const desk = await refusal(
      run("x.bookings.bookFor", { classId: id, personId: m.principal.personId }, staff()),
    );
    expect(desk.details.rule).toBe("agreements_due");
    const given = await refusal(
      run(
        "x.memberships.givePass",
        { personId: m.principal.personId, passTypeId: passType, reason: "Fixture reason" },
        staff(),
      ),
    );
    expect(given.details.rule).toBe("agreements_due");
    expect(dueIds(given)).toEqual([waiver.id, terms.id].sort());
    // Once agreed (a paper form, recorded by staff), both go through.
    for (const doc of [waiver, terms, health]) {
      await run(
        "agreement.recordPaper",
        {
          personId: m.principal.personId,
          versionId: doc.versionId,
          signedOn: new Date().toISOString().slice(0, 10),
          typedName: "Fixture Name",
          ...answersFor(doc),
        },
        staff(),
      );
    }
    await run(
      "x.memberships.givePass",
      { personId: m.principal.personId, passTypeId: passType, reason: "Fixture reason" },
      staff(),
    );
    const out = await run<{ result: string }>(
      "x.bookings.bookFor",
      { classId: id, personId: m.principal.personId },
      staff(),
    );
    expect(out.result).toBe("booked");
  });
});

describe("a visitor's drop-in (criterion 6)", () => {
  it("needs the acceptances in x.bookings.buy; they are recorded with the order and become the paying Person's", async () => {
    const id = await klass(yoga, 5 * HOUR);
    const email = visitor();
    const refused = await refusal(run("x.bookings.buy", { classId: id, email }, guest));
    expect(refused.details.rule).toBe("agreements_due");
    expect(dueIds(refused)).toEqual([waiver.id, health.id].sort());
    for (const d of refused.details.documents as Record<string, unknown>[]) {
      expect(d).not.toHaveProperty("personId");
    }
    const bought = await run<{ result: string; orderId: string; token: string; total: number }>(
      "x.bookings.buy",
      { classId: id, email, agreements: guestAgrees([waiver, health]) },
      guest,
    );
    expect(bought.result).toBe("pending");
    const rows = async () =>
      (
        await env.DB.prepare(
          "SELECT by, person_id, email FROM core_agreement_acceptance WHERE order_id = ?",
        )
          .bind(bought.orderId)
          .all<{ by: string; person_id: string | null; email: string }>()
      ).results;
    expect(await rows()).toEqual([
      { by: "guest", person_id: null, email },
      { by: "guest", person_id: null, email },
    ]);
    const checkout = await run<{ url: string }>(
      "order.checkout",
      { id: bought.orderId, token: bought.token, returnUrl: RETURN },
      guest,
    );
    await payUrl(checkout.url);
    await vi.waitFor(
      async () => {
        const o = await env.DB.prepare("SELECT state, person_id FROM core_order WHERE id = ?")
          .bind(bought.orderId)
          .first<{ state: string; person_id: string | null }>();
        expect(o?.state).toBe("paid");
        expect(o?.person_id).toBeTruthy();
        for (const row of await rows()) expect(row.person_id).toBe(o?.person_id);
      },
      { timeout: 15_000 },
    );
  });
});

describe("the review of PR #280 on the shipped packs", () => {
  it("a guest's drop-in with a minor's address stands, the child stays due and staff are told", async () => {
    const kid = await member("minordrop");
    await run("agreement.setMinor", { personId: kid.principal.personId, minor: true }, staff());
    const id = await klass(yoga, 5 * HOUR);
    const bought = await run<{ result: string; orderId: string; token: string; bookingId: string }>(
      "x.bookings.buy",
      { classId: id, email: kid.email, agreements: guestAgrees([waiver, health]) },
      guest,
    );
    const checkout = await run<{ url: string }>(
      "order.checkout",
      { id: bought.orderId, token: bought.token, returnUrl: RETURN },
      guest,
    );
    await payUrl(checkout.url);
    await vi.waitFor(
      async () =>
        expect((await get(BOOKING, bought.bookingId)).person).toBe(kid.principal.personId),
      { timeout: 15_000 },
    );
    const notice = await env.DB.prepare(
      "SELECT human_only, body FROM core_notifications WHERE dedupe_key = ? LIMIT 1",
    )
      .bind(`agreement-guest-minor:${bought.orderId}`)
      .first<{ human_only: number; body: string }>();
    expect(notice?.human_only).toBe(1);
    expect(notice?.body).toContain(bought.orderId);
    // Their own booking is still refused: a guardian or a paper form agrees for them.
    const next = await klass(yoga, 5 * HOUR);
    expect(
      (await refusal(run("x.bookings.book", { classId: next }, as(kid.principal)))).details.rule,
    ).toBe("agreements_due");
  });

  it("a guardian's drop-in for a child, paid after it expired, is never honoured", async () => {
    const parent = await member("lateparent");
    for (const doc of [waiver, health]) await accept(parent, doc);
    const child = (
      await run<{ id: string }>("person.create", { givenName: unique("Kid") }, staff())
    ).id;
    await run(
      "person.link.add",
      { guardianId: parent.principal.personId, dependantId: child },
      staff(),
    );
    for (const doc of [waiver, health]) await accept(parent, doc, child);
    const id = await klass(yoga, 5 * HOUR);
    const bought = await run<{ orderId: string; bookingId: string }>(
      "x.bookings.buy",
      { classId: id, forPersonId: child },
      as(parent.principal),
    );
    const checkout = await run<{ url: string }>(
      "order.checkout",
      { id: bought.orderId, returnUrl: RETURN },
      as(parent.principal),
    );
    for (let batch = 0; batch < 20; batch += 1) {
      const swept = await run<{ expired: string[] }>(
        "order.expireDue",
        {},
        staff({ actor: "automation", clock: () => new Date(Date.now() + 16 * 60_000) }),
      );
      if (swept.expired.includes(bought.orderId) || !swept.expired.length) break;
    }
    expect((await get(BOOKING, bought.bookingId)).state).toBe("expired");
    await payUrl(checkout.url);
    await vi.waitFor(
      async () => {
        const late = await run<{ items: { orderId: string }[] }>("order.paidLate", {}, staff());
        expect(late.items.map((i) => i.orderId)).toContain(bought.orderId);
      },
      { timeout: 15_000 },
    );
    const honour = await refusal(run("order.honourLate", { id: bought.orderId }, staff()));
    expect(honour.details).toMatchObject({ rule: "held_gone" });
    expect((await get(BOOKING, bought.bookingId)).state).toBe("expired");
  });
});

describe("agree again is not retroactive (criterion 3)", () => {
  it("the host still promotes a waiter, a booking stays booked, a coach unticks a name; the next booking asks", async () => {
    const a = await member("first");
    const b = await member("waiter");
    for (const who of [a, b]) {
      for (const doc of [waiver, terms, health]) await accept(who, doc);
      await run(
        "x.memberships.givePass",
        { personId: who.principal.personId, passTypeId: passType, reason: "Fixture reason" },
        staff(),
      );
    }
    // A class starting soon enough to tick names, where a is booked; and a full class with a
    // place, later, where a is booked and b waits.
    const soon = await klass(yoga, 30 * 60_000);
    const ticked = await run<{ result: string; bookingId: string }>(
      "x.bookings.book",
      { classId: soon },
      as(a.principal),
    );
    expect(ticked.result).toBe("booked");
    await run("x.bookings.markAttended", { bookingId: ticked.bookingId }, staff());
    const id = await klass(yoga, 6 * HOUR, 1);
    const first = await run<{ result: string; bookingId: string }>(
      "x.bookings.book",
      { classId: id },
      as(a.principal),
    );
    expect(first.result).toBe("booked");
    const waiting = await run<{ result: string; bookingId: string }>(
      "x.bookings.book",
      { classId: id },
      as(b.principal),
    );
    expect(waiting.result).toBe("waiting");

    await agreeAgain(waiver);
    // No way round through a state that already holds the place: a booking made straight into
    // "attended", or one ticked and given to someone else, is a booking for them and asks.
    const straight = await refusal(
      run(
        "record.create",
        {
          object: BOOKING,
          values: { class: soon, person: b.principal.personId, state: "attended" },
        },
        staff(),
      ),
    );
    expect(straight.details.rule).toBe("agreements_due");
    const handed = await refusal(
      run(
        "record.update",
        { object: BOOKING, id: ticked.bookingId, values: { person: b.principal.personId } },
        staff(),
      ),
    );
    expect(handed.details.rule).toBe("agreements_due");
    // A coach unticking a name moves an existing booking, not a new one.
    await run("x.bookings.undoAttended", { bookingId: ticked.bookingId }, staff());
    expect((await get(BOOKING, ticked.bookingId)).state).toBe("booked");
    expect((await get(BOOKING, first.bookingId)).state).toBe("booked");
    // a cancels in time: the host moves the waiter in, whatever is due for them now.
    await run(
      "x.bookings.cancel",
      { bookingId: first.bookingId, confirm: true, expect: "cancelled" },
      as(a.principal),
    );
    // The minute cron's waitlist step moves the first waiter into the place held for them.
    expect(await runWaitlistDue(db)).toMatchObject({ promoted: 1 });
    expect((await get(BOOKING, waiting.bookingId)).state).toBe("booked");
    // Their next booking asks for the new version.
    const next = await klass(yoga, 5 * HOUR);
    expect(
      dueIds(await refusal(run("x.bookings.book", { classId: next }, as(b.principal)))),
    ).toEqual([waiver.id]);
  });
});

describe("staff-given enrolments and hand-made tickets (issue #281)", () => {
  let courseTerms: Doc;
  let eventWaiver: Doc;
  let course: string;
  let event: string;
  let ticketType: string;
  beforeAll(async () => {
    course = await create("courses.course", { title: unique("Given"), price: 30 });
    event = await create("ticketing.event", { name: unique("Hand day"), places: 50 });
    ticketType = await create("ticketing.tickettype", { event, name: unique("Door"), price: 5 });
    courseTerms = await publish("terms", ["course"]);
    eventWaiver = await publish("waiver", ["event"]);
  }, 60_000);
  afterAll(async () => {
    for (const doc of [courseTerms, eventWaiver]) {
      await run("agreement.retire", { documentId: doc.id }, staff());
    }
  });
  const paper = async (who: Member, docs: Doc[]) => {
    for (const doc of docs) {
      await run(
        "agreement.recordPaper",
        {
          personId: who.principal.personId,
          versionId: doc.versionId,
          signedOn: new Date().toISOString().slice(0, 10),
          typedName: "Fixture Name",
          ...answersFor(doc),
        },
        staff(),
      );
    }
  };
  const enrolment = (who: Member, extra: Record<string, unknown> = {}) =>
    run<{ id: string }>(
      "record.create",
      {
        object: "courses.enrolment",
        values: { holder: who.principal.personId, course, source: "staff", ...extra },
      },
      staff(),
    );
  const ticket = (who: Member, state?: string) =>
    run<{ id: string }>(
      "record.create",
      {
        object: "ticketing.ticket",
        values: {
          name: "Fixture ticket",
          tickettype: ticketType,
          event,
          holder: who.principal.personId,
          ...(state ? { state } : {}),
        },
      },
      staff(),
    );

  it("an enrolment staff give asks for the course's documents; the courses import does not", async () => {
    const m = await member("enrolled");
    const enrol = () =>
      run<{ enrolmentId: string }>(
        "x.courses.enrol",
        { personId: m.principal.personId, courseId: course, reason: "Fixture reason" },
        staff(),
      );
    const given = await refusal(enrol());
    expect(given.details.rule).toBe("agreements_due");
    expect(dueIds(given)).toEqual([courseTerms.id]);
    // No way round by hand, nor by calling it imported.
    for (const extra of [{}, { source: "import" }]) {
      expect((await refusal(enrolment(m, extra))).details.rule).toBe("agreements_due");
    }
    // The courses import (record.import, a person's door) is a student moving over.
    const key = unique("old-platform");
    const importOne = (values: Record<string, unknown>) =>
      run<{ results: { id: string | null; outcome: string }[] }>(
        "record.import",
        {
          object: "courses.enrolment",
          records: [
            {
              key,
              values: {
                course,
                source: "import",
                reason: "Imported from the old platform",
                ...values,
              },
            },
          ],
        },
        staff(),
      );
    const imported = await importOne({ holder: m.principal.personId });
    expect(imported.results[0]?.outcome).toBe("created");
    // Only the record it makes: imported again for someone else, or ended and made active again,
    // it is asked (the review of PR #357).
    const other = await member("importedother");
    expect((await refusal(importOne({ holder: other.principal.personId }))).details.rule).toBe(
      "agreements_due",
    );
    expect(
      (await importOne({ holder: m.principal.personId, status: "ended" })).results[0]?.outcome,
    ).toBe("updated");
    expect(
      (await refusal(importOne({ holder: m.principal.personId, status: "active" }))).details.rule,
    ).toBe("agreements_due");

    await paper(m, [courseTerms]);
    const ok = await enrol();
    expect((await get("courses.enrolment", ok.enrolmentId)).status).toBe("active");
    await run(
      "x.courses.endEnrolment",
      { enrolmentId: ok.enrolmentId, reason: "Fixture reason" },
      staff(),
    );
    // Giving access again after "agree again" asks again; ending it asks nobody.
    await agreeAgain(courseTerms);
    const again = await refusal(
      run(
        "record.update",
        { object: "courses.enrolment", id: ok.enrolmentId, values: { status: "active" } },
        staff(),
      ),
    );
    expect(again.details.rule).toBe("agreements_due");
    expect((await get("courses.enrolment", ok.enrolmentId)).status).toBe("ended");
  });

  it("a ticket made by hand asks for its holder; undoing a check-in asks nobody", async () => {
    const m = await member("handticket");
    const other = await member("otherholder");
    for (const state of [undefined, "used"]) {
      const refused = await refusal(ticket(m, state));
      expect(refused.details.rule).toBe("agreements_due");
      expect(dueIds(refused)).toEqual([eventWaiver.id]);
    }
    await paper(m, [eventWaiver]);
    const made = await ticket(m);
    await run(
      "record.update",
      { object: "ticketing.ticket", id: made.id, values: { state: "used" } },
      staff(),
    );
    await agreeAgain(eventWaiver);
    // The same ticket: back to valid without anyone agreeing again.
    await run(
      "record.update",
      { object: "ticketing.ticket", id: made.id, values: { state: "valid" } },
      staff(),
    );
    expect((await get("ticketing.ticket", made.id)).state).toBe("valid");
    // Given to another holder, it is theirs from then and asks for them.
    const handed = await refusal(
      run(
        "record.update",
        {
          object: "ticketing.ticket",
          id: made.id,
          values: { holder: other.principal.personId },
        },
        staff(),
      ),
    );
    expect(handed.details.rule).toBe("agreements_due");
  });
});
