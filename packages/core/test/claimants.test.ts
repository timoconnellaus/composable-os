// Stage 31, build step 2 (ADRs 0501 to 0503), on a fixture class and booking: a booking is a
// capacity claimant (its states hold, take and give back one place on its class, in the
// database); one active booking per Person per class is a declared uniqueness the database
// enforces; and the transition engine keeps a customer inside windows worked out from the class
// (booking opens 7 local days before, closes at the start; a cancel is in time until an hour
// before and late until the start), refuses them a staff-only class type, and resolves their
// "cancel" to on-time or late by the host's clock. Staff are not bound. Orders' claims work as
// before (their own tests). Every clock is injected.
import { env } from "cloudflare:workers";
import { validateManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ActingUser,
  type CustomerPrincipal,
  coreRegistry,
  createInvoker,
  createRecord,
  createRegistry,
  defineOperation,
  invoke,
  loadRecord,
  requireExtensionObject,
  resolveStateRequest,
  updateRecordAsHost,
} from "../src/index.ts";
import { call, declareCustomers, outside } from "./customer-fixtures.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, unique } from "./helpers.ts";

const ext = extId("clm");
const KLASS = `${ext}.klass`;
const BOOKING = `${ext}.booking`;

const STATES = [
  "pending",
  "booked",
  "waiting",
  "attended",
  "cancelled",
  "late_cancelled",
  "expired",
  "left",
];

const fixture = (id: string) =>
  manifest(id, {
    objects: {
      klass: {
        label: "Class",
        plural: "Classes",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          startsAt: { type: "datetime", label: "Starts at" },
          timezone: { type: "timezone", label: "Time zone" },
          places: { type: "number", label: "Places" },
          opensDays: { type: "number", label: "Opens (days before)" },
          closesMinutes: { type: "number", label: "Closes (minutes before)" },
          lateMinutes: { type: "number", label: "Late from (minutes before)" },
          staffOnly: { type: "boolean", label: "Booked by staff only" },
        },
        capacity: { places: "places" },
        public: { read: ["name", "startsAt"] },
      },
      booking: {
        label: "Booking",
        plural: "Bookings",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name" },
          klass: { type: "relation", label: "Class", to: `${id}.klass` },
          person: { type: "relation", label: "Person", to: "person" },
          state: {
            type: "select",
            label: "State",
            options: STATES.map((value) => ({ value, label: value })),
          },
        },
        states: {
          field: "state",
          initial: "booked",
          create: {
            in: { waiting: ["staff", "customer"], pending: ["host"] },
            window: {
              from: { at: "klass.startsAt", daysBefore: "klass.opensDays", zone: "klass.timezone" },
              until: { at: "klass.startsAt", minutesBefore: "klass.closesMinutes" },
            },
            staffOnly: "klass.staffOnly",
          },
          requests: { cancel: ["cancelled", "late_cancelled"] },
          moves: [
            { from: "pending", to: "booked", by: ["host"] },
            { from: "pending", to: "expired", by: ["host"], final: true },
            { from: "waiting", to: "booked", by: ["staff", "host"] },
            { from: "waiting", to: "left", by: ["staff", "customer"], final: true },
            {
              from: "booked",
              to: "cancelled",
              by: ["staff", "customer"],
              final: true,
              window: { until: { at: "klass.startsAt", minutesBefore: "klass.lateMinutes" } },
            },
            {
              from: "booked",
              to: "late_cancelled",
              by: ["staff", "customer"],
              final: true,
              window: {
                from: { at: "klass.startsAt", minutesBefore: "klass.lateMinutes" },
                until: "klass.startsAt",
              },
            },
            { from: "booked", to: "attended", by: ["staff"] },
            { from: "attended", to: "booked", by: ["staff"] },
          ],
        },
        claims: { on: "klass", held: ["pending"], confirmed: ["booked", "attended"] },
        unique: [
          { fields: ["person", "klass"], states: ["pending", "booked", "waiting", "attended"] },
        ],
      },
    },
  });

