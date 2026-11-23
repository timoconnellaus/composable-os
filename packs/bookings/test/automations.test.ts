// The Bookings messages (step 9) against the SDK's test host: each automation's declared trigger
// and conditions, and which routine email (ADR 0590) it asks the host for: the kind, the message,
// the booking it is about and the declared choices and flags it passes. Who it goes to (the
// booking's Person and their live guardians, a paid visitor's order address) and what it says are
// the host's, from the declaration (routine-mail.ts): tested on the real host in
// apps/runner/test/bookings-messages.test.ts and apps/runner/test/routine-mail.test.ts. The
// declaration's words are rendered here as the host renders them.
import { parseTemplate, type RoutineSendInput, renderTemplate } from "@composable-os/sdk";
import { createTestHost } from "@composable-os/sdk/testing";
import { describe, expect, it } from "vitest";
import { bookedKind, passedOverChoice } from "../automations.ts";
import bookings from "../index.ts";
import { bookingsRoutineMail } from "../routine-mail.ts";

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

function host(
  records: Record<string, Record<string, unknown>[]>,
  operations: Record<string, (input: Record<string, unknown>) => unknown> = {},
  routineMail?: (send: RoutineSendInput) => {
    sent: number;
    held: number;
    off: boolean;
    none: boolean;
  },
) {
  return createTestHost(bookings, {
    validate: { knownObjects: ["programs.classtype"] },
    ...(routineMail ? { routineMail } : {}),
    records: {
      "bookings.room": [{ id: "room_1", name: "Studio A" }],
      "programs.classtype": [{ id: "ct_1", name: "Strength" }],
      ...records,
    } as never,
    operations: {
      "extensionSettings.list": (input) => {
        // Only this extension's settings are asked for.
        expect(input).toEqual({ extension: "bookings" });
        return { items: [{ id: "bookings", values: { promotionMinutes: 120 } }] };
      },
      ...operations,
    },
  });
}

/** What the automation asked the host to send, without the step. */
const asked = (h: ReturnType<typeof host>) =>
  h.routineSends.map(({ step: _step, ...send }) => send);

const booking = (values: Record<string, unknown>) => ({
  id: "bkg_1",
  class: "cls_1",
  person: "per_ann",
  state: "booked",
  ...values,
});

