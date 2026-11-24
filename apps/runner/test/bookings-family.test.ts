// Stage 31a step 6 (ADR 0540) on the shipped packs: Programs, Bookings and Memberships in the real
// host and sandbox. A parent staff linked to a child with no email and no account (acceptance
// criteria 10 and 12):
//   - books, cancels and joins and leaves a waitlist for the child, under the same rules, spending
//     only the child's pass (never the parent's, even when the parent names their own);
//   - reads the child's bookings and what the child's passes have left, and nothing of another
//     member's child;
//   - a member who is not linked naming the child is answered as for a Person who does not exist;
//   - ending the link stops all of it at once; the bookings made stay.

import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type CustomerPrincipal,
  type InvocationContext,
  type OutsideInvocationContext,
  refreshSchemaRegistry,
} from "@composable-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import { integrationRuntime } from "../src/integrations/runtime.ts";
import { setPreset } from "./automation-fixture.ts";
import { createAdmin, db, newCustomer, run, unique } from "./helpers.ts";
import { gymHost as shippedHost } from "./pack-files.ts";

const integrations = integrationRuntime(env);
const HOUR = 3_600_000;
const CLASS = "bookings.class";
const BOOKING = "bookings.booking";
const PASS = "memberships.pass";
const GUESS = "per_01GUESSED00000000000000000";

let admin: ActingUser;
const staff = (): InvocationContext => ({
  actor: "human",
  user: admin,
  origin: { surface: "ui" },
  db,
  integrations,
  extensionHost: shippedHost,
});
const as = (principal: CustomerPrincipal): OutsideInvocationContext => ({
  principal,
  db,
  integrations,
  extensionHost: shippedHost,
});
const create = async (object: string, values: Record<string, unknown>) =>
  (await run<{ id: string }>("record.create", { object, values }, staff())).id;
const get = async (object: string, id: string) =>
  (await run<{ values: Record<string, unknown> }>("record.get", { object, id }, staff())).values;

/** A member who can sign in: a Person with an email and a customer account. */
const member = async (label: string) =>
  (await newCustomer(staff(), label, { domain: "family.test" })).principal;

/** A child: a Person with no email and no account. */
const child = async (label: string) =>
  (await run<{ id: string }>("person.create", { givenName: unique(label) }, staff())).id;

const link = (guardianId: string, dependantId: string) =>
  run<{ id: string }>("person.link.add", { guardianId, dependantId }, staff());

async function givePass(personId: string, uses = 5): Promise<string> {
  const type = await create("memberships.passtype", {
    title: unique("Pack "),
    price: 50,
    uses,
    validDays: 60,
    status: "on_sale",
  });
  const given = await run<{ passId: string }>(
    "x.memberships.givePass",
    { personId, passTypeId: type, reason: "Integration test" },
    staff(),
  );
  return given.passId;
}

const left = async (pass: string) => (await get(PASS, pass)).left;

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

type BookOut = {
  result: string;
  bookingId?: string;
  holderId?: string | null;
  position?: number | null;
  reason?: string;
  message?: string;
};
const book = (who: CustomerPrincipal, classId: string, extra: Record<string, unknown> = {}) =>
  run<BookOut>("x.bookings.book", { classId, ...extra }, as(who));
type Mine = { bookings: { id: string; personId: string | null; classId: string; state: string }[] };
const mine = (who: CustomerPrincipal, personId?: string) =>
  run<Mine>("x.bookings.mine", { upcoming: false, ...(personId ? { personId } : {}) }, as(who));

let kids: string;
let staffOnly: string;

beforeAll(async () => {
  admin = await createAdmin();
  await setPreset("balanced");
  await refreshSchemaRegistry(db.query);
  for (const id of ["programs", "bookings", "memberships"]) {
    await run("extension.install", { id, shipped: true }, staff());
  }
  await refreshSchemaRegistry(db.query);
  kids = await create("programs.classtype", { name: unique("Kids") });
  staffOnly = await create("programs.classtype", {
    name: unique("Squad"),
    "bookings.staffOnly": true,
  });
}, 120_000);

