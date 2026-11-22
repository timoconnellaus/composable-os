// The Bookings messages (step 9) against the SDK's test host: each automation's declared trigger
// and conditions, who it writes to (the booking's Person and their live guardians, never anyone
// else), what each email says and the calendar file it carries. That the host starts them once
// (record events, the minute scan of a trigger in minutes) is tested on the real host in
// apps/runner/test/bookings-messages.test.ts, which runs this pack in the sandbox.
import { createTestHost } from "@composable-os/sdk/testing";
import { describe, expect, it } from "vitest";
import { bookedKind, classTimeText } from "../automations.ts";
import bookings from "../index.ts";

const HOUR = 3_600_000;
const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();

const CLASS = {
  id: "cls_1",
  title: "Strength",
  classType: "ct_1",
  startsAt: inHours(30),
  endsAt: inHours(31),
  timezone: "Australia/Sydney",
  room: "room_1",
  coach: "coach_1",
  state: "scheduled",
  places: 12,
};

const PEOPLE: Record<string, { displayName: string; primaryEmail: string | null }> = {
  per_ann: { displayName: "Ann Member", primaryEmail: "Ann@Members.test" },
  per_sam: { displayName: "Sam Child", primaryEmail: null },
  per_pat: { displayName: "Pat Parent", primaryEmail: "pat@members.test" },
  per_kim: { displayName: "Kim Parent", primaryEmail: "kim@members.test" },
  per_old: { displayName: "Old Guardian", primaryEmail: "old@members.test" },
  per_bob: { displayName: "Bob Other", primaryEmail: "bob@members.test" },
};

/** Sam's guardians: Pat and Kim live, Old's link ended. */
const LINKS = [
  { guardian: { id: "per_pat" }, dependant: { id: "per_sam" }, endedAt: null },
  { guardian: { id: "per_kim" }, dependant: { id: "per_sam" }, endedAt: null },
  { guardian: { id: "per_old" }, dependant: { id: "per_sam" }, endedAt: "2026-11-01T00:00:00Z" },
];

interface Mail {
  to: string[];
  subject: string;
  text: string;
  relatedRecords?: string[];
  calendar?: Record<string, unknown>;
}

function host(
  records: Record<string, Record<string, unknown>[]>,
  operations: Record<string, (input: Record<string, unknown>) => unknown> = {},
) {
  return createTestHost(bookings, {
    validate: { knownObjects: ["programs.classtype"] },
    records: {
      "bookings.room": [{ id: "room_1", name: "Studio A" }],
      "programs.classtype": [{ id: "ct_1", name: "Strength" }],
      ...records,
    } as never,
    operations: {
      // As the host's person.get answers: the addresses, the primary one marked.
      "person.get": (input) => {
        const p = PEOPLE[String(input.id)];
        if (!p) return null;
        return {
          id: input.id,
          displayName: p.displayName,
          emails: p.primaryEmail
            ? [
                { email: "old-address@members.test", primary: false },
                { email: p.primaryEmail, primary: true },
              ]
            : [],
        };
      },
      "person.link.list": (input) => ({
        items: LINKS.filter(
          (l) => l.dependant.id === input.personId || l.guardian.id === input.personId,
        ),
      }),
      "extensionSettings.list": () => ({
        items: [
          {
            id: "bookings",
            values: { bookingsUrl: "https://gym.test/bookings", promotionMinutes: 120 },
          },
        ],
      }),
      ...operations,
    },
  });
}

const mails = (h: ReturnType<typeof host>): Mail[] =>
  h.gatekeeperCalls.map((c) => {
    expect(c).toMatchObject({ gatekeeper: "email-send", connectionId: "mail", method: "send" });
    return c.args[0] as Mail;
  });

const booking = (values: Record<string, unknown>) => ({
  id: "bkg_1",
  class: "cls_1",
  person: "per_ann",
  state: "booked",
  ...values,
});

