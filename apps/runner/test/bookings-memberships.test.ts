// Stage 31a step 4 begins (stage 32b's pack beside it): the real Memberships pack's pass pays for
// a real booking. Both shipped packs as they are (no test variant of `paidBy`), on Programs, in
// the real host and sandbox. It proves the field names the two packs assumed of each other: the
// pass's `classTypes`, `weekdays` and `fromMinute`/`untilMinute` read the booking's host-filled
// `classType`, `weekday` and `minute` (a class at another weekday, another time or of another type
// is not paid for), the use counts, and a cancel in time gives it back.
//
// Clocks: as in bookings.test.ts, a tool's own calls read the real clock (the runner's executor),
// so the classes are placed hours from now; their local weekday and minute are worked out here
// from the same instants, in the class's zone.
import {
  type ActingUser,
  type CustomerPrincipal,
  type ExtensionHost,
  type InvocationContext,
  type OutsideInvocationContext,
  refreshSchemaRegistry,
} from "@composable-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import { setPreset } from "./automation-fixture.ts";
import { createAdmin, db, host, newCustomer, run, unique } from "./helpers.ts";
import { packFiles } from "./pack-files.ts";

const files: Record<string, Record<string, string>> = {
  programs: packFiles("programs"),
  bookings: packFiles("bookings"),
  memberships: packFiles("memberships"),
};

/** A deployment whose product lists Programs, Bookings and Memberships, each as shipped. */
const shippedHost: ExtensionHost = {
  ...host,
  shipped: async () => [
    ...(await host.shipped()),
    { id: "bookings", version: "0.1.0" },
    { id: "memberships", version: "0.1.0" },
    { id: "programs", version: "0.1.0" },
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

const HOUR = 3_600_000;
const ZONE = "Australia/Sydney";
let admin: ActingUser;

const staff = (extra: Partial<InvocationContext> = {}): InvocationContext => ({
  actor: "human",
  user: admin,
  origin: { surface: "ui" },
  db,
  extensionHost: shippedHost,
  ...extra,
});
const as = (principal: CustomerPrincipal): OutsideInvocationContext => ({
  principal,
  db,
  extensionHost: shippedHost,
});
const create = async (object: string, values: Record<string, unknown>) =>
  (await run<{ id: string }>("record.create", { object, values }, staff())).id;

/** The local ISO weekday (1 Monday) and minute after midnight of an instant, in ZONE. */
function local(instant: number): { weekday: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: ZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return {
    weekday: days.indexOf(get("weekday")) + 1,
    minute: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

const member = async (label: string) => (await newCustomer(staff(), label)).principal;

beforeAll(async () => {
  admin = await createAdmin();
  await setPreset("balanced");
  await refreshSchemaRegistry(db.query);
  for (const id of ["bookings", "memberships"]) {
    await run("extension.install", { id, shipped: true }, staff());
  }
  await refreshSchemaRegistry(db.query);
});

describe("a real pass pays for a real booking", () => {
  it("by its class types, weekdays and times; the use counts; a cancel in time gives it back", async () => {
    const strength = await create("bookings.classtype", { name: unique("Strength") });
    const yoga = await create("bookings.classtype", { name: unique("Yoga") });
    const startsIn = 3 * HOUR;
    const at = Date.now() + startsIn;
    const { weekday, minute } = local(at);
    // A pack of five for Strength, on the class's weekday, around its time.
    const passType = await create("memberships.passtype", {
      title: unique("Five Strength "),
      price: 100,
      uses: 5,
      validDays: 30,
      classTypes: [strength],
      weekdays: [String(weekday)],
      fromMinute: Math.max(0, minute - 60),
      untilMinute: Math.min(1440, minute + 60),
      status: "on_sale",
    });
    const who = await member("real");
    const given = await run<{ passId: string }>(
      "x.memberships.givePass",
      { personId: who.personId, passTypeId: passType, reason: "Integration test" },
      staff(),
    );
    const left = async () =>
      (
        await run<{ values: { left: number } }>(
          "record.get",
          { object: "memberships.pass", id: given.passId },
          staff(),
        )
      ).values.left;
    expect(await left()).toBe(5);

    const klass = (type: string, offset = 0) =>
      create("bookings.class", {
        classType: type,
        startsAt: new Date(at + offset).toISOString(),
        endsAt: new Date(at + offset + HOUR).toISOString(),
        timezone: ZONE,
        places: 10,
      });
    const book = (classId: string) =>
      run<{ result: string; bookingId?: string; holderId?: string | null; reason?: string }>(
        "x.bookings.book",
        { classId },
        as(who),
      );

    // The right class: paid by the pass, its type and local time copied as the pass reads them.
    const ok = await book(await klass(strength));
    expect(ok).toMatchObject({ result: "booked", holderId: given.passId });
    expect(await left()).toBe(4);
    const booking = await run<{ values: Record<string, unknown> }>(
      "record.get",
      { object: "bookings.booking", id: ok.bookingId },
      staff(),
    );
    expect(booking.values).toMatchObject({ classType: strength, weekday, minute });

    // Another class type, another weekday, another time of day: not paid for.
    expect(await book(await klass(yoga))).toMatchObject({ result: "refused", reason: "no_use" });
    expect(await book(await klass(strength, 24 * HOUR))).toMatchObject({
      result: "refused",
      reason: "no_use",
    });
    expect(await book(await klass(strength, 2 * HOUR))).toMatchObject({
      result: "refused",
      reason: "no_use",
    });
    expect(await left()).toBe(4);

    // Cancelled in time: the use is back.
    const preview = await run<{ state: string }>(
      "x.bookings.cancel",
      { bookingId: ok.bookingId },
      as(who),
    );
    expect(preview.state).toBe("cancelled");
    await run(
      "x.bookings.cancel",
      { bookingId: ok.bookingId, confirm: true, expect: "cancelled" },
      as(who),
    );
    expect(await left()).toBe(5);
  });
});