describe("the manifest", () => {
  it("passes the contract with its automations and routine mail, and declares each trigger", () => {
    expect(
      createTestHost(bookings, { validate: { knownObjects: ["programs.classtype"] } }).issues,
    ).toEqual([]);
    const a = bookings.automations ?? {};
    expect(Object.keys(a).sort()).toEqual([
      "bookingConfirmed",
      "classCancelled",
      "classChanged",
      "classReminder",
      "dropInOrder",
      "noAttendanceTaken",
      "placeFree",
      "waitlistPassedOver",
    ]);
    expect(Object.keys(bookings.routineMail ?? {}).sort()).toEqual([
      "cancellation",
      "change",
      "confirmation",
      "dropIn",
      "reminder",
      "waitingList",
    ]);
    expect(bookings.permissions?.modules).toContain("routine-mail");
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
    // Every mail goes out from the one email-send connection a person binds; the staff notice
    // is in the app.
    for (const [name, automation] of Object.entries(a)) {
      if (name === "noAttendanceTaken") expect(automation.connections).toBeUndefined();
      else
        expect(automation.connections).toEqual([
          expect.objectContaining({ gatekeeper: "email-send" }),
        ]);
    }
    expect(bookings.settings?.reminderMinutes).toMatchObject({ default: 180, max: 2_880 });
    expect(bookings.settings?.bookingsUrl).toMatchObject({ personApproves: true });
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
    expect(bookedKind(moved("attended"), {})).toBeNull();
    expect(
      bookedKind({ action: "updated", diff: { note: { before: null, after: "x" } } }, {}),
    ).toBeNull();
  });

  it("asks for the booking's confirmation once, naming the booking and nothing else", async () => {
    const h = host({ "bookings.class": [CLASS], "bookings.booking": [booking({})] });
    const run = await h.runAutomation("bookingConfirmed", {
      record: { object: "bookings.booking", id: "bkg_1" },
      change: { action: "created", diff: {} },
    });
    expect(run.matched).toBe(true);
    expect(run.undeclared).toEqual([]);
    expect(run.error).toBeNull();
    expect(asked(h)).toEqual([{ kind: "confirmation", record: "bkg_1", message: "booked" }]);
    expect(h.routineSends[0]?.step).toBe("send");
    expect(h.gatekeeperCalls).toEqual([]);
  });

  it("says a drop-in was paid, or a waiter moved in, and asks nothing for a correction", async () => {
    const records = { "bookings.class": [CLASS], "bookings.booking": [booking({})] };
    for (const [before, message] of [
      ["pending", "paid"],
      ["waiting", "promoted"],
    ] as const) {
      const h = host(records);
      await h.runAutomation("bookingConfirmed", {
        record: { object: "bookings.booking", id: "bkg_1" },
        change: { action: "updated", diff: { state: { before, after: "booked" } } },
      });
      expect(asked(h)).toEqual([{ kind: "confirmation", record: "bkg_1", message }]);
    }
    const undone = host(records);
    await undone.runAutomation("bookingConfirmed", {
      record: { object: "bookings.booking", id: "bkg_1" },
      change: { action: "updated", diff: { state: { before: "attended", after: "booked" } } },
    });
    expect(undone.routineSends).toEqual([]);
  });

  it("does not run for a booking that is not booked, and asks nothing once it is not", async () => {
    const waiting = host({
      "bookings.class": [CLASS],
      "bookings.booking": [booking({ state: "waiting" })],
    });
    const run = await waiting.runAutomation("bookingConfirmed", {
      record: { object: "bookings.booking", id: "bkg_1" },
      change: { action: "created", diff: {} },
    });
    expect(run.matched).toBe(false);
    expect(waiting.routineSends).toEqual([]);
  });

  it("asks for a staff move's message (the host attaches both calendar files)", async () => {
    const h = host({
      "bookings.class": [CLASS],
      "bookings.booking": [booking({ movedFrom: "bkg_0" })],
    });
    await h.runAutomation("bookingConfirmed", {
      record: { object: "bookings.booking", id: "bkg_1" },
      change: { action: "created", diff: {} },
    });
    expect(asked(h)).toEqual([{ kind: "confirmation", record: "bkg_1", message: "moved" }]);
  });
});