describe("the manifest", () => {
  it("passes the contract with its automations and declares each trigger", () => {
    expect(
      createTestHost(bookings, { validate: { knownObjects: ["programs.classtype"] } }).issues,
    ).toEqual([]);
    const a = bookings.automations ?? {};
    expect(Object.keys(a).sort()).toEqual([
      "bookingConfirmed",
      "classCancelled",
      "classChanged",
      "classReminder",
      "dropInRefunded",
      "noAttendanceTaken",
      "placeFree",
      "waitlistPassedOver",
    ]);
    expect(a.classReminder?.trigger).toEqual({
      type: "dateRelative",
      object: "bookings.class",
      field: "startsAt",
      minutesBefore: { field: "classType.reminderMinutes", setting: "reminderMinutes" },
    });
    expect(a.classReminder?.conditions).toEqual({ field: "state", op: "eq", value: "scheduled" });
    expect(a.noAttendanceTaken?.trigger).toMatchObject({ field: "endsAt", minutesAfter: 60 });
    expect(a.classCancelled?.trigger).toMatchObject({
      type: "fieldChanged",
      field: "state",
      from: "scheduled",
      to: "cancelled",
      includeBulk: true,
    });
    // Every mail goes through the one email-send connection; the staff notice is in the app.
    for (const [name, automation] of Object.entries(a)) {
      if (name === "noAttendanceTaken") expect(automation.connections).toBeUndefined();
      else
        expect(automation.connections).toEqual([
          expect.objectContaining({ gatekeeper: "email-send" }),
        ]);
    }
    expect(bookings.settings?.reminderMinutes).toMatchObject({ default: 180, max: 2_880 });
    // The record triggers read their change: never coalesced with the record's other updates.
    expect(a.bookingConfirmed?.rails).toEqual({ debounceSeconds: 0 });
    expect(a.classChanged?.rails).toEqual({ debounceSeconds: 0 });
  });
});