let admin: ActingUser;
let customer: CustomerPrincipal;
const at = (now: string) => context(admin, { clock: () => new Date(now) });
const NOW = "2026-03-02T00:00:00.000Z";
// Booking for the fixture class (08:00 UTC on 10 March) opens at 08:00 on 3 March.
const OPEN = "2026-03-05T00:00:00.000Z";

async function person(label: string): Promise<string> {
  const tag = unique(label);
  const created = await invoke(
    "person.create",
    { givenName: tag, emails: [{ email: `${tag}@claims.example` }] },
    context(admin),
  );
  return created.id as string;
}

async function klass(values: Record<string, unknown> = {}) {
  const created = await invoke(
    "record.create",
    {
      object: KLASS,
      values: {
        name: unique("Class"),
        startsAt: "2026-03-10T08:00:00.000Z",
        timezone: "UTC",
        places: 10,
        opensDays: 7,
        closesMinutes: 0,
        lateMinutes: 60,
        staffOnly: false,
        ...values,
      },
    },
    at(NOW),
  );
  return created.id as string;
}

async function book(
  klassId: string,
  personId: string,
  values: Record<string, unknown> = {},
  now = NOW,
) {
  const created = await invoke(
    "record.create",
    { object: BOOKING, values: { klass: klassId, person: personId, ...values } },
    at(now),
  );
  return created.id as string;
}

async function counter(id: string) {
  return env.DB.prepare(
    "SELECT places, held, taken FROM core_capacity WHERE object_type = ? AND record_id = ?",
  )
    .bind(KLASS, id)
    .first();
}

async function state(id: string) {
  const record = await invoke("record.get", { object: BOOKING, id }, context(admin));
  return (record.values as Record<string, unknown>).state;
}

async function refused(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).not.toBeNull();
  return error as { code: string; details: Record<string, unknown>; message: string };
}

// Host writes are platform code's: fixture operations stand in for a paid order or an expiry
// (stage 31's step 8 declares them), and for a pack tool's dry run of a member's "cancel".
const hostCreate = defineOperation({
  name: "fixture.hostCreate",
  description: "Test fixture: creates a record as the host.",
  input: z.object({ object: z.string(), values: z.record(z.string(), z.unknown()) }),
  output: z.object({ id: z.string() }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    return {
      id: await createRecord(ctx, requireExtensionObject(input.object), input.values, {
        by: "host",
      }),
    };
  },
});
const hostUpdate = defineOperation({
  name: "fixture.hostUpdate",
  description: "Test fixture: moves a record as the host.",
  input: z.object({
    object: z.string(),
    id: z.string(),
    values: z.record(z.string(), z.unknown()),
  }),
  output: z.object({ ok: z.boolean() }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    await updateRecordAsHost(ctx, input.object, input.id, input.values);
    return { ok: true };
  },
});
const preview = defineOperation({
  name: "fixture.previewRequest",
  description: "Test fixture: the state a customer's requested move would enter now.",
  input: z.object({ id: z.string(), request: z.string() }),
  output: z.object({ state: z.unknown() }),
  permission: "records:read",
  risk: "read",
  async handler(input, ctx) {
    const object = requireExtensionObject(BOOKING);
    const record = await loadRecord(ctx, object, input.id);
    const values = await resolveStateRequest(
      ctx,
      object,
      record?.values ?? null,
      { state: input.request },
      "customer",
    );
    return { state: values.state };
  },
});
const fixtures = createInvoker(
  createRegistry([...coreRegistry.list(), hostCreate, hostUpdate, preview]),
);
const asHost = {
  create: async (values: Record<string, unknown>) =>
    (
      (await fixtures.invoke("fixture.hostCreate", { object: BOOKING, values }, at(NOW))) as {
        id: string;
      }
    ).id,
  update: (id: string, values: Record<string, unknown>) =>
    fixtures.invoke("fixture.hostUpdate", { object: BOOKING, id, values }, at(NOW)),
};

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(fixture(ext));
  await declareCustomers({
    [BOOKING]: { field: "person", read: ["name", "klass", "state"], write: ["klass", "state"] },
  });
  customer = {
    kind: "customer",
    customerId: `cus_${unique("c")}`,
    personId: await person("member"),
  };
}, 60_000);