describe("the waiting list", () => {
  it("tells a waiter passed over why, in the declared words", async () => {
    expect(passedOverChoice("no_uses_left")).toBe("noUsesLeft");
    expect(passedOverChoice("ended")).toBe("notLive");
    expect(passedOverChoice("not_live")).toBe("notLive");
    expect(passedOverChoice("not_covered")).toBe("notCovered");
    expect(passedOverChoice("anything else")).toBe("other");
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
    expect(asked(h)).toEqual([
      {
        kind: "waitingList",
        record: "bkg_1",
        message: "passedOver",
        values: { why: "noUsesLeft" },
      },
    ]);
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
    // About each waiter's own booking: never the one given back.
    expect(asked(h)).toEqual([
      { kind: "waitingList", record: "bkg_w1", message: "placeFree" },
      { kind: "waitingList", record: "bkg_w2", message: "placeFree" },
    ]);
    // Three hours before (before the 2-hour cut-off) the place went to the waiting list.
    const early = host(
      { "bookings.class": [{ ...CLASS, startsAt: inHours(3) }], "bookings.booking": waiting },
      free,
    );
    await early.runAutomation("placeFree", {
      record: { object: "bookings.booking", id: "bkg_gone" },
      change: { action: "updated", diff: { state: { before: "booked", after: "cancelled" } } },
    });
    expect(early.routineSends).toEqual([]);
    // After the cut-off with no free place (someone took it): nothing.
    const full = host(
      { "bookings.class": [soon], "bookings.booking": waiting },
      { "capacity.get": () => ({ status: "sold_out", available: 0 }) },
    );
    await full.runAutomation("placeFree", {
      record: { object: "bookings.booking", id: "bkg_gone" },
      change: { action: "updated", diff: { state: { before: "booked", after: "cancelled" } } },
    });
    expect(full.routineSends).toEqual([]);
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

  it("a new time: those booked and waiting, an updated calendar file for the booked", async () => {
    const before = inHours(29);
    const h = host(records);
    const run = await h.runAutomation("classChanged", {
      record: { object: "bookings.class", id: "cls_1" },
      change: { action: "updated", diff: { startsAt: { before, after: CLASS.startsAt } } },
    });
    expect(run.undeclared).toEqual([]);
    const flags = { moved: true, notMoved: false, before, endChanged: false, roomChanged: false };
    expect(asked(h)).toEqual([
      {
        kind: "change",
        record: "bkg_1",
        message: "changed",
        values: { ...flags, stays: "booking", keep: true },
      },
      {
        kind: "change",
        record: "bkg_2",
        message: "changed",
        values: { ...flags, stays: "waiting", keep: false },
      },
    ]);
  });

  it("sends nothing for a coach swap (decision 16)", async () => {
    const h = host(records);
    const run = await h.runAutomation("classChanged", {
      record: { object: "bookings.class", id: "cls_1" },
      change: { action: "updated", diff: { coach: { before: "coach_1", after: "coach_2" } } },
    });
    expect(run.undeclared).toEqual([]);
    expect(h.routineSends).toEqual([]);
  });

  it("a cancellation: each booking it cancelled; a paid drop-in's money goes back", async () => {
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
          booking({ id: "bkg_u", person: null, state: "cancelled_by_us", dropInOrder: "ord_2" }),
          booking({ id: "bkg_x", person: "per_bob", state: "cancelled" }),
        ],
      },
      {
        "order.get": (input) =>
          input.id === "ord_1" ? { id: "ord_1", state: "paid", paid: 2500 } : { state: "expired" },
      },
    );
    const run = await h.runAutomation("classCancelled", {
      record: { object: "bookings.class", id: "cls_1" },
      change: { action: "updated", diff: { state: { before: "scheduled", after: "cancelled" } } },
    });
    expect(run.undeclared).toEqual([]);
    expect(asked(h)).toEqual([
      {
        kind: "cancellation",
        record: "bkg_1",
        message: "cancelled",
        values: { money: "membership" },
      },
      { kind: "cancellation", record: "bkg_d", message: "cancelled", values: { money: "refund" } },
      { kind: "cancellation", record: "bkg_u", message: "cancelled", values: { money: "unpaid" } },
    ]);
  });
});

describe("classReminder", () => {
  it("reminds everyone booked and a visitor's paid hold, nobody waiting or cancelled", async () => {
    const h = host({
      "bookings.class": [CLASS],
      "bookings.booking": [
        booking({}),
        booking({ id: "bkg_w", state: "waiting" }),
        booking({ id: "bkg_c", state: "cancelled" }),
        booking({ id: "bkg_v", person: null, state: "pending", dropInOrder: "ord_1" }),
        booking({ id: "bkg_p", person: "per_bob", state: "pending", dropInOrder: "ord_2" }),
      ],
    });
    const run = await h.runAutomation("classReminder", {
      record: { object: "bookings.class", id: "cls_1" },
    });
    expect(run.undeclared).toEqual([]);
    expect(asked(h)).toEqual([
      { kind: "reminder", record: "bkg_1", message: "reminder" },
      { kind: "reminder", record: "bkg_v", message: "reminder" },
    ]);
  });

  it("does not run for a cancelled class, nor remind of one already started", async () => {
    const cancelled = host({
      "bookings.class": [{ ...CLASS, state: "cancelled" }],
      "bookings.booking": [booking({})],
    });
    const run = await cancelled.runAutomation("classReminder", {
      record: { object: "bookings.class", id: "cls_1" },
    });
    expect(run.matched).toBe(false);
    const started = host({
      "bookings.class": [{ ...CLASS, startsAt: inHours(-1) }],
      "bookings.booking": [booking({})],
    });
    await started.runAutomation("classReminder", {
      record: { object: "bookings.class", id: "cls_1" },
    });
    expect(started.routineSends).toEqual([]);
  });
});