describe("bookingConfirmed", () => {
  it("tells which booked message a change is, and none for a correction", () => {
    expect(bookedKind({ action: "created", diff: {} }, {})).toBe("booked");
    expect(bookedKind({ action: "created", diff: {} }, { movedFrom: "bkg_0" })).toBe("moved");
    // Created waiting or held, and read after it was moved in or paid: its move's run tells it.
    expect(
      bookedKind({ action: "created", diff: {} }, { promotedAt: "2026-11-23T00:00:00Z" }),
    ).toBeNull();
    expect(bookedKind({ action: "created", diff: {} }, { dropInOrder: "ord_1" })).toBeNull();
    expect(
      bookedKind({ action: "created", diff: {} }, { movedFrom: "bkg_0", dropInOrder: "ord_1" }),
    ).toBe("moved");
    const moved = (before: string) => ({
      action: "updated",
      diff: { state: { before, after: "booked" } },
    });
    expect(bookedKind(moved("pending"), {})).toBe("paid");
    expect(bookedKind(moved("waiting"), {})).toBe("promoted");
    // A tick undone, a no-show unticked, or a note edited: nothing.
    expect(bookedKind(moved("attended"), {})).toBeNull();
    expect(
      bookedKind({ action: "updated", diff: { note: { before: null, after: "x" } } }, {}),
    ).toBeNull();
  });

  it("emails the member once, with a valid calendar event of the class", async () => {
    const h = host({
      "bookings.class": [CLASS],
      "bookings.booking": [booking({ madeBy: "per_ann" })],
    });
    const run = await h.runAutomation("bookingConfirmed", {
      record: { object: "bookings.booking", id: "bkg_1" },
      change: { action: "created", diff: {} },
    });
    expect(run.matched).toBe(true);
    expect(run.undeclared).toEqual([]);
    expect(run.error).toBeNull();
    const [mail, ...more] = mails(h);
    expect(more).toEqual([]);
    expect(mail?.to).toEqual(["ann@members.test"]);
    expect(mail?.subject).toBe("Booked: Strength");
    expect(mail?.text).toContain("You are booked into Strength on");
    expect(mail?.text).toContain("(Australia/Sydney time), in Studio A.");
    expect(mail?.text).toContain("Your bookings: https://gym.test/bookings");
    expect(mail?.relatedRecords).toEqual(["bkg_1", "cls_1"]);
    expect(mail?.calendar).toEqual({
      uid: "bkg_1",
      start: CLASS.startsAt,
      end: CLASS.endsAt,
      title: "Strength",
      location: "Studio A",
      url: "https://gym.test/bookings",
    });
  });

  it("writes to a child's live guardians, naming the child, and not to one whose link ended", async () => {
    const h = host({
      "bookings.class": [CLASS],
      "bookings.booking": [booking({ person: "per_sam", madeBy: "per_pat" })],
    });
    await h.runAutomation("bookingConfirmed", {
      record: { object: "bookings.booking", id: "bkg_1" },
      change: { action: "created", diff: {} },
    });
    const sent = mails(h);
    // The child has no address: the two live guardians, one email each, nobody else.
    expect(sent.map((m) => m.to)).toEqual([["pat@members.test"], ["kim@members.test"]]);
    expect(sent[0]?.text).toContain("You booked Sam Child into Strength");
    expect(sent[1]?.text).toContain("Sam Child is booked into Strength");
    expect(sent[1]?.text).not.toContain("Pat");
    expect(sent.every((m) => m.subject === "Booked: Strength (Sam Child)")).toBe(true);
    expect(sent.some((m) => m.to.includes("old@members.test"))).toBe(false);
  });

  it("says a drop-in was paid, or a waiter moved in, and sends nothing for a correction", async () => {
    const records = { "bookings.class": [CLASS], "bookings.booking": [booking({})] };
    const paid = host(records);
    await paid.runAutomation("bookingConfirmed", {
      record: { object: "bookings.booking", id: "bkg_1" },
      change: { action: "updated", diff: { state: { before: "pending", after: "booked" } } },
    });
    expect(mails(paid)[0]).toMatchObject({ subject: "Booked and paid: Strength" });
    expect(mails(paid)[0]?.text).toContain("Payment received: you are booked into Strength");

    const promoted = host(records);
    await promoted.runAutomation("bookingConfirmed", {
      record: { object: "bookings.booking", id: "bkg_1" },
      change: { action: "updated", diff: { state: { before: "waiting", after: "booked" } } },
    });
    expect(mails(promoted)[0]).toMatchObject({ subject: "You're in: Strength" });
    expect(mails(promoted)[0]?.text).toContain("moved in from the waiting list");

    const undone = host(records);
    const run = await undone.runAutomation("bookingConfirmed", {
      record: { object: "bookings.booking", id: "bkg_1" },
      change: { action: "updated", diff: { state: { before: "attended", after: "booked" } } },
    });
    expect(run.undeclared).toEqual([]);
    expect(undone.gatekeeperCalls).toEqual([]);
  });

  it("does not run for a booking that is not booked, nor write about a visitor's unpaid hold", async () => {
    const waiting = host({
      "bookings.class": [CLASS],
      "bookings.booking": [booking({ state: "waiting" })],
    });
    const run = await waiting.runAutomation("bookingConfirmed", {
      record: { object: "bookings.booking", id: "bkg_1" },
      change: { action: "created", diff: {} },
    });
    expect(run.matched).toBe(false);
    expect(waiting.gatekeeperCalls).toEqual([]);

    // A guest's booking with no Person (ADR 0560): nobody to write to.
    const guest = host({
      "bookings.class": [CLASS],
      "bookings.booking": [booking({ person: null })],
    });
    await guest.runAutomation("bookingConfirmed", {
      record: { object: "bookings.booking", id: "bkg_1" },
      change: { action: "created", diff: {} },
    });
    expect(guest.gatekeeperCalls).toEqual([]);
  });
});

