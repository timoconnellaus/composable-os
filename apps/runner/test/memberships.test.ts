// Stage 32b, build step 6: the Memberships pack (packs/memberships) in the real host, beside
// Programs, installed as shipped, with real D1, the real payments gatekeeper and its fake
// provider. Its holders are spent by a fixture spender with stage 31's ids (`bookings.booking`,
// packs/memberships/test/fixtures/bookings): when the Bookings pack lands, this test moves to it.
//
// What is checked: the pack installs only beside Programs and its holders' conditions hold
// against the spender at install; a member subscribes to a membership plan on the fake provider's
// page and the provider's verified events grant the membership, which a booking spends (3 a
// week, by class type and off-peak window); a member buys a class pack, which is granted with its
// expiry and spent; the intro offer is one per person through the pack's own tool (a second
// refused, a guest refused); giving a pass by hand is a person's (the assistant is refused);
// voiding one staff gave.
import { env, exports } from "cloudflare:workers";
import {
  type ActingUser,
  type CustomerPrincipal,
  type ExtensionHost,
  getObject,
  type InvocationContext,
  invokeByName,
  type OutsideInvocationContext,
  refreshSchemaRegistry,
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
  memberships: packFiles(
    import.meta.glob<string>("../../../packs/memberships/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ),
  bookings: packFiles(
    import.meta.glob<string>("../../../packs/memberships/test/fixtures/bookings/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ),
};
const OURS = new Set(Object.keys(files));

/** The extension host of a deployment whose product lists Programs and Memberships. */
const shippedHost: ExtensionHost = {
  ...host,
  shipped: async () => [
    ...(await host.shipped()).filter((s) => !OURS.has(s.id)),
    { id: "programs", version: "0.1.0" },
    { id: "memberships", version: "0.1.0" },
    { id: "bookings", version: "0.0.1" },
  ],
  commitShipped: (id) =>
    OURS.has(id)
      ? host.commit({
          id,
          files: files[id] as Record<string, string>,
          message: `Shipped ${id}`,
          author: { name: "Composable OS", email: "release@composableos.dev" },
        })
      : host.commitShipped(id),
};

const integrations = integrationRuntime(env);
const runner = exports.default as unknown as {
  gatekeeperFetch(vendor: string, request: Request): Promise<Response>;
};
const RETURN = "https://gym.test/account";
const PLAN = "memberships.plan";
const MEMBERSHIP = "memberships.membership";
const PASSTYPE = "memberships.passtype";
const PASS = "memberships.pass";
const CLASS = "bookings.class";
const BOOKING = "bookings.booking";
const ZONE = "Australia/Sydney";

let admin: ActingUser;
const staff = (user: ActingUser, extra: Partial<InvocationContext> = {}): InvocationContext => ({
  actor: "human",
  user,
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
const as = (principal: CustomerPrincipal) =>
  ({ principal, db, integrations, extensionHost: shippedHost }) as OutsideInvocationContext;

function run<T = Record<string, unknown>>(
  name: string,
  input: unknown,
  ctx: InvocationContext | OutsideInvocationContext,
): Promise<T> {
  return invokeByName(name, input, ctx) as Promise<T>;
}

async function refusal(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    const e = error as { code?: string; message?: string; details?: Record<string, unknown> };
    return { code: e.code, message: e.message, inner: e.details?.code, details: e.details };
  }
  throw new Error("expected a refusal");
}

const create = async (object: string, values: Record<string, unknown>) =>
  (await run<{ id: string }>("record.create", { object, values }, staff(admin))).id;

async function createMember(label: string): Promise<CustomerPrincipal> {
  const tag = unique(label).toLowerCase();
  const email = `${tag}@members.test`;
  const person = await run<{ id: string }>(
    "person.create",
    { givenName: `Given-${tag}`, emails: [{ email }] },
    staff(admin),
  );
  const customerId = `cus_${tag}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_customer (id, person_id, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
  )
    .bind(customerId, person.id, email, now, now)
    .run();
  return { kind: "customer", customerId, personId: person.id };
}

/** The fake provider's page: pay. */
async function pay(url: string) {
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

/** A class at `hour`:00 Sydney time on the next Tuesday, of `classType`. */
let classCount = 0;
async function classAt(classType: string, hour: number): Promise<string> {
  const now = new Date();
  const days = ((2 - now.getUTCDay() + 7) % 7) + 7; // a Tuesday next week, in UTC
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days));
  // Sydney is UTC+10 or +11: the local hour on that UTC date is hour, give or take the offset.
  const startsAt = new Date(date.getTime() + (hour - 10) * 3_600_000).toISOString();
  classCount += 1;
  return create(CLASS, { name: `Class ${classCount}`, classType, startsAt, zone: ZONE });
}

async function book(member: CustomerPrincipal, klass: string, holder?: string) {
  const id = await create(BOOKING, {
    name: unique("Booking"),
    person: member.personId,
    class: klass,
    ...(holder ? { holder } : {}),
  });
  await run("record.update", { object: BOOKING, id, values: { state: "booked" } }, staff(admin));
  return id;
}

type Holding = {
  id: string;
  kind: string;
  status: string;
  until: string | null;
  live: boolean;
  period: { used: number; left: number | null } | null;
};
const mine = async (member: CustomerPrincipal) =>
  (await run<{ holdings: Holding[] }>("x.memberships.mine", {}, as(member))).holdings;

let yoga: string;
let spin: string;

beforeAll(async () => {
  admin = await createAdmin();
  await setPreset("balanced");
  await refreshSchemaRegistry(db.query);
  // Memberships requires Programs (class types).
  const early = await refusal(
    run("extension.install", { id: "memberships", shipped: true }, staff(admin)),
  );
  expect(JSON.stringify(early)).toContain("requires the programs extension");
  await run("extension.install", { id: "programs", shipped: true }, staff(admin));
  await run("extension.install", { id: "bookings", shipped: true }, staff(admin));
  await run("extension.install", { id: "memberships", shipped: true }, staff(admin));
  await refreshSchemaRegistry(db.query);
  expect(getObject(PLAN)?.sellable?.recurring?.grants?.object).toBe(MEMBERSHIP);
  expect(getObject(PASSTYPE)?.sellable?.onePerPerson).toBe("onePerPerson");
  expect(getObject(MEMBERSHIP)?.allowance).toBeDefined();

  await run("settings.update", { timezone: ZONE }, staff(admin)).catch(() => undefined);
  await run(
    "order.settings.update",
    { currency: "AUD", returnOrigins: ["https://gym.test"] },
    staff(admin),
  );
  await run("integration.setVendor", { vendor: "payments", enabled: true }, staff(admin));
  const payments = await run<{ connection: { id: string } }>(
    "connection.create",
    { vendor: "payments", scope: "org" },
    staff(admin),
  );
  await run(
    "connection.bindResource",
    { id: payments.connection.id, url: "payments://merchant/fake" },
    staff(admin),
  );
  yoga = await create("programs.classtype", { name: "Yoga" });
  spin = await create("programs.classtype", { name: "Spin" });
});

afterAll(async () => {
  await setPreset("balanced");
});

describe("a membership, through the fake provider", () => {
  it("a member subscribes, the provider's events grant the membership, and a booking spends it", async () => {
    const plan = await create(PLAN, {
      title: unique("Three a week "),
      price: 45,
      uses: 3,
      per: "week",
      classTypes: [yoga],
      trialDays: 7,
      status: "on_sale",
    });
    const offered = await run<{ plans: { id: string; uses: number }[] }>(
      "x.memberships.plans",
      {},
      guest,
    );
    expect(offered.plans.find((p) => p.id === plan)?.uses).toBe(3);

    const member = await createMember("joiner");
    const started = await run<{ subscriptionId: string; url: string; trialDays: number }>(
      "subscription.start",
      { plan: { object: PLAN, id: plan }, returnUrl: RETURN },
      as(member),
    );
    expect(started.trialDays).toBe(7);
    // On the provider's page, nothing is theirs yet.
    expect(await mine(member)).toEqual([]);
    await pay(started.url);
    await vi.waitFor(
      async () =>
        expect((await mine(member)).find((h) => h.kind === "membership")?.status).toBe("trialing"),
      { timeout: 20_000 },
    );
    const membership = (await mine(member)).find((h) => h.kind === "membership") as Holding;
    expect(membership.period?.left).toBe(3);

    // A yoga class next week spends one of next week's three; a spin class is not covered.
    const klass = await classAt(yoga, 7);
    const booking = await book(member, klass);
    const spent = await run<{ values: Record<string, unknown> }>(
      "record.get",
      { object: BOOKING, id: booking },
      staff(admin),
    );
    expect(spent.values.holder).toBe(membership.id);
    const nextWeek = await run<{ period: { used: number; left: number } }>(
      "allowance.get",
      {
        object: MEMBERSHIP,
        id: membership.id,
        at: (
          await run<{ values: { startsAt: string } }>(
            "record.get",
            { object: CLASS, id: klass },
            staff(admin),
          )
        ).values.startsAt,
      },
      as(member),
    );
    expect(nextWeek.period).toMatchObject({ used: 1, left: 2 });
    const other = await refusal(book(member, await classAt(spin, 7)));
    expect(other.details).toMatchObject({ rule: "allowance" });

    // Nothing the member writes changes what they hold.
    const theirs = await refusal(
      run("my.update", { object: MEMBERSHIP, id: membership.id, values: { uses: 99 } }, as(member)),
    );
    expect(theirs.code).toBeDefined();
  });
});

describe("passes", () => {
  it("a member buys a class pack: granted with its expiry, spent by bookings, its count shown", async () => {
    const pack = await create(PASSTYPE, {
      title: unique("Five classes "),
      price: 100,
      uses: 5,
      validDays: 60,
      fromMinute: 540,
      untilMinute: 960,
      status: "on_sale",
    });
    const member = await createMember("packer");
    const order = await run<{ id: string; total: number }>(
      "x.memberships.buy",
      { passTypeId: pack },
      as(member),
    );
    expect(order.total).toBe(10000);
    const checkout = await run<{ url: string }>(
      "order.checkout",
      { id: order.id, returnUrl: RETURN },
      as(member),
    );
    await pay(checkout.url);
    await vi.waitFor(
      async () => expect((await mine(member)).find((h) => h.kind === "pass")?.live).toBe(true),
      { timeout: 20_000 },
    );
    const pass = (await mine(member)).find((h) => h.kind === "pass") as Holding;
    expect(pass.period).toMatchObject({ used: 0, left: 5 });
    const days = (Date.parse(pass.until ?? "") - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(59);
    expect(days).toBeLessThan(61);

    // Off-peak: a class at 10:00 is paid for; one at 18:00 is not.
    await book(member, await classAt(spin, 10));
    expect((await mine(member)).find((h) => h.kind === "pass")?.period).toMatchObject({
      used: 1,
      left: 4,
    });
    const late = await refusal(book(member, await classAt(spin, 18)));
    expect(late.details).toMatchObject({ rule: "allowance" });
  });

  it("an intro offer is one per person: the second is refused, and a guest is refused", async () => {
    const intro = await create(PASSTYPE, {
      title: unique("Intro week "),
      price: 20,
      uses: 3,
      validDays: 7,
      onePerPerson: true,
      status: "on_sale",
    });
    const member = await createMember("intro");
    const first = await run<{ id: string }>("x.memberships.buy", { passTypeId: intro }, as(member));
    const checkout = await run<{ url: string }>(
      "order.checkout",
      { id: first.id, returnUrl: RETURN },
      as(member),
    );
    await pay(checkout.url);
    await vi.waitFor(
      async () => expect((await mine(member)).some((h) => h.kind === "pass")).toBe(true),
      { timeout: 20_000 },
    );
    const again = await refusal(run("x.memberships.buy", { passTypeId: intro }, as(member)));
    expect(JSON.stringify(again)).toContain("once_per_person");
    const typed = await refusal(
      run(
        "x.memberships.buy",
        { passTypeId: intro, email: `${unique("someone")}@members.test` },
        guest,
      ),
    );
    expect(JSON.stringify(typed)).toContain("sign_in");
  });

  it("staff give a pass by hand, a person only; void one given by hand", async () => {
    const pack = await create(PASSTYPE, {
      title: unique("Ten classes "),
      price: 180,
      uses: 10,
      validDays: 90,
      status: "on_sale",
    });
    const member = await createMember("given");
    const byAssistant = await refusal(
      run(
        "x.memberships.givePass",
        { personId: member.personId, passTypeId: pack, reason: "Make good" },
        staff(admin, { actor: "assistant", origin: { surface: "assistant" } as never }),
      ),
    );
    expect(byAssistant.code).toBe("forbidden");
    const given = await run<{ passId: string; source: string }>(
      "x.memberships.givePass",
      { personId: member.personId, passTypeId: pack, reason: "Make good", uses: 2 },
      staff(admin),
    );
    expect(given.source).toBe("staff");
    const held = await mine(member);
    expect(held.find((h) => h.id === given.passId)?.period).toMatchObject({ used: 0, left: 2 });
    // Staff cannot set a pass's terms through the generic record operations.
    const direct = await refusal(
      run("record.update", { object: PASS, id: given.passId, values: { uses: 50 } }, staff(admin)),
    );
    expect(direct.code).toBe("invalid_input");
    await run(
      "x.memberships.voidPass",
      { passId: given.passId, reason: "Given in error" },
      staff(admin),
    );
    expect((await mine(member)).find((h) => h.id === given.passId)?.status).toBe("void");
  });
});
