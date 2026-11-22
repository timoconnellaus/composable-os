// Stage 31a step 3 (ADRs 0505 and 0506), on a fixture class type, class, booking and pass: what
// the Bookings pack needed of the platform. A window's numbers are read two relations away (the
// booking's class's type, as Bookings' rules sit on Programs' class type), and when that is empty
// from the extension's setting (the organisation's default); a staff-only rule is any of several
// booleans, a formula among them (a class that is not scheduled); and a spender marked paid
// another way (`waived`) enters its spend state spending nothing, and the mark cannot change while
// it is in one. Every clock is injected.
import { env } from "cloudflare:workers";
import { validateManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ActingUser,
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
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, unique } from "./helpers.ts";

const ext = extId("bkp");
const KIND = `${ext}.kind`;
const KLASS = `${ext}.klass`;
const BOOKING = `${ext}.booking`;
const PASS = `${ext}.pass`;

const lateFrom = {
  at: "klass.startsAt",
  minutesBefore: { field: "klass.kind.lateMinutes", setting: "lateMinutes" },
};

const fixture = (id: string) =>
  manifest(id, {
    settings: { lateMinutes: { type: "number", label: "Late from", default: 60 } },
    objects: {
      kind: {
        label: "Kind",
        plural: "Kinds",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          lateMinutes: { type: "number", label: "Late from" },
          staffOnly: { type: "boolean", label: "Staff only" },
        },
      },
      klass: {
        label: "Class",
        plural: "Classes",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          kind: { type: "relation", label: "Kind", to: `${id}.kind` },
          startsAt: { type: "datetime", label: "Starts at" },
          places: { type: "number", label: "Places" },
          state: {
            type: "select",
            label: "State",
            options: [
              { value: "scheduled", label: "Scheduled" },
              { value: "cancelled", label: "Cancelled" },
            ],
          },
          closed: {
            type: "formula",
            label: "Closed",
            expression: 'coalesce(state, "scheduled") != "scheduled"',
          },
        },
        states: {
          field: "state",
          initial: "scheduled",
          moves: [{ from: "scheduled", to: "cancelled", by: ["staff", "host"], final: true }],
        },
        capacity: { places: "places" },
      },
      booking: {
        label: "Booking",
        plural: "Bookings",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name" },
          klass: { type: "relation", label: "Class", to: `${id}.klass` },
          person: { type: "relation", label: "Person", to: "person" },
          holder: { type: "text", label: "Paid from" },
          paidOtherwise: { type: "boolean", label: "Paid at the desk", readOnly: true },
          state: {
            type: "select",
            label: "State",
            options: ["booked", "cancelled", "late_cancelled"].map((value) => ({
              value,
              label: value,
            })),
          },
        },
        states: {
          field: "state",
          initial: "booked",
          create: { staffOnly: ["klass.kind.staffOnly", "klass.closed"] },
          requests: { cancel: ["cancelled", "late_cancelled"] },
          moves: [
            {
              from: "booked",
              to: "cancelled",
              by: ["staff", "customer"],
              final: true,
              window: { until: lateFrom },
            },
            {
              from: "booked",
              to: "late_cancelled",
              by: ["staff", "customer"],
              final: true,
              window: { from: lateFrom, until: "klass.startsAt" },
            },
          ],
        },
        claims: { on: "klass", confirmed: ["booked"] },
        allowance: {
          spends: {
            person: "person",
            holder: "holder",
            spendIn: ["booked"],
            returnIn: ["cancelled"],
            at: "klass.startsAt",
            waived: "paidOtherwise",
          },
        },
      },
      pass: {
        label: "Pass",
        plural: "Passes",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name" },
          person: { type: "relation", label: "Person", to: "person", required: true },
          uses: { type: "number", label: "Uses" },
        },
        allowance: {
          holds: { person: "person", uses: "uses", per: "total", spendsOn: { object: "booking" } },
        },
      },
    },
  });

let admin: ActingUser;
let personId: string;
let passId: string;
const T = Date.parse("2026-12-01T00:00:00.000Z");
const MINUTE = 60_000;
const at = (ms: number) => context(admin, { clock: () => new Date(ms) });