describe("the waiting list", () => {
  it("tells a waiter passed over why, and that they stay on the list", async () => {
    const h = host({
      "bookings.class": [CLASS],
      "bookings.booking": [booking({ state: "waiting", passedOverReason: "no_uses_left" })],
    });
    const run = await h.runAutomation("waitlistPassedOver", {
      record: { object: "bookings.booking", id: "bkg_1" },
      change: {
        action: "updated",
        diff: { passedOverReason: { before: null, after: "no_uses_left" } },
      },
    });
    expect(run.undeclared).toEqual([]);
    const [mail] = mails(h);
    expect(mail?.subject).toBe("A place came free: Strength");
    expect(mail?.text).toContain("we could not move you in: there are no classes left");
    expect(mail?.text).toContain("You are still on the waiting list");
    expect(mail?.calendar).toBeUndefined();
  });

  it("tells everyone waiting of a place freed after the cut-off, and nobody before it", async () => {
    const soon = { ...CLASS, startsAt: inHours(1), endsAt: inHours(2) };
    const waiting = [
      booking({ id: "bkg_w1", state: "waiting", person: "per_bob" }),
      booking({ id: "bkg_w2", state: "waiting", person: "per_sam" }),
      booking({ id: "bkg_gone", state: "cancelled", person: "per_ann" }),
    ];
    const free = { "capacity.get": () => ({ status: "available", available: 1 }) };
    const h = host({ "bookings.class": [soon], "bookings.booking": waiting }, free);
    const run = await h.runAutomation("placeFree", {
      record: { object: "bookings.booking", id: "bkg_gone" },
      change: { action: "updated", diff: { state: { before: "booked", after: "cancelled" } } },
    });
    expect(run.undeclared).toEqual([]);
    const sent = mails(h);
    expect(sent.map((m) => m.to[0]).sort()).toEqual([
      "bob@members.test",
      "kim@members.test",
      "pat@members.test",
    ]);
    // One person's email never names the person who gave the place back, or the others waiting.
    for (const m of sent) {
      expect(m.text).not.toContain("Ann");
      expect(m.relatedRecords).toEqual(["cls_1"]);
    }
    expect(sent.find((m) => m.to[0] === "pat@members.test")?.text).toContain(
      "Book it for Sam Child",
    );

    // Three hours before (before the 2-hour cut-off) the place went to the waiting list.
    const early = host(
      { "bookings.class": [{ ...CLASS, startsAt: inHours(3) }], "bookings.booking": waiting },
      free,
    );
    await early.runAutomation("placeFree", {
      record: { object: "bookings.booking", id: "bkg_gone" },
      change: { action: "updated", diff: { state: { before: "booked", after: "cancelled" } } },
    });
    expect(early.gatekeeperCalls).toEqual([]);
    // After the cut-off with no free place (someone took it): nothing.
    const full = host(
      { "bookings.class": [soon], "bookings.booking": waiting },
      {
        "capacity.get": () => ({ status: "sold_out", available: 0 }),
      },
    );
    await full.runAutomation("placeFree", {
      record: { object: "bookings.booking", id: "bkg_gone" },
      change: { action: "updated", diff: { state: { before: "booked", after: "cancelled" } } },
    });
    expect(full.gatekeeperCalls).toEqual([]);
  });
});