describe("a parent books for a child (criterion 10)", () => {
  let parent: CustomerPrincipal;
  let kid: string;
  let parentPass: string;
  let kidPass: string;

  beforeAll(async () => {
    parent = await member("parent");
    kid = await child("Kid");
    await link(parent.personId, kid);
    parentPass = await givePass(parent.personId);
    kidPass = await givePass(kid);
  }, 60_000);

  it("family names the parent and the child", async () => {
    const family = await run<{ people: { personId: string; self: boolean }[] }>(
      "x.bookings.family",
      {},
      as(parent),
    );
    expect(family.people).toEqual([
      expect.objectContaining({ personId: parent.personId, self: true }),
      expect.objectContaining({ personId: kid, self: false }),
    ]);
  });

  it("books the child with the child's pass, never the parent's, and cancels it in time", async () => {
    const id = await klass(kids, 5 * HOUR);
    const booked = await book(parent, id, { forPersonId: kid });
    expect(booked).toMatchObject({ result: "booked", holderId: kidPass });
    expect(await left(kidPass)).toBe(4);
    expect(await left(parentPass)).toBe(5);
    const row = await get(BOOKING, booked.bookingId as string);
    expect(row).toMatchObject({ person: kid, madeBy: parent.personId, holder: kidPass });
    // Theirs and the child's are apart: the parent's own list has none of it.
    expect((await mine(parent)).bookings.map((b) => b.id)).not.toContain(booked.bookingId);
    expect((await mine(parent, kid)).bookings).toEqual([
      expect.objectContaining({ id: booked.bookingId, personId: kid, state: "booked" }),
    ]);
    // The parent may book the same class for themselves too: one booking per Person.
    expect(await book(parent, id)).toMatchObject({ result: "booked", holderId: parentPass });
    // Cancel in time: the child's use comes back.
    const preview = await run<{ state: string }>(
      "x.bookings.cancel",
      { bookingId: booked.bookingId },
      as(parent),
    );
    expect(preview).toMatchObject({ result: "preview", state: "cancelled" });
    await run(
      "x.bookings.cancel",
      { bookingId: booked.bookingId, confirm: true, expect: "cancelled" },
      as(parent),
    );
    expect(await left(kidPass)).toBe(5);
  });

  it("naming the parent's own pass for the child is refused: the holder is the child's", async () => {
    const id = await klass(kids, 6 * HOUR);
    const refused = await book(parent, id, { forPersonId: kid, holderId: parentPass });
    expect(refused).toMatchObject({ result: "refused", reason: "no_use" });
    expect(await left(parentPass)).toBe(4); // the parent's own booking above
    // Nor the other way: the parent naming the child's pass for their own booking.
    const own = await book(parent, id, { holderId: kidPass });
    expect(own).toMatchObject({ result: "refused", reason: "no_use" });
    expect(await left(kidPass)).toBe(5);
  });

  it("joins and leaves a full class's waitlist for the child, spending nothing", async () => {
    const id = await klass(kids, 7 * HOUR, 1);
    const other = await member("other");
    await givePass(other.personId);
    expect(await book(other, id)).toMatchObject({ result: "booked" });
    const waiting = await book(parent, id, { forPersonId: kid });
    expect(waiting).toMatchObject({ result: "waiting", position: 1 });
    expect(await left(kidPass)).toBe(5);
    const leftWaitlist = await run<{ result: string }>(
      "x.bookings.leaveWaitlist",
      { bookingId: waiting.bookingId },
      as(parent),
    );
    expect(leftWaitlist).toMatchObject({ result: "left" });
  });

  it("the same rules hold for the child: a class only staff book is refused", async () => {
    const id = await klass(staffOnly, 5 * HOUR);
    expect(await book(parent, id, { forPersonId: kid })).toMatchObject({
      result: "refused",
      reason: "staff_only",
    });
  });

  it("reads what the child's passes have left, and the child's alone", async () => {
    const theirs = await run<{ holdings: { id: string }[] }>(
      "x.memberships.mine",
      { personId: kid },
      as(parent),
    );
    expect(theirs.holdings.map((h) => h.id)).toEqual([kidPass]);
    const own = await run<{ holdings: { id: string }[] }>("x.memberships.mine", {}, as(parent));
    expect(own.holdings.map((h) => h.id)).toEqual([parentPass]);
  });
});

describe("nobody else acts for the child, and an ended link gives nothing (criteria 10 and 12)", () => {
  it("a member not linked to the child is answered as for a Person who does not exist", async () => {
    const parent = await member("parent");
    const stranger = await member("stranger");
    const kid = await child("Kid");
    await link(parent.personId, kid);
    await givePass(kid);
    await givePass(stranger.personId);
    const id = await klass(kids, 5 * HOUR);
    const booked = await book(parent, id, { forPersonId: kid });
    expect(booked.result).toBe("booked");

    const named = await book(stranger, id, { forPersonId: kid });
    const guessed = await book(stranger, id, { forPersonId: GUESS });
    expect(named).toMatchObject({ result: "refused", reason: "not_found" });
    expect(named).toEqual(guessed);
    expect((await mine(stranger, kid)).bookings).toEqual([]);
    expect((await mine(stranger, kid)).bookings).toEqual((await mine(stranger, GUESS)).bookings);
    const cancel = await run<{ result: string; reason?: string }>(
      "x.bookings.cancel",
      { bookingId: booked.bookingId },
      as(stranger),
    );
    expect(cancel).toMatchObject({ result: "refused", reason: "not_found" });
    expect(
      (await run<{ holdings: unknown[] }>("x.memberships.mine", { personId: kid }, as(stranger)))
        .holdings,
    ).toEqual([]);
    // The child's booking is untouched.
    expect((await get(BOOKING, booked.bookingId as string)).state).toBe("booked");
  });

  it("ending the link stops booking, cancelling and reading at once; the booking stays", async () => {
    const parent = await member("parent");
    const kid = await child("Kid");
    const made = await link(parent.personId, kid);
    await givePass(kid);
    const first = await klass(kids, 5 * HOUR);
    const second = await klass(kids, 6 * HOUR);
    const booked = await book(parent, first, { forPersonId: kid });
    expect(booked.result).toBe("booked");
    await run("person.link.end", { id: made.id }, staff());

    expect(await book(parent, second, { forPersonId: kid })).toMatchObject({
      result: "refused",
      reason: "not_found",
    });
    expect((await mine(parent, kid)).bookings).toEqual([]);
    const cancel = await run<{ result: string; reason?: string }>(
      "x.bookings.cancel",
      { bookingId: booked.bookingId, confirm: true, expect: "cancelled" },
      as(parent),
    );
    expect(cancel).toMatchObject({ result: "refused", reason: "not_found" });
    expect((await get(BOOKING, booked.bookingId as string)).state).toBe("booked");
    const family = await run<{ people: unknown[] }>("x.bookings.family", {}, as(parent));
    expect(family.people).toHaveLength(1);
  });
});