// Platform code's writes and a customer's dry run, as the record operations make them.
const hostCreate = defineOperation({
  name: "fixture.bkpHostCreate",
  description: "Test fixture: creates a booking as the host.",
  input: z.object({ values: z.record(z.string(), z.unknown()) }),
  output: z.object({ id: z.string() }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    return {
      id: await createRecord(ctx, requireExtensionObject(BOOKING), input.values, { by: "host" }),
    };
  },
});
const customerCreate = defineOperation({
  name: "fixture.bkpCustomerCreate",
  description: "Test fixture: creates a booking as a customer's write would be judged.",
  input: z.object({ values: z.record(z.string(), z.unknown()) }),
  output: z.object({ id: z.string() }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    return {
      id: await createRecord(ctx, requireExtensionObject(BOOKING), input.values, {
        by: "customer",
      }),
    };
  },
});
const hostUpdate = defineOperation({
  name: "fixture.bkpHostUpdate",
  description: "Test fixture: changes a booking as the host.",
  input: z.object({ id: z.string(), values: z.record(z.string(), z.unknown()) }),
  output: z.object({ ok: z.boolean() }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    await updateRecordAsHost(ctx, BOOKING, input.id, input.values);
    return { ok: true };
  },
});
const preview = defineOperation({
  name: "fixture.bkpPreview",
  description: "Test fixture: the state a customer's cancel would enter now.",
  input: z.object({ id: z.string() }),
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
      { state: "cancel" },
      "customer",
    );
    return { state: values.state };
  },
});
const fixtures = createInvoker(
  createRegistry([...coreRegistry.list(), hostCreate, customerCreate, hostUpdate, preview]),
);

async function refused(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).not.toBeNull();
  return error as { code: string; details: Record<string, unknown>; message: string };
}

const create = async (object: string, values: Record<string, unknown>, now = T) =>
  ((await invoke("record.create", { object, values }, at(now))) as { id: string }).id;

async function klass(startsIn: number, kindValues: Record<string, unknown> = {}) {
  const kind = await create(KIND, { name: unique("Kind"), ...kindValues });
  return create(KLASS, {
    name: unique("Class"),
    kind,
    startsAt: new Date(T + startsIn).toISOString(),
    places: 5,
  });
}

/** A booking paid at the desk, made by the host: it needs no pass. */
const deskBooking = async (klassId: string) =>
  (
    (await fixtures.invoke(
      "fixture.bkpHostCreate",
      { values: { klass: klassId, person: personId, paidOtherwise: true } },
      at(T),
    )) as { id: string }
  ).id;

const previewAt = async (id: string, now: number) =>
  ((await fixtures.invoke("fixture.bkpPreview", { id }, at(now))) as { state: string }).state;

async function setting(value: Record<string, unknown> | null) {
  if (value === null) {
    await env.DB.prepare("DELETE FROM core_extension_settings WHERE extension_id = ?")
      .bind(ext)
      .run();
    return;
  }
  await env.DB.prepare(
    "INSERT INTO core_extension_settings (extension_id, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT (extension_id) DO UPDATE SET value = excluded.value",
  )
    .bind(ext, JSON.stringify(value), new Date(T).toISOString(), admin.id)
    .run();
}

const usesOf = async (bookingId: string) =>
  (
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_allowance_use WHERE spender_id = ? AND returned_at IS NULL",
    )
      .bind(bookingId)
      .first<{ n: number }>()
  )?.n ?? 0;

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(fixture(ext));
  // Installed, as the host keeps it: its manifest holds the setting's default (60 minutes).
  await env.DB.prepare(
    "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'runtime', 'active', '1.0.0', 'c1', ?, ?, ?, ?)",
  )
    .bind(
      ext,
      JSON.stringify(fixture(ext)),
      admin.id,
      new Date(T).toISOString(),
      new Date(T).toISOString(),
    )
    .run();
  const person = (await invoke(
    "person.create",
    { givenName: unique("Member"), emails: [{ email: `${unique("m")}@bkp.example` }] },
    context(admin),
  )) as { id: string };
  personId = person.id;
  passId = await create(PASS, { name: "Ten", person: personId, uses: 10 });
}, 60_000);

describe("the declarations", () => {
  it("pass the contract, and their mistakes are named", () => {
    expect(validateManifest(fixture("okbkp")).issues).toEqual([]);
    const broken = fixture("badbkp");
    const objects = broken.objects as Record<string, Record<string, unknown>>;
    const booking = objects.booking as {
      states: { create: Record<string, unknown>; moves: { window?: unknown }[] };
      allowance: { spends: Record<string, unknown> };
      fields: Record<string, Record<string, unknown>>;
    };
    booking.states.create.staffOnly = ["klass.kind.nope", "klass.name"];
    (booking.states.moves[0] as { window: unknown }).window = {
      until: { at: "klass.startsAt", minutesBefore: { field: "klass.kind.name", setting: "nope" } },
    };
    booking.fields.paidOtherwise = { type: "boolean", label: "Paid at the desk" };
    expect(validateManifest(broken).issues.map((i) => i.path)).toEqual(
      expect.arrayContaining([
        "objects.booking.states.moves.0.window.until.minutesBefore.field",
        "objects.booking.states.moves.0.window.until.minutesBefore.setting",
        "objects.booking.states.create.staffOnly",
        "objects.booking.allowance.spends.waived",
      ]),
    );
  });
});