describe("a change or a cancellation by the gym", () => {
  const records = {
    "bookings.class": [CLASS],
    "bookings.booking": [
      booking({}),
      booking({ id: "bkg_2", person: "per_bob", state: "waiting" }),
      booking({ id: "bkg_3", person: "per_bob", state: "cancelled" }),
    ],
  };

  it("emails a new time to those booked and waiting, with an updated calendar file to the booked", async () => {
    const h = host(records);
    const run = await h.runAutomation("classChanged", {
      record: { object: "bookings.class", id: "cls_1" },
      change: {
        action: "updated",
        diff: { startsAt: { before: inHours(29), after: CLASS.startsAt } },
      },
    });
    expect(run.undeclared).toEqual([]);
    const sent = mails(h);
    expect(sent.map((m) => m.to[0])).toEqual(["ann@members.test", "bob@members.test"]);
    expect(sent[0]?.text).toContain("has moved to");
    expect(sent[0]?.calendar).toMatchObject({ uid: "bkg_1", start: CLASS.startsAt });
    expect(sent[0]?.calendar?.sequence).toEqual(expect.any(Number));
    expect(sent[1]?.text).toContain("Your place on the waiting list stays");
    expect(sent[1]?.calendar).toBeUndefined();
  });

  it("sends nothing for a coach swap (decision 16)", async () => {
    const h = host(records);
    const run = await h.runAutomation("classChanged", {
      record: { object: "bookings.class", id: "cls_1" },
      change: { action: "updated", diff: { coach: { before: "coach_1", after: "coach_2" } } },
    });
    expect(run.undeclared).toEqual([]);
    expect(h.gatekeeperCalls).toEqual([]);
  });

  it("emails everyone the cancel cancelled, the drop-in payer that the money goes back", async () => {
    const h = host(
      {
        "bookings.class": [{ ...CLASS, state: "cancelled", cancelledReason: "Coach unwell" }],
        "bookings.booking": [
          booking({ state: "cancelled_by_us" }),
          booking({
            id: "bkg_d",
            person: "per_bob",
            state: "cancelled_by_us",
            dropInOrder: "ord_1",
          }),
          booking({ id: "bkg_x", person: "per_bob", state: "cancelled" }),
        ],
      },
      {
        "order.get": () => ({ id: "ord_1", state: "paid", paid: 2500, email: "bob@members.test" }),
      },
    );
    const run = await h.runAutomation("classCancelled", {
      record: { object: "bookings.class", id: "cls_1" },
      change: { action: "updated", diff: { state: { before: "scheduled", after: "cancelled" } } },
    });
    expect(run.undeclared).toEqual([]);
    const sent = mails(h);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.text).toContain("The reason: Coach unwell");
    expect(sent[0]?.text).toContain("Nothing was used from your membership or pass.");
    expect(sent[0]?.calendar).toMatchObject({ uid: "bkg_1", cancelled: true });
    expect(sent[1]?.to).toEqual(["bob@members.test"]);
    expect(sent[1]?.text).toContain(
      "goes back to the card it was paid with, once the gym approves",
    );
  });

  it("tells a visitor whose paid drop-in was not yet matched to anyone, at the order's address", async () => {
    const h = host(
      {
        "bookings.class": [{ ...CLASS, state: "cancelled" }],
        "bookings.booking": [
          booking({ id: "bkg_g", person: null, state: "cancelled_by_us", dropInOrder: "ord_g" }),
          booking({ id: "bkg_u", person: null, state: "cancelled_by_us", dropInOrder: "ord_u" }),
        ],
      },
      {
        "order.get": (input) =>
          input.id === "ord_g"
            ? { id: "ord_g", state: "paid", paid: 2500, email: "Visitor@Elsewhere.test" }
            : { id: "ord_u", state: "cancelled", paid: 0, email: "unpaid@elsewhere.test" },
      },
    );
    const run = await h.runAutomation("classCancelled", {
      record: { object: "bookings.class", id: "cls_1" },
    });
    expect(run.undeclared).toEqual([]);
    // The paid one is told its money is on its way; the unpaid hold is nobody's and hears nothing.
    expect(mails(h)).toEqual([
      expect.objectContaining({
        to: ["visitor@elsewhere.test"],
        subject: "Cancelled by the gym: Strength",
        relatedRecords: ["bkg_g", "cls_1", "ord_g"],
      }),
    ]);
    expect(mails(h)[0]?.text).toContain("which you paid for");
    expect(mails(h)[0]?.calendar).toBeUndefined();
  });
});