describe("the declarations", () => {
  it("pass the contract, and their mistakes are named", () => {
    expect(validateManifest(fixture("okclm")).issues).toEqual([]);
    const broken = fixture("badclm");
    const objects = broken.objects as Record<string, Record<string, unknown>>;
    const booking = objects.booking as Record<string, unknown> & {
      states: { moves: unknown[] };
    };
    booking.claims = { on: "person", held: ["pending", "booked"], confirmed: ["booked"] };
    booking.unique = [{ fields: ["nope"], states: ["gone"] }];
    booking.states.moves.push({
      from: "attended",
      to: "pending",
      by: ["staff"],
      window: { until: "klass.name" },
    });
    const paths = validateManifest(broken).issues.map((i) => `${i.path}: ${i.message}`);
    expect(paths).toEqual(
      expect.arrayContaining([
        expect.stringContaining("objects.booking.claims.on"),
        expect.stringContaining('"booked" cannot both hold and take a place'),
        expect.stringContaining("objects.booking.unique.0.fields"),
        expect.stringContaining("objects.booking.unique.0.states"),
        expect.stringContaining("must list customer in by"),
        expect.stringContaining("objects.booking.states.moves.8.window.until.at"),
      ]),
    );
  });
});

describe("a booking claims its place", () => {
  it("takes a place when booked, gives it back when cancelled, keeps it when attended", async () => {
    const k = await klass({ places: 3 });
    const p = await person("a");
    const b = await book(k, p);
    expect(await counter(k)).toEqual({ places: 3, held: 0, taken: 1 });
    await invoke(
      "record.update",
      { object: BOOKING, id: b, values: { state: "attended" } },
      at(NOW),
    );
    expect(await counter(k)).toEqual({ places: 3, held: 0, taken: 1 });
    await invoke("record.update", { object: BOOKING, id: b, values: { state: "booked" } }, at(NOW));
    expect(await counter(k)).toEqual({ places: 3, held: 0, taken: 1 });
    // A booking holding a place is not moved to Trash; it gives the place back by its state.
    expect(
      (await refused(invoke("record.delete", { object: BOOKING, id: b }, at(NOW)))).details,
    ).toMatchObject({
      reason: "claim_live",
    });
    // Its class is not changed under it either: a move is a new booking.
    const other = await klass();
    expect(
      (
        await refused(
          invoke("record.update", { object: BOOKING, id: b, values: { klass: other } }, at(NOW)),
        )
      ).details,
    ).toMatchObject({ rule: "claim_relation_kept", field: "klass" });
    await invoke(
      "record.update",
      { object: BOOKING, id: b, values: { state: "cancelled" } },
      at(NOW),
    );
    expect(await counter(k)).toEqual({ places: 3, held: 0, taken: 0 });
    // Once cancelled, it holds nothing and may go to Trash.
    await invoke("record.delete", { object: BOOKING, id: b }, at(NOW));
  });

  it("holds a place while pending; the host takes it or gives it back", async () => {
    const k = await klass({ places: 2 });
    const paid = await asHost.create({ klass: k, person: await person("p"), state: "pending" });
    expect(await counter(k)).toEqual({ places: 2, held: 1, taken: 0 });
    await asHost.update(paid, { state: "booked" });
    expect(await counter(k)).toEqual({ places: 2, held: 0, taken: 1 });
    const unpaid = await asHost.create({ klass: k, person: await person("q"), state: "pending" });
    expect(await counter(k)).toEqual({ places: 2, held: 1, taken: 1 });
    await asHost.update(unpaid, { state: "expired" });
    expect(await counter(k)).toEqual({ places: 2, held: 0, taken: 1 });
    // Staff cannot create a pending booking: only the host holds a place unpaid.
    expect((await refused(book(k, await person("r"), { state: "pending" }))).details).toMatchObject(
      { rule: "state_move_not_permitted", by: ["host"] },
    );
    // Joining the waitlist claims nothing.
    await book(k, await person("w"), { state: "waiting" });
    expect(await counter(k)).toEqual({ places: 2, held: 0, taken: 1 });
  });

  it("20 bookings at once for the last place: exactly one is made, by the database", async () => {
    const k = await klass({ places: 5 });
    for (let i = 0; i < 4; i += 1) await book(k, await person(`f${i}`));
    const people = await Promise.all(Array.from({ length: 20 }, (_, i) => person(`race${i}`)));
    const results = await Promise.allSettled(people.map((p) => book(k, p)));
    const made = results.filter((r) => r.status === "fulfilled");
    expect(made).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") {
        expect(r.reason).toMatchObject({
          code: "invalid_input",
          details: { rule: "capacity", available: 0 },
        });
      }
    }
    expect(await counter(k)).toEqual({ places: 5, held: 0, taken: 5 });
    const { results: rows } = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_capacity_claim WHERE object_type = ? AND record_id = ? AND state = 'confirmed'",
    )
      .bind(KLASS, k)
      .all<{ n: number }>();
    expect(rows[0]?.n).toBe(5);
    // An MCP client is refused the same way.
    expect(
      (
        await refused(
          invoke(
            "record.create",
            { object: BOOKING, values: { klass: k, person: await person("mcp") } },
            context(admin, {
              actor: "mcp",
              origin: {
                surface: "mcp",
                clientId: "c1",
                clientName: "Client",
                sessionId: unique("s"),
              },
              clock: () => new Date(NOW),
            }),
          ),
        )
      ).details,
    ).toMatchObject({ rule: "capacity" });
  });
});