describe("a window's numbers two relations away, over the extension's setting", () => {
  it("the class's type's own late-cancel time decides", async () => {
    const id = await deskBooking(await klass(3 * 60 * MINUTE, { lateMinutes: 240 }));
    // Three hours before, late from four: late.
    expect(await previewAt(id, T)).toBe("late_cancelled");
  });

  it("an empty one is the setting's stored value, else its default", async () => {
    const id = await deskBooking(await klass(45 * MINUTE));
    // Nothing stored: the declared default, late from 60 minutes, so 45 minutes before is late.
    await setting(null);
    expect(await previewAt(id, T)).toBe("late_cancelled");
    await setting({ lateMinutes: 30 });
    expect(await previewAt(id, T)).toBe("cancelled");
    await setting({ lateMinutes: 90 });
    expect(await previewAt(id, T)).toBe("late_cancelled");
    // The class type's own value wins over the setting.
    const own = await deskBooking(await klass(45 * MINUTE, { lateMinutes: 10 }));
    expect(await previewAt(own, T)).toBe("cancelled");
    await setting(null);
  });
});

describe("staff-only rules: any of several, a formula among them", () => {
  it("refuses a customer's create for a staff-only type or a class that is not scheduled; staff may", async () => {
    const make = (klassId: string) =>
      fixtures.invoke(
        "fixture.bkpCustomerCreate",
        { values: { klass: klassId, person: personId } },
        at(T),
      );
    const open = await klass(3 * 60 * MINUTE);
    await expect(make(open)).resolves.toMatchObject({ id: expect.any(String) });
    const staffOnly = await klass(3 * 60 * MINUTE, { staffOnly: true });
    expect(await refused(make(staffOnly))).toMatchObject({
      details: { rule: "state_staff_only" },
    });
    const cancelled = await klass(3 * 60 * MINUTE);
    await invoke(
      "record.update",
      { object: KLASS, id: cancelled, values: { state: "cancelled" } },
      at(T),
    );
    expect(await refused(make(cancelled))).toMatchObject({ details: { rule: "state_staff_only" } });
    // Staff are not bound.
    await expect(
      invoke(
        "record.create",
        { object: BOOKING, values: { klass: staffOnly, person: personId } },
        at(T),
      ),
    ).resolves.toMatchObject({ id: expect.any(String) });
  });
});

describe("a spender paid another way (waived)", () => {
  it("enters booked spending nothing, and the mark cannot change while it is booked", async () => {
    const before = await loadPassLeft();
    const id = await deskBooking(await klass(5 * 60 * MINUTE));
    expect(await usesOf(id)).toBe(0);
    expect(await loadPassLeft()).toBe(before);
    // Even the host cannot turn it off (a use owed would go unpaid) while it is booked.
    expect(
      await refused(
        fixtures.invoke("fixture.bkpHostUpdate", { id, values: { paidOtherwise: false } }, at(T)),
      ),
    ).toMatchObject({ details: { rule: "allowance", reason: "waived_kept" } });
    // A paid booking cannot be marked paid at the desk afterwards (its use would never return).
    const paid = await create(BOOKING, { klass: await klass(5 * 60 * MINUTE), person: personId });
    expect(await usesOf(paid)).toBe(1);
    expect(
      await refused(
        fixtures.invoke(
          "fixture.bkpHostUpdate",
          { id: paid, values: { paidOtherwise: true } },
          at(T),
        ),
      ),
    ).toMatchObject({ details: { rule: "allowance", reason: "waived_kept" } });
    // Cancelled in time, a desk booking gives nothing back, as it took nothing.
    await invoke("record.update", { object: BOOKING, id, values: { state: "cancelled" } }, at(T));
    expect(await loadPassLeft()).toBe(before - 1);
  });
});

async function loadPassLeft(): Promise<number> {
  const record = await invoke("record.get", { object: PASS, id: passId }, context(admin));
  return Number(record.values.left);
}