describe("classReminder", () => {
  it("reminds everyone booked, and nobody waiting or cancelled", async () => {
    const h = host({
      "bookings.class": [CLASS],
      "bookings.booking": [
        booking({}),
        booking({ id: "bkg_2", person: "per_bob", state: "waiting" }),
        booking({ id: "bkg_3", person: "per_bob", state: "late_cancelled" }),
        booking({ id: "bkg_4", person: "per_sam" }),
      ],
    });
    const run = await h.runAutomation("classReminder", {
      record: { object: "bookings.class", id: "cls_1" },
      period: inHours(-0.01),
    });
    expect(run.undeclared).toEqual([]);
    const sent = mails(h);
    expect(sent.map((m) => m.to[0])).toEqual([
      "ann@members.test",
      "pat@members.test",
      "kim@members.test",
    ]);
    expect(sent[0]?.subject).toBe("Reminder: Strength");
    expect(sent[1]?.subject).toBe("Reminder: Strength (Sam Child)");
  });

  it("does not run for a cancelled class", async () => {
    const h = host({
      "bookings.class": [{ ...CLASS, state: "cancelled" }],
      "bookings.booking": [booking({})],
    });
    const run = await h.runAutomation("classReminder", {
      record: { object: "bookings.class", id: "cls_1" },
    });
    expect(run.matched).toBe(false);
    expect(h.gatekeeperCalls).toEqual([]);
  });
});

describe("dropInRefunded", () => {
  it("tells the payer the refund was made, and nothing for an order that paid for no class", async () => {
    const ops = {
      "order.get": () => ({ id: "ord_1", state: "refunded", email: "Payer@Members.test" }),
    };
    const h = host(
      {
        "bookings.class": [CLASS],
        "bookings.booking": [booking({ state: "cancelled_by_us", dropInOrder: "ord_1" })],
        order: [{ id: "ord_1", state: "refunded" }],
      },
      ops,
    );
    const run = await h.runAutomation("dropInRefunded", {
      record: { object: "order", id: "ord_1" },
    });
    expect(run.undeclared).toEqual([]);
    expect(mails(h)).toEqual([
      expect.objectContaining({ to: ["payer@members.test"], subject: "Refund made: Strength" }),
    ]);

    const other = host(
      { "bookings.booking": [], order: [{ id: "ord_9", state: "refunded" }] },
      ops,
    );
    await other.runAutomation("dropInRefunded", { record: { object: "order", id: "ord_9" } });
    expect(other.gatekeeperCalls).toEqual([]);
  });
});

describe("noAttendanceTaken", () => {
  it("tells the admins when people were booked and nobody was marked", async () => {
    const h = host({
      "bookings.class": [CLASS],
      "bookings.booking": [booking({}), booking({ id: "b2" })],
    });
    const run = await h.runAutomation("noAttendanceTaken", {
      record: { object: "bookings.class", id: "cls_1" },
    });
    expect(run.undeclared).toEqual([]);
    expect(run.value).toEqual({ notified: true, booked: 2, marked: 0 });
    expect(run.notifications).toHaveLength(1);
  });

  it("says nothing once anyone on it was marked", async () => {
    const h = host({
      "bookings.class": [CLASS],
      "bookings.booking": [booking({}), booking({ id: "b2", state: "attended" })],
    });
    const run = await h.runAutomation("noAttendanceTaken", {
      record: { object: "bookings.class", id: "cls_1" },
    });
    expect(run.value).toMatchObject({ notified: false, marked: 1 });
    expect(run.notifications).toEqual([]);
  });
});

describe("classTimeText", () => {
  it("is the class's local time with its zone, across a clock change", () => {
    // Sydney moves from +10 to +11 on 4 October 2026: 06:00 local on both sides.
    expect(classTimeText("2026-10-02T20:00:00.000Z", "Australia/Sydney")).toBe(
      "Saturday 3 October at 06:00 (Australia/Sydney time)",
    );
    expect(classTimeText("2026-10-05T19:00:00.000Z", "Australia/Sydney")).toBe(
      "Tuesday 6 October at 06:00 (Australia/Sydney time)",
    );
  });
});