describe("dropInOrder", () => {
  it("the refund made; nothing for an order that paid for no class", async () => {
    const h = host(
      {
        "bookings.class": [CLASS],
        "bookings.booking": [booking({ state: "cancelled", dropInOrder: "ord_1" })],
        order: [{ id: "ord_1", state: "refunded" }],
      },
      { "order.get": () => ({ id: "ord_1", state: "refunded", paid: 2500 }) },
    );
    const run = await h.runAutomation("dropInOrder", { record: { object: "order", id: "ord_1" } });
    expect(run.undeclared).toEqual([]);
    expect(asked(h)).toEqual([{ kind: "dropIn", record: "ord_1", message: "refunded" }]);
    const other = host(
      {
        "bookings.class": [CLASS],
        "bookings.booking": [],
        order: [{ id: "ord_9", state: "refunded" }],
      },
      { "order.get": () => ({ id: "ord_9", state: "refunded", paid: 100 }) },
    );
    await other.runAutomation("dropInOrder", { record: { object: "order", id: "ord_9" } });
    expect(other.routineSends).toEqual([]);
  });

  it("a visitor's payment staff still have to settle: held; nothing once it has a Person", async () => {
    const held = host(
      {
        "bookings.class": [CLASS],
        "bookings.booking": [booking({ person: null, state: "pending", dropInOrder: "ord_1" })],
        order: [{ id: "ord_1", state: "paid" }],
      },
      { "order.get": () => ({ id: "ord_1", state: "paid", paid: 2500 }) },
    );
    await held.runAutomation("dropInOrder", { record: { object: "order", id: "ord_1" } });
    expect(asked(held)).toEqual([{ kind: "dropIn", record: "ord_1", message: "held" }]);
    const settled = host(
      {
        "bookings.class": [CLASS],
        "bookings.booking": [booking({ state: "booked", dropInOrder: "ord_1" })],
        order: [{ id: "ord_1", state: "paid" }],
      },
      { "order.get": () => ({ id: "ord_1", state: "paid", paid: 2500 }) },
    );
    await settled.runAutomation("dropInOrder", { record: { object: "order", id: "ord_1" } });
    expect(settled.routineSends).toEqual([]);
  });
});

describe("several changes to one class", () => {
  it("are told once, by the last run, with all of them", async () => {
    const h = host({ "bookings.class": [CLASS], "bookings.booking": [booking({})] });
    // An earlier run noted a room change and is still settling (the test host skips the wait,
    // so its note is set here): the time change a moment later takes the turn.
    await h.storage.set("changed:cls_1", {
      startsBefore: null,
      time: false,
      end: false,
      room: true,
      turn: "run_room",
    });
    const run = await h.runAutomation("classChanged", {
      record: { object: "bookings.class", id: "cls_1" },
      change: {
        action: "updated",
        diff: { startsAt: { before: inHours(29), after: CLASS.startsAt } },
      },
      runId: "run_time",
    });
    expect(run.undeclared).toEqual([]);
    expect(asked(h)).toEqual([
      expect.objectContaining({
        values: expect.objectContaining({ moved: true, roomChanged: true }),
      }),
    ]);
    // Told: the turn is given up, so the room run, waking, finds nothing to tell.
    expect(h.storage.get("changed:cls_1")).toBeUndefined();
  });

  it("changed and changed back tells nothing; an end-only change is told, with the file", async () => {
    const h = host({ "bookings.class": [CLASS], "bookings.booking": [booking({})] });
    await h.runAutomation("classChanged", {
      record: { object: "bookings.class", id: "cls_1" },
      change: {
        action: "updated",
        diff: { startsAt: { before: CLASS.startsAt, after: CLASS.startsAt } },
      },
      runId: "run_back",
    });
    expect(h.routineSends).toEqual([]);
    await h.runAutomation("classChanged", {
      record: { object: "bookings.class", id: "cls_1" },
      change: {
        action: "updated",
        diff: { endsAt: { before: inHours(30.5), after: CLASS.endsAt } },
      },
      runId: "run_end",
    });
    expect(asked(h)).toEqual([
      {
        kind: "change",
        record: "bkg_1",
        message: "changed",
        values: {
          moved: false,
          notMoved: true,
          endChanged: true,
          roomChanged: false,
          stays: "booking",
          keep: true,
        },
      },
    ]);
  });
});