describe("one active booking per Person per class", () => {
  it("refuses a second, and allows one again once the first is cancelled", async () => {
    const k = await klass();
    const p = await person("u");
    const first = await book(k, p);
    expect((await refused(book(k, p))).details).toMatchObject({ rule: "unique", existing: first });
    expect((await refused(book(k, p, { state: "waiting" }))).code).toBe("conflict");
    await invoke(
      "record.update",
      { object: BOOKING, id: first, values: { state: "cancelled" } },
      at(NOW),
    );
    await book(k, p);
    // Another class, or another person, is another key.
    await book(await klass(), p);
    await book(k, await person("v"));
  });

  it("of 10 identical bookings at once, the database keeps one and claims one place", async () => {
    const k = await klass({ places: 20 });
    const p = await person("dup");
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => book(k, p)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected")
        expect(r.reason).toMatchObject({ code: "conflict", details: { rule: "unique" } });
    }
    expect(await counter(k)).toEqual({ places: 20, held: 0, taken: 1 });
  });
});

describe("windows and staff-only classes bind customers, not staff", () => {
  const create = (k: string, now: string, values: Record<string, unknown> = {}) =>
    call(
      "fixture.myCreate",
      { object: BOOKING, values: { klass: k, ...values } },
      outside(customer, { clock: () => new Date(now) }),
    );
  const move = (id: string, values: Record<string, unknown>, now: string) =>
    call(
      "fixture.myUpdate",
      { object: BOOKING, id, values },
      outside(customer, { clock: () => new Date(now) }),
    );

  it("opens 7 local days before at the same time of day, across a clock change, and closes at the start", async () => {
    // 06:00 on Thursday 8 October 2026 in Sydney (+11); 7 days before is 06:00 on 1 October (+10).
    const k = await klass({ startsAt: "2026-10-07T19:00:00.000Z", timezone: "Australia/Sydney" });
    const early = await create(k, "2026-09-30T19:59:59.000Z");
    expect(early).toMatchObject({
      ok: false,
      error: {
        code: "invalid_input",
        details: {
          rule: "state_window_not_open",
          opensAt: "2026-09-30T20:00:00.000Z",
          closesAt: "2026-10-07T19:00:00.000Z",
        },
      },
    });
    const opened = await create(k, "2026-09-30T20:00:00.000Z");
    expect(opened).toMatchObject({ ok: true });
    expect(
      await create(
        await klass({ startsAt: "2026-10-07T19:00:00.000Z" }),
        "2026-10-07T19:00:00.000Z",
      ),
    ).toMatchObject({
      ok: false,
      error: { details: { rule: "state_window_closed" } },
    });
    // Staff book after it closed: they are not bound.
    await book(k, await person("late"), {}, "2026-10-07T19:30:00.000Z");
  });

  it("refuses a customer a staff-only class, for any state; staff book them in", async () => {
    const k = await klass({ staffOnly: true });
    for (const values of [{}, { state: "waiting" }]) {
      expect(await create(k, NOW, values)).toMatchObject({
        ok: false,
        error: { code: "invalid_input", details: { rule: "state_staff_only" } },
      });
    }
    await book(k, customer.personId);
  });

  it("resolves a customer's cancel to on-time or late by the host's clock, and says which in a dry run", async () => {
    // The class starts at 08:00 UTC on 10 March; late from 07:00.
    const inTime = await klass();
    const late = await klass();
    const tooLate = await klass();
    const ids = [] as string[];
    for (const k of [inTime, late, tooLate]) {
      const made = await create(k, OPEN);
      expect(made).toMatchObject({ ok: true });
      ids.push((made as { value: { id: string } }).value.id);
    }
    const [a, b, c] = ids as [string, string, string];
    expect(await move(a, { state: "cancel" }, "2026-03-10T06:59:59.000Z")).toMatchObject({
      ok: true,
    });
    expect(await state(a)).toBe("cancelled");
    expect(await move(b, { state: "cancel" }, "2026-03-10T07:00:00.000Z")).toMatchObject({
      ok: true,
    });
    expect(await state(b)).toBe("late_cancelled");
    expect(await move(c, { state: "cancel" }, "2026-03-10T08:00:00.000Z")).toMatchObject({
      ok: false,
      error: { code: "invalid_input", details: { rule: "state_window_closed" } },
    });
    expect(await state(c)).toBe("booked");
    // Naming the late state directly in time is refused: the host decides, not the caller.
    expect(await move(c, { state: "late_cancelled" }, "2026-03-10T06:00:00.000Z")).toMatchObject({
      ok: false,
      error: { details: { rule: "state_window_not_open" } },
    });
    // The dry run a pack's tool shows before the member confirms: the state, nothing written.
    const dry = (now: string) =>
      fixtures.invoke("fixture.previewRequest", { id: c, request: "cancel" }, at(now));
    expect(await dry("2026-03-10T06:00:00.000Z")).toEqual({ state: "cancelled" });
    expect(await dry("2026-03-10T07:30:00.000Z")).toEqual({ state: "late_cancelled" });
    expect(await state(c)).toBe("booked");
    // Staff cancel late without keeping it (on time), whatever the clock says.
    await invoke(
      "record.update",
      { object: BOOKING, id: c, values: { state: "cancel" } },
      at("2026-03-10T07:30:00.000Z"),
    );
    expect(await state(c)).toBe("cancelled");
  });

  it("refuses a customer when the window cannot be worked out", async () => {
    const k = await klass({ lateMinutes: null });
    const made = await create(k, OPEN);
    const id = (made as { value: { id: string } }).value.id;
    expect(await move(id, { state: "cancel" }, OPEN)).toMatchObject({
      ok: false,
      error: { details: { rule: "state_window_unknown" } },
    });
  });
});