describe("a send that fails part way, retried", () => {
  it("keeps the class's turn, so the retry still tells; the turn goes after the send", async () => {
    let failed = false;
    const h = host({ "bookings.class": [CLASS], "bookings.booking": [booking({})] }, {}, () => {
      if (!failed) {
        failed = true;
        throw new Error("the queue is full");
      }
      return { sent: 1, held: 0, off: false, none: false };
    });
    const run = await h.runAutomation("classChanged", {
      record: { object: "bookings.class", id: "cls_1" },
      change: {
        action: "updated",
        diff: { endsAt: { before: inHours(30.5), after: CLASS.endsAt } },
      },
      runId: "run_blip",
      retries: 2,
    });
    expect(run.error).toBeNull();
    expect(failed).toBe(true);
    expect(run.steps.map((s) => s.name)).toEqual(["note", "settle", "compose", "send", "release"]);
    expect(h.storage.get("changed:cls_1")).toBeUndefined();
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

describe("the declared words, as the host renders them", () => {
  const values = {
    class: "Strength",
    when: "Monday 7 December at 06:00 (Australia/Sydney time)",
    room: "Studio A",
    link: "https://gym.example/bookings",
    member: "Sam",
  };
  const render = (template: string, extra: Record<string, string | null> = {}) =>
    renderTemplate(parseTemplate(template), { ...values, ...extra });

  it("tells the member, and a parent naming the child", () => {
    const booked = bookingsRoutineMail.confirmation.messages.booked;
    expect(render(booked.subject)).toBe("Booked: Strength");
    expect(render(booked.text)).toBe(
      [
        "You are booked into Strength on Monday 7 December at 06:00 (Australia/Sydney time), in Studio A.",
        "",
        "The attached file adds it to your calendar.",
        "You can see your bookings when you sign in: https://gym.example/bookings.",
      ].join("\n"),
    );
    expect(render(booked.guardian.subject)).toBe("Booked: Strength (Sam)");
    expect(render(booked.guardian.text)).toContain("Sam is booked into Strength");
  });

  it("leaves out what is empty: no room, no link", () => {
    const reminder = bookingsRoutineMail.reminder.messages.reminder;
    expect(render(reminder.text, { room: null, link: null })).toBe(
      [
        "A reminder: you are booked into Strength on Monday 7 December at 06:00 (Australia/Sydney time).",
        "If you cannot come, cancel when you sign in, so someone waiting can have the place.",
        "",
        "You can see your bookings when you sign in.",
      ].join("\n"),
    );
  });

  it("says a change as the flags say", () => {
    const changed = bookingsRoutineMail.change.messages.changed;
    const moved = render(changed.text, {
      moved: "",
      notMoved: null,
      before: "Sunday 6 December at 06:00 (Australia/Sydney time)",
      endChanged: null,
      roomChanged: null,
      ends: "07:00",
      stays: "booking stays",
      keep: "",
    });
    expect(moved).toContain(
      "Strength on Sunday 6 December at 06:00 (Australia/Sydney time) has moved to Monday 7 December at 06:00 (Australia/Sydney time).",
    );
    expect(moved).toContain("Your booking stays as it is.");
    expect(moved).toContain("The attached file updates it in your calendar.");
    expect(moved).not.toContain("ends at");
  });
});
