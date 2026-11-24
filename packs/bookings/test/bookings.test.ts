// The Bookings pack against the SDK's test host: the manifest passes the contract, declares the
// behaviours the spine composes (recurring, capacity and claims, uniqueness, windows and the
// staff-only rule over the class type's or the organisation's numbers, the requested cancel, the
// allowance spender for the Memberships pack's holders), and every tool asks the host what it
// should and passes on what the host answered. The host's rules themselves (windows by its clock,
// places refused by the database, a spend and its give-back) are tested against the real host in
// apps/runner/test/bookings.test.ts, which runs this same pack in the sandbox.
import { createTestHost, ExtensionToolError } from "@composable-os/sdk/testing";
import { describe, expect, it } from "vitest";
import bookings from "../index.ts";
import { localMidnight } from "../tools.ts";

const STAFF = { kind: "staff", userId: "usr_desk", name: "Desk" } as const;
const MEMBER = { kind: "customer", customerId: "cus_1", personId: "per_member" } as const;
const PUBLIC = { kind: "public" } as const;

const CLASS = {
  id: "cls_1",
  title: "Strength",
  classType: "ct_1",
  startsAt: "2026-12-01T19:00:00.000Z",
  endsAt: "2026-12-01T20:00:00.000Z",
  timezone: "Australia/Sydney",
  room: "room_1",
  coach: "coach_1",
  notes: "Bring a towel",
  state: "scheduled",
  places: 12,
  taken: 3,
  held: 0,
  available: 9,
};

const refusal = (rule: string, extra: Record<string, unknown> = {}) => {
  throw new ExtensionToolError("invalid_input", `Refused: ${rule}`, { rule, ...extra });
};

function host(operations: Record<string, (input: Record<string, unknown>) => unknown> = {}) {
  return createTestHost(bookings, {
    validate: { knownObjects: ["programs.classtype"] },
    records: {
      "bookings.class": [CLASS],
      "bookings.coach": [{ id: "coach_1", name: "Robin", photo: null }],
      "bookings.room": [{ id: "room_1", name: "Main room" }],
      "programs.classtype": [{ id: "ct_1", name: "Strength", "bookings.staffOnly": true }],
      "bookings.booking": [
        { id: "bkg_1", class: "cls_1", person: "per_ann", state: "booked", paidOtherwise: true },
      ],
      person: [{ id: "per_ann", displayName: "Ann" }],
    },
    operations: {
      "public.list": (input) => {
        const rows: Record<string, Record<string, unknown>[]> = {
          "bookings.class": [CLASS],
          "bookings.coach": [{ id: "coach_1", name: "Robin", photo: null }],
          "bookings.room": [{ id: "room_1", name: "Main room" }],
        };
        const items = (rows[String(input.object)] ?? []).map(({ id, ...values }) => ({
          id,
          values,
        }));
        return { items, nextCursor: null };
      },
      "public.get": (input) => {
        if (input.id !== "cls_1") throw new ExtensionToolError("not_found", "No such class");
        const { id, ...values } = CLASS;
        return { id, values };
      },
      "capacity.get": () => ({
        object: "bookings.class",
        id: "cls_1",
        status: "available",
        available: 9,
      }),
      "person.get": (input) =>
        input.id === "per_ann" ? { id: "per_ann", displayName: "Ann" } : null,
      // A list's health notes (stage 44): the host's yes or no per Person, nothing of the form.
      // The host reads the class's bookings' People itself; the pack names only the list.
      "agreement.listHealthNotes": (input) => {
        expect(input).toEqual({ records: "bookings.booking", value: "cls_1" });
        return { notes: [{ personId: "per_ann", healthNote: true }] };
      },
      // The member and the child staff linked to them (ADR 0540), as the host says.
      "me.family": () => ({
        self: { personId: "per_me", name: "Mo" },
        dependants: [{ personId: "per_kid", name: "Kit" }],
        guardians: [],
      }),
      ...operations,
    },
  });
}

describe("bookings pack (test host)", () => {
  it("passes the contract and formula checks and requires Programs", () => {
    const h = host();
    expect(h.issues).toEqual([]);
    expect(h.manifest.requires).toEqual(["programs"]);
    expect(Object.keys(h.manifest.objects)).toEqual([
      "room",
      "coach",
      "series",
      "class",
      "closure",
      "booking",
    ]);
    // Bookings' rules sit on Programs' class type; empty means the organisation's setting.
    expect(Object.keys(h.manifest.fields["programs.classtype"] ?? {})).toEqual([
      "colour",
      "opensDays",
      "closesMinutes",
      "lateMinutes",
      "promotionMinutes",
      "reminderMinutes",
      "dropInPrice",
      "staffOnly",
      // Pay only (stage 45 step 6, ADR 0627): set-up and pack-down minutes for the coach.
      "rosterBeforeMinutes",
      "rosterAfterMinutes",
    ]);
    expect(h.manifest.settings).toMatchObject({
      opensDays: { default: 7, max: 56 },
      closesMinutes: { default: 0 },
      lateMinutes: { default: 60 },
      promotionMinutes: { default: 120 },
      reminderMinutes: { default: 180 },
    });
  });

  it("declares the series' timetable, its horizon over the class type's window, and closures", () => {
    const series = host().manifest.objects.series;
    expect(series?.recurring).toMatchObject({
      generates: "class",
      link: "series",
      cancel: "cancelled",
      ended: { field: "state", in: ["ended"] },
      closures: { object: "closure", from: "fromDate", until: "untilDate" },
      horizonDays: 57,
      horizonAtLeast: { object: "programs.classtype", field: "opensDays" },
    });
  });

  it("declares a booking's place, one per person per class, and its windows from the class type or the org", () => {
    const booking = host().manifest.objects.booking;
    expect(booking?.claims).toMatchObject({
      on: "class",
      held: ["pending"],
      confirmed: ["booked", "attended", "no_show"],
    });
    expect(booking?.unique).toEqual([
      {
        fields: ["person", "class"],
        states: ["pending", "booked", "waiting", "attended", "no_show"],
      },
    ]);
    const states = booking?.states;
    expect(states?.create?.window).toEqual({
      from: {
        at: "class.startsAt",
        daysBefore: { field: "class.classType.opensDays", setting: "opensDays" },
        zone: "class.timezone",
      },
      until: {
        at: "class.startsAt",
        minutesBefore: { field: "class.classType.closesMinutes", setting: "closesMinutes" },
      },
    });
    expect(states?.create?.staffOnly).toEqual("class.classType.staffOnly");
    // A class that is not scheduled binds staff too (ADR 0507).
    expect(states?.create?.closed).toEqual("class.closed");
    // A class the host cancels moves its live bookings with it.
    expect(states?.follows).toEqual({
      relation: "class",
      when: { cancelled: "cancelled_by_us" },
      from: ["booked", "waiting", "pending", "attended", "no_show", "late_cancelled"],
    });
    // A member joins a waitlist (step 5, the host checks the class is full); nothing a customer
    // does creates a booking held while paying (step 8).
    expect(states?.create?.in).toEqual({
      waiting: ["staff", "customer", "host"],
      pending: ["host"],
    });
    expect(states?.requests).toEqual({ cancel: ["cancelled", "late_cancelled"] });
    const into = (to: string) => states?.moves.filter((m) => m.to === to) ?? [];
    // A customer cancels in time only until "late from", late only until the start (ADR 0493's
    // warning: a customer's cancel after the class must not return a use).
    expect(into("cancelled")).toEqual([
      expect.objectContaining({
        from: "booked",
        by: ["staff", "customer"],
        window: { until: expect.objectContaining({ at: "class.startsAt" }) },
      }),
    ]);
    expect(into("late_cancelled")[0]?.window).toEqual({
      from: expect.objectContaining({ at: "class.startsAt" }),
      until: "class.startsAt",
    });
    // Every move a customer makes leaves booked only inside a window, or leaves waiting.
    for (const move of states?.moves ?? []) {
      if (!move.by.includes("customer")) continue;
      expect(move.window !== undefined || move.from === "waiting").toBe(true);
    }
    // No customer move lands in a state later steps own.
    for (const state of ["waiting", "pending", "attended", "no_show", "moved", "cancelled_by_us"]) {
      expect(into(state).some((m) => m.by.includes("customer"))).toBe(false);
    }
  });

  it("declares the booking a spender the Memberships pack's holders pay, by the class's time", () => {
    const booking = host().manifest.objects.booking;
    expect(booking?.allowance).toEqual({
      spends: {
        person: "person",
        holder: "holder",
        spendIn: ["booked"],
        returnIn: ["cancelled", "excused", "cancelled_by_us", "moved"],
        at: "class.startsAt",
        copy: { classType: "class.classType" },
        local: { weekday: "weekday", minute: "minute", zone: "class.timezone" },
        movedFrom: { field: "movedFrom", state: "moved" },
        paidBy: ["memberships.membership", "memberships.pass"],
        waived: "paidOtherwise",
        // A membership ended by cooling off cancels its bookings ahead as the gym's (ADR 0647).
        released: "cancelled_by_us",
      },
    });
    // A member writes the class, the state (a cancel) and the holder they choose; never what
    // pays for it or whether it spends.
    expect(booking?.customer?.write).toEqual(["class", "state", "holder"]);
    // Which class and which holder are set when it is made, never after (ADR 0507).
    expect(booking?.customer?.createOnly).toEqual(["class", "holder"]);
  });

  it("grants record and my operations by object only, and keeps the booking rules a person's", () => {
    const m = host().manifest;
    expect(m.permissions.operations).toEqual([
      "order.startHeld",
      "public.list",
      "public.get",
      "capacity.get",
      "duplicate.check",
      "waitlist.position",
      "me.family",
      // The messages (step 9): a child's live guardians, a drop-in's order, the pack's settings,
      // and the staff notice. No record.* or my.* operation (granted by object).
      "person.link.list",
      "order.get",
      "extensionSettings.list",
      "notification.send",
      // A class list's "health note" mark (stage 44, decision 18).
      "agreement.listHealthNotes",
    ]);
    const rules = m.fields["programs.classtype"] ?? {};
    for (const name of [
      "opensDays",
      "closesMinutes",
      "lateMinutes",
      "promotionMinutes",
      "reminderMinutes",
      "dropInPrice",
      "staffOnly",
    ]) {
      expect(rules[name]?.personApproves, name).toBe(true);
      expect(m.settings[name === "staffOnly" ? "lateMinutes" : name]?.personApproves).toBe(true);
    }
    expect(m.objects.class?.fields.places?.required).toBe(true);
    expect(m.objects.class?.fields.timezone?.required).toBe(true);
  });

  it("opens to members and the public only what the timetable needs", () => {
    const m = host().manifest;
    expect(m.objects.class?.public?.when).toEqual({ field: "state", in: ["scheduled"] });
    expect(m.objects.class?.capacity).toEqual({ places: "places", show: "exact" });
    const open = Object.entries(m.tools)
      .filter(([, t]) => (t.audiences ?? []).some((a) => a !== "staff"))
      .map(([name, t]) => [name, t.audiences, t.risk]);
    expect(open).toEqual([
      ["timetable", ["customer", "public"], "read"],
      ["classGet", ["customer", "public"], "read"],
      ["book", ["customer"], "write"],
      ["buy", ["customer", "public"], "write"],
      ["cancel", ["customer"], "write"],
      ["leaveWaitlist", ["customer"], "write"],
      ["mine", ["customer"], "read"],
      ["family", ["customer"], "read"],
    ]);
    // A parent or guardian staff linked reads and books for the child (ADR 0540).
    expect(m.objects.booking?.customer?.guardians).toEqual({ write: true, madeBy: "madeBy" });
  });

  it("family: the member and the children staff linked to them, as the host says", async () => {
    const out = await host().runTool("family", {}, { caller: MEMBER });
    expect(out).toEqual({
      people: [
        { personId: "per_me", name: "Mo", self: true },
        { personId: "per_kid", name: "Kit", self: false },
      ],
    });
  });

  it("book for a child asks the host to make it the child's; the host checks the link", async () => {
    const asked: Record<string, unknown>[] = [];
    const h = host({
      "my.create": (input) => {
        asked.push(input);
        return { id: "bkg_kid", values: { holder: "pass_kid" } };
      },
    });
    expect(
      await h.runTool("book", { classId: "cls_1", forPersonId: "per_kid" }, { caller: MEMBER }),
    ).toMatchObject({ result: "booked", bookingId: "bkg_kid", holderId: "pass_kid" });
    expect(asked).toEqual([
      { object: "bookings.booking", values: { class: "cls_1" }, forPersonId: "per_kid" },
    ]);
    // A Person the host says is not there for them: told so, as for any unknown Person.
    const refused = host({
      "my.create": () => {
        throw new ExtensionToolError("not_found", "No person with id per_x", {
          object: "person",
          id: "per_x",
        });
      },
    });
    expect(
      await refused.runTool("book", { classId: "cls_1", forPersonId: "per_x" }, { caller: MEMBER }),
    ).toMatchObject({
      result: "refused",
      reason: "not_found",
      message: "You cannot book for that person.",
    });
  });

  it("declares a waitlist on the booking's place, stopping at the class type's or the org's time", () => {
    const m = host().manifest;
    expect(m.objects.booking?.claims?.waitlist).toEqual({
      state: "waiting",
      promote: "booked",
      until: {
        at: "class.startsAt",
        minutesBefore: { field: "class.classType.promotionMinutes", setting: "promotionMinutes" },
      },
      promotedAt: "promotedAt",
      passedOverAt: "passedOverAt",
      passedOverReason: "passedOverReason",
    });
    // A member or staff join; the host promotes, and a member moves themselves onto a free place
    // only, inside the booking window (the host never gives them a hold that way).
    expect(m.objects.booking?.states?.create?.in?.waiting).toEqual(["staff", "customer", "host"]);
    const promote = m.objects.booking?.states?.moves.find(
      (move) => move.from === "waiting" && move.to === "booked",
    );
    expect(promote?.by).toEqual(["host", "customer"]);
    expect(promote?.window).toBeDefined();
  });

  it("book joins a full class's waitlist (unless asked not to), with where they stand", async () => {
    const made: Record<string, unknown>[] = [];
    const full = host({
      "my.create": (input) => {
        made.push(input);
        const values = input.values as Record<string, unknown>;
        if (values.state !== "waiting") return refusal("capacity");
        return { id: "bkg_wait", values: { state: "waiting" } };
      },
      "waitlist.position": () => ({ position: 2, waiting: 3 }),
    });
    expect(await full.runTool("book", { classId: "cls_1" }, { caller: MEMBER })).toMatchObject({
      result: "waiting",
      bookingId: "bkg_wait",
      position: 2,
      waiting: 3,
    });
    expect(made.map((m) => m.values)).toEqual([
      { class: "cls_1" },
      { class: "cls_1", state: "waiting" },
    ]);
    // Nothing to pay with, and the class full: they may still wait (they are passed over later).
    const broke = host({
      "my.create": (input) =>
        (input.values as Record<string, unknown>).state === "waiting"
          ? { id: "bkg_w2", values: { state: "waiting" } }
          : refusal("allowance", { reason: "no_holder" }),
      "waitlist.position": () => ({ position: 1, waiting: 1 }),
    });
    expect(await broke.runTool("book", { classId: "cls_1" }, { caller: MEMBER })).toMatchObject({
      result: "waiting",
    });
    // Nothing to pay with and the class not full: the refusal stands.
    const open = host({
      "my.create": (input) =>
        (input.values as Record<string, unknown>).state === "waiting"
          ? (() => {
              throw new ExtensionToolError("conflict", "A place is free", {
                rule: "waitlist",
                reason: "not_full",
              });
            })()
          : refusal("allowance", { reason: "no_holder" }),
    });
    expect(await open.runTool("book", { classId: "cls_1" }, { caller: MEMBER })).toMatchObject({
      result: "refused",
      reason: "no_use",
    });
    // Too close to the start to wait.
    const closed = host({
      "my.create": (input) =>
        (input.values as Record<string, unknown>).state === "waiting"
          ? refusal("waitlist", { reason: "closed" })
          : refusal("capacity"),
    });
    expect(await closed.runTool("book", { classId: "cls_1" }, { caller: MEMBER })).toMatchObject({
      result: "refused",
      reason: "waitlist_closed",
    });
    // Asked not to wait: full is full, and nothing else is asked.
    const once: unknown[] = [];
    const refuse = host({
      "my.create": (input) => {
        once.push(input);
        return refusal("capacity");
      },
    });
    expect(
      await refuse.runTool("book", { classId: "cls_1", waitlist: false }, { caller: MEMBER }),
    ).toMatchObject({ result: "refused", reason: "full" });
    expect(once).toHaveLength(1);
  });

  it("book by someone already waiting: the true reason, and a free place taken themselves", async () => {
    const dup = () => {
      throw new ExtensionToolError("conflict", "Already one", { rule: "unique" });
    };
    // Nothing to pay with, and already waiting: the answer is the duplicate, not the allowance.
    const waiting = host({
      "my.create": (input) =>
        (input.values as Record<string, unknown>).state === "waiting"
          ? dup()
          : refusal("allowance", { reason: "no_holder" }),
      "my.list": () => ({ items: [] }),
    });
    expect(await waiting.runTool("book", { classId: "cls_1" }, { caller: MEMBER })).toMatchObject({
      result: "refused",
      reason: "already_booked",
    });
    // Waiting on it, and a place is free: their own waiting booking moves in.
    const writes: Record<string, unknown>[] = [];
    const free = host({
      "my.create": () => dup(),
      "my.list": () => ({ items: [{ id: "bkg_w", values: { class: "cls_1", state: "waiting" } }] }),
      "my.update": (input) => {
        writes.push(input);
        return { id: "bkg_w", values: { state: "booked", holder: "pass_1" } };
      },
    });
    expect(await free.runTool("book", { classId: "cls_1" }, { caller: MEMBER })).toEqual({
      result: "booked",
      bookingId: "bkg_w",
      classId: "cls_1",
      holderId: "pass_1",
    });
    expect(writes).toEqual([
      { object: "bookings.booking", id: "bkg_w", from: "waiting", values: { state: "booked" } },
    ]);
    // Their own waiting booking, not a child's on the same class.
    const listed = free.calls.find((c) => c.operation === "my.list")?.input as {
      filter: { and: { field: string; value: unknown }[] };
    };
    expect(listed.filter.and).toContainEqual({ field: "person", op: "eq", value: "per_me" });
  });

  it("bookFor refuses paid at the desk with the waitlist: nobody pays for a place they may not get", async () => {
    const h = host();
    await expect(
      h.runTool(
        "bookFor",
        { classId: "cls_1", personId: "per_ann", paidAtDesk: true, waitlist: true },
        { caller: STAFF },
      ),
    ).rejects.toThrow(/paidAtDesk/);
  });

  it("leaveWaitlist takes a waiting booking off, from waiting or not at all", async () => {
    const writes: Record<string, unknown>[] = [];
    const h = host({
      "my.update": (input) => {
        writes.push(input);
        return { id: "bkg_w", values: { state: "left" } };
      },
    });
    expect(await h.runTool("leaveWaitlist", { bookingId: "bkg_w" }, { caller: MEMBER })).toEqual({
      result: "left",
      bookingId: "bkg_w",
    });
    expect(writes).toEqual([
      { object: "bookings.booking", id: "bkg_w", from: "waiting", values: { state: "left" } },
    ]);
    const moved = host({
      "my.update": () => {
        throw new ExtensionToolError("conflict", "Moved", { reason: "not_in_position" });
      },
    });
    expect(
      await moved.runTool("leaveWaitlist", { bookingId: "bkg_w" }, { caller: MEMBER }),
    ).toMatchObject({ result: "refused", reason: "changed" });
  });

  it("timetable lists the public's classes with places, coach and room, never who is booked", async () => {
    const h = host();
    const out = await h.runTool<{ classes: Record<string, unknown>[] }>(
      "timetable",
      { from: "2026-12-01T00:00:00.000Z" },
      { caller: PUBLIC },
    );
    expect(out.classes).toEqual([
      {
        id: "cls_1",
        title: "Strength",
        classType: "ct_1",
        startsAt: CLASS.startsAt,
        endsAt: CLASS.endsAt,
        timeZone: "Australia/Sydney",
        room: { id: "room_1", name: "Main room" },
        coach: { id: "coach_1", name: "Robin", photo: null },
        notes: "Bring a towel",
        places: { status: "available", available: 9 },
      },
    ]);
    const asked = h.calls.find((c) => c.operation === "public.list");
    expect(asked?.input).toMatchObject({
      object: "bookings.class",
      filter: {
        and: [
          { field: "startsAt", op: "gte", value: "2026-12-01T00:00:00.000Z" },
          { field: "startsAt", op: "lt", value: "2026-12-08T00:00:00.000Z" },
        ],
      },
    });
    expect(h.calls.some((c) => c.operation.startsWith("record."))).toBe(false);
  });

  it("classGet reads one public class", async () => {
    const h = host();
    const out = await h.runTool<{ class: { id: string; places: unknown } }>(
      "classGet",
      { classId: "cls_1" },
      { caller: PUBLIC },
    );
    expect(out.class).toMatchObject({ id: "cls_1", places: { status: "available", available: 9 } });
    await expect(h.runTool("classGet", { classId: "nope" }, { caller: PUBLIC })).rejects.toThrow();
  });

  it("book asks the host to make the member's booking, and passes on what it refused", async () => {
    let made: Record<string, unknown> | undefined;
    const ok = host({
      "my.create": (input) => {
        made = input;
        return { id: "bkg_new", values: { holder: "pass_1", state: "booked" } };
      },
    });
    expect(await ok.runTool("book", { classId: "cls_1" }, { caller: MEMBER })).toEqual({
      result: "booked",
      bookingId: "bkg_new",
      classId: "cls_1",
      holderId: "pass_1",
    });
    // No person, no state: whose it is and the state it starts in are the host's.
    expect(made).toEqual({ object: "bookings.booking", values: { class: "cls_1" } });

    const cases: [string, Record<string, unknown>, string][] = [
      ["state_window_not_open", { opensAt: "2026-11-24T19:00:00.000Z" }, "not_open"],
      ["state_window_closed", {}, "closed"],
      ["state_staff_only", {}, "staff_only"],
      ["allowance", { reason: "no_uses_left" }, "no_use"],
      ["capacity", {}, "full"],
    ];
    for (const [rule, extra, reason] of cases) {
      const h = host({ "my.create": () => refusal(rule, extra) });
      const out = await h.runTool<{ result: string; reason: string; opensAt: string | null }>(
        "book",
        { classId: "cls_1", holderId: "pass_1" },
        { caller: MEMBER },
      );
      expect(out).toMatchObject({ result: "refused", reason });
      if (rule === "state_window_not_open") expect(out.opensAt).toBe("2026-11-24T19:00:00.000Z");
    }
    const dup = host({
      "my.create": () => {
        throw new ExtensionToolError("conflict", "There is already a booking", { rule: "unique" });
      },
      // Booked already, not waiting: nothing of theirs waits on the class.
      "my.list": () => ({ items: [] }),
    });
    expect(await dup.runTool("book", { classId: "cls_1" }, { caller: MEMBER })).toMatchObject({
      reason: "already_booked",
    });
  });

  it("declares a drop-in: held while its order is unpaid, priced by the class type or the org", () => {
    const m = host().manifest;
    expect(m.objects.booking?.sellable).toEqual({
      price: "dropInPrice",
      tax: { code: "txcd_50021003" },
      moves: {
        held: "pending",
        paid: "booked",
        expired: "expired",
        refund: ["cancelled", "excused", "cancelled_by_us"],
        price: { field: "class.classType.dropInPrice", setting: "dropInPrice" },
        title: "class.title",
        order: "dropInOrder",
        guest: true,
        holdCap: { setting: "dropInHoldPercent" },
      },
      // A drop-in in the finance reports (ADR 0792): earned when its class starts.
      finance: {
        category: { key: "drop_ins", label: "Drop-ins" },
        earned: "at_date",
        at: "class.startsAt",
      },
    });
    // A guest's hold is nobody's until paid: the booking's Person is not required (ADR 0560).
    expect(m.objects.booking?.fields.person?.required).toBeUndefined();
    expect(m.settings?.dropInHoldPercent).toMatchObject({ default: 50, personApproves: true });
    // Only the host makes a booking held, and only the host moves it out of held.
    expect(m.objects.booking?.states?.create?.in?.pending).toEqual(["host"]);
    expect(m.fields?.["programs.classtype"]?.dropInPrice?.personApproves).toBe(true);
    expect(m.settings?.dropInPrice?.personApproves).toBe(true);
    expect(m.permissions.operations).toContain("order.startHeld");
  });

  it("buy asks the host to make the booking held with its order, and passes on what it refused", async () => {
    let asked: Record<string, unknown> | undefined;
    const ok = host({
      "order.startHeld": (input) => {
        asked = input;
        return {
          id: "ord_1",
          total: 2500,
          currency: "AUD",
          expiresAt: "2026-12-01T10:15:00.000Z",
          recordId: "bkg_new",
          token: "t".repeat(64),
        };
      },
    });
    expect(
      await ok.runTool("buy", { classId: "cls_1", email: "v@x.test" }, { caller: PUBLIC }),
    ).toEqual({
      result: "pending",
      bookingId: "bkg_new",
      classId: "cls_1",
      orderId: "ord_1",
      total: 2500,
      currency: "AUD",
      expiresAt: "2026-12-01T10:15:00.000Z",
      token: "t".repeat(64),
    });
    // No price, no state, no person: the host's.
    expect(asked).toEqual({
      object: "bookings.booking",
      values: { class: "cls_1" },
      email: "v@x.test",
    });
    const cases: [string, string][] = [
      ["no_price", "no_drop_in"],
      ["not_for_sale", "no_drop_in"],
      ["buyer_unclear", "ask_desk"],
      ["capacity", "full"],
      ["unique", "already_booked"],
      ["state_staff_only", "staff_only"],
      ["state_window_not_open", "not_open"],
      ["try_later", "try_later"],
    ];
    for (const [rule, reason] of cases) {
      const h = host({ "order.startHeld": () => refusal(rule) });
      expect(await h.runTool("buy", { classId: "cls_1" }, { caller: MEMBER })).toMatchObject({
        result: "refused",
        reason,
      });
    }
  });

  it("cancel previews the host's pick, then cancels into what the member was told", async () => {
    const writes: Record<string, unknown>[] = [];
    const own = { "my.get": () => ({ id: "bkg_1", values: { state: "booked" } }) };
    const h = host({
      ...own,
      "state.resolve": () => ({ state: "late_cancelled", label: "Cancelled late", from: "booked" }),
      "my.update": (input) => {
        writes.push(input);
        return { id: "bkg_1", values: { state: (input.values as { state: string }).state } };
      },
    });
    expect(await h.runTool("cancel", { bookingId: "bkg_1" }, { caller: MEMBER })).toMatchObject({
      result: "preview",
      state: "late_cancelled",
      late: true,
    });
    expect(writes).toEqual([]);
    expect(
      await h.runTool(
        "cancel",
        { bookingId: "bkg_1", confirm: true, expect: "late_cancelled" },
        { caller: MEMBER },
      ),
    ).toMatchObject({ result: "late_cancelled", late: true });
    expect(writes).toEqual([
      {
        object: "bookings.booking",
        id: "bkg_1",
        from: "booked",
        values: { state: "late_cancelled" },
      },
    ]);
    // Told "in time", and it became late meanwhile: refused as changed, the use not lost.
    const late = host({ ...own, "my.update": () => refusal("state_window_closed") });
    expect(
      await late.runTool(
        "cancel",
        { bookingId: "bkg_1", confirm: true, expect: "cancelled" },
        { caller: MEMBER },
      ),
    ).toMatchObject({ result: "refused", reason: "changed" });
    // After the start nothing can be cancelled.
    const started = host({ ...own, "state.resolve": () => refusal("state_window_closed") });
    // A drop-in's cancel in time says the money goes back once staff approve it.
    const dropIn = host({
      "my.get": () => ({ id: "bkg_1", values: { state: "booked", dropInOrder: "ord_1" } }),
      "state.resolve": () => ({ state: "cancelled", label: "Cancelled", from: "booked" }),
    });
    expect(
      await dropIn.runTool("cancel", { bookingId: "bkg_1" }, { caller: MEMBER }),
    ).toMatchObject({ result: "preview", state: "cancelled", dropIn: true });
    expect(
      await started.runTool("cancel", { bookingId: "bkg_1" }, { caller: MEMBER }),
    ).toMatchObject({ result: "refused", reason: "too_late" });
  });

  it("mine reads the member's own bookings and their classes through the seam", async () => {
    const h = host({
      "my.list": (input) =>
        input.object === "bookings.booking"
          ? {
              items: [
                { id: "bkg_1", values: { class: "cls_1", state: "booked", holder: "pass_1" } },
              ],
            }
          : {
              items: [{ id: "cls_1", values: { ...CLASS, startsAt: "2099-01-01T00:00:00.000Z" } }],
            },
    });
    const out = await h.runTool<{ bookings: Record<string, unknown>[] }>(
      "mine",
      {},
      { caller: MEMBER },
    );
    expect(out.bookings).toEqual([
      expect.objectContaining({
        id: "bkg_1",
        state: "booked",
        holderId: "pass_1",
        classId: "cls_1",
        title: "Strength",
        coach: "Robin",
        room: "Main room",
        classState: "scheduled",
      }),
    ]);
    expect(h.calls.some((c) => c.operation === "record.list")).toBe(false);
    // Their own by default; a child's with personId (the seam decides whether they may).
    const asked = h.calls.find((c) => c.operation === "my.list")?.input as {
      filter: { and: unknown[] };
    };
    expect(asked.filter.and).toEqual([{ field: "person", op: "eq", value: "per_me" }]);
    await h.runTool("mine", { personId: "per_kid" }, { caller: MEMBER });
    const forKid = h.calls.filter((c) => c.operation === "my.list").at(-2)?.input as {
      filter: { and: unknown[] };
    };
    expect(forKid.filter.and).toEqual([{ field: "person", op: "eq", value: "per_kid" }]);
  });

  it("bookFor books a walk-in and their booking in one call, after the duplicate check", async () => {
    let asked: Record<string, unknown> | undefined;
    const h = host({
      "person.createWith": (input) => {
        asked = input;
        return { personId: "per_walkin", id: "bkg_new" };
      },
      "record.get": (input) => ({ id: input.id, values: { holder: null } }),
    });
    const out = await h.runTool(
      "bookFor",
      { classId: "cls_1", newPerson: { givenName: "Wal" }, paidAtDesk: true, note: "cash" },
      { caller: STAFF },
    );
    expect(out).toMatchObject({ result: "booked", personId: "per_walkin", bookingId: "bkg_new" });
    expect(asked).toEqual({
      person: { givenName: "Wal" },
      object: "bookings.booking",
      field: "person",
      values: { class: "cls_1", paidOtherwise: true, bookedBy: "usr_desk", note: "cash" },
      allowDuplicates: false,
    });
    expect(h.calls.some((c) => c.operation === "person.create")).toBe(false);
    // A possible duplicate is answered with who, not made twice.
    const dup = host({
      "person.createWith": () => {
        throw new ExtensionToolError("conflict", "May be someone on file", {
          rule: "possible_duplicates",
          people: [{ id: "per_ann", title: "Ann", reasons: ["Same name only"] }],
        });
      },
    });
    expect(
      await dup.runTool(
        "bookFor",
        { classId: "cls_1", newPerson: { givenName: "Ann" } },
        { caller: STAFF },
      ),
    ).toMatchObject({
      result: "refused",
      reason: "possible_duplicates",
      people: [{ id: "per_ann", name: "Ann", reasons: ["Same name only"] }],
    });
    // Someone on file is booked by id.
    const known = host();
    expect(
      await known.runTool("bookFor", { classId: "cls_1", personId: "per_ann" }, { caller: STAFF }),
    ).toMatchObject({ result: "booked", personId: "per_ann" });
    await expect(h.runTool("bookFor", { classId: "cls_1" }, { caller: STAFF })).rejects.toThrow(
      /personId/,
    );
  });

  it("findPeople looks a person up by name or email", async () => {
    const h = host({
      "person.list": () => ({
        items: [{ id: "per_ann", displayName: "Ann", primaryEmail: "ann@example.com" }],
      }),
    });
    expect(await h.runTool("findPeople", { query: "an" }, { caller: STAFF })).toEqual({
      people: [{ id: "per_ann", name: "Ann", email: "ann@example.com" }],
    });
  });

  it("cancelFor asks the host to cancel (in time or late by its clock), or keeps the use", async () => {
    const h = host();
    expect(
      await h.runTool("cancelFor", { bookingId: "bkg_1", keepUse: true }, { caller: STAFF }),
    ).toEqual({ result: "late_cancelled", bookingId: "bkg_1", late: true });
    const update = h.calls.find((c) => c.operation === "record.update");
    expect(update?.input).toMatchObject({ from: "booked", values: { state: "late_cancelled" } });
    // Already moved on: the host's conflict, reported as changed.
    expect(await h.runTool("cancelFor", { bookingId: "bkg_1" }, { caller: STAFF })).toMatchObject({
      result: "refused",
      reason: "changed",
    });
    const asks = host();
    await asks.runTool("cancelFor", { bookingId: "bkg_1" }, { caller: STAFF });
    expect(asks.calls.find((c) => c.operation === "record.update")?.input).toMatchObject({
      values: { state: "cancel" },
    });
  });

  it("returnUse gives the use back whatever the time, a person's own act with its permission", async () => {
    const h = host();
    expect(host().manifest.tools.returnUse).toMatchObject({
      risk: "destructive",
      humanOnly: true,
      permission: "bookings:desk",
    });
    // The move it makes is open to that tool alone (ADR 0513), and the in-time cancel's window
    // binds staff too, so no other write returns a use late.
    const moves = host().manifest.objects.booking?.states?.moves ?? [];
    expect(moves.find((m) => m.to === "excused")).toMatchObject({
      from: "booked",
      by: ["host"],
      tools: ["returnUse"],
    });
    expect(moves.find((m) => m.to === "cancelled" && m.from === "booked")?.bindsStaff).toBe(true);
    expect(
      await h.runTool(
        "returnUse",
        { bookingId: "bkg_1", reason: "Ill on the day" },
        { caller: STAFF },
      ),
    ).toEqual({ result: "excused", bookingId: "bkg_1", late: false });
    expect(h.calls.find((c) => c.operation === "record.update")?.input).toMatchObject({
      from: "booked",
      values: { state: "excused", note: "Use given back: Ill on the day" },
    });
  });

  it("day lists one local date's classes with the class type's staff-only flag", async () => {
    const h = host();
    const out = await h.runTool<{ classes: Record<string, unknown>[] }>(
      "day",
      { date: "2026-12-02", timeZone: "Australia/Sydney" },
      { caller: STAFF },
    );
    expect(out.classes).toEqual([
      expect.objectContaining({
        id: "cls_1",
        classType: { id: "ct_1", name: "Strength" },
        coach: "Robin",
        room: "Main room",
        booked: 3,
        available: 9,
        staffOnly: true,
      }),
    ]);
    // Sydney's 2 December starts at 13:00 UTC on 1 December (summer time, +11).
    expect(new Date(localMidnight("2026-12-02", "Australia/Sydney")).toISOString()).toBe(
      "2026-12-01T13:00:00.000Z",
    );
    expect(new Date(localMidnight("2026-07-02", "Australia/Sydney")).toISOString()).toBe(
      "2026-07-01T14:00:00.000Z",
    );
  });

  it("classList shows staff the class's bookings with names", async () => {
    const h = host();
    const out = await h.runTool<{ bookings: unknown[] }>(
      "classList",
      { classId: "cls_1" },
      { caller: STAFF },
    );
    expect(out.bookings).toEqual([
      {
        id: "bkg_1",
        person: { id: "per_ann", name: "Ann" },
        state: "booked",
        paidAtDesk: true,
        holderId: null,
        bookedBy: null,
        promotedAt: null,
        healthNote: true,
        passedOver: null,
      },
    ]);
  });

  // --- Stage 45 step 2: a class is its coach's shift ---------------------------------------------------

  it("declares a class a shift its coach's account works, and one coach profile per account", () => {
    const m = host().manifest;
    // The host refuses one account on two overlapping shifts (ADR 0621); no tool checks it.
    expect(m.objects.class?.staffed).toEqual({
      who: { field: "coach", account: "user" },
      starts: "startsAt",
      ends: "endsAt",
      zone: "timezone",
      kind: "classType",
      live: ["scheduled", "done"],
      place: "room.name",
      pattern: { link: "series", who: "coach" },
      // Pay (ADR 0627): the class type's set-up and pack-down minutes, and the list as evidence.
      payBefore: { field: "classType.rosterBeforeMinutes" },
      payAfter: { field: "classType.rosterAfterMinutes" },
      evidence: { object: "booking", link: "class", by: "markedBy" },
    });
    // Set-up and pack-down minutes feed pay: a person's to change.
    const classtype = m.fields["programs.classtype"] ?? {};
    expect(classtype.rosterBeforeMinutes?.personApproves).toBe(true);
    expect(classtype.rosterAfterMinutes?.personApproves).toBe(true);
    expect(m.objects.coach?.unique).toEqual([{ fields: ["user"] }]);
  });

  // --- Step 7: attendance, the coach role, moves and cancelling a class -----------------------------

  it("declares the coach role, the list's windows, no-shows after the class, and who cancels a class", () => {
    const m = host().manifest;
    expect(m.roles?.coach).toMatchObject({
      permissions: ["bookings:coach"],
      read: ["bookings.class"],
    });
    for (const tool of ["roster", "markAttended", "undoAttended", "markNoShow", "markAll"]) {
      expect(m.tools[tool]?.permission).toBe("bookings:coach");
    }
    // The day view is the coach's (today) and the desk's (any day, ADR 0600).
    expect(m.tools.day?.permission).toEqual(["bookings:coach", "bookings:desk"]);
    // Not the coach's: the desk's (ADR 0600): its list (holders, desk payments), booking,
    // cancelling, moving, finding people, giving a use back. Grantable, so a coach can be given it.
    for (const tool of ["classList", "bookFor", "cancelFor", "move", "findPeople", "returnUse"]) {
      expect(m.tools[tool]?.permission).toBe("bookings:desk");
    }
    expect(m.grantable).toEqual(["bookings:desk"]);
    expect(m.grantableLabels?.["bookings:desk"]).toContain("Front desk");
    // Cancelling a class keeps its own permission, and stays a person's.
    expect(m.tools.cancelClass?.permission).toBe("bookings:cancelClasses");
    const booking = m.objects.booking?.states;
    const moves = booking?.moves ?? [];
    expect(moves.find((x) => x.from === "booked" && x.to === "attended")).toMatchObject({
      by: ["staff"],
      window: { from: { at: "class.startsAt", minutesBefore: 60 } },
      bindsStaff: true,
    });
    expect(moves.find((x) => x.from === "booked" && x.to === "no_show")).toMatchObject({
      by: ["staff", "host"],
      window: { from: "class.startsAt" },
      bindsStaff: true,
    });
    expect(moves.find((x) => x.to === "moved")).toMatchObject({
      by: ["staff"],
      window: { until: "class.startsAt" },
      bindsStaff: true,
    });
    expect(booking?.after).toEqual([
      {
        from: "booked",
        to: "no_show",
        at: "class.endsAt",
        minutesAfter: 30,
        ifAnyIn: ["attended", "no_show"],
      },
    ]);
    // A class is cancelled by the host, and by cancelClass alone: a person's, or approved by one.
    expect(m.objects.class?.states?.moves.find((x) => x.to === "cancelled")).toMatchObject({
      by: ["host"],
      tools: ["cancelClass"],
    });
    expect(m.tools.cancelClass).toMatchObject({
      risk: "destructive",
      personApproves: true,
      permission: "bookings:cancelClasses",
    });
    expect(m.tools.move?.risk).toBe("write");
  });

  it("markAttended ticks a name from where it is, and a second tick is told who was first", async () => {
    const h = host();
    expect(
      await h.runTool("markAttended", { bookingId: "bkg_1" }, { caller: STAFF }),
    ).toMatchObject({ result: "attended", bookingId: "bkg_1" });
    expect(h.calls.find((c) => c.operation === "record.update")?.input).toMatchObject({
      object: "bookings.booking",
      id: "bkg_1",
      from: "booked",
      values: { state: "attended", markedBy: "usr_desk", markedByName: "Desk" },
    });
    // The same name again (another coach a moment later): already ticked, by whom.
    expect(
      await h.runTool(
        "markAttended",
        { bookingId: "bkg_1" },
        { caller: { kind: "staff", userId: "usr_2", name: "Sam" } },
      ),
    ).toMatchObject({
      result: "already",
      markedBy: "Desk",
      message: "Already ticked as come by Desk.",
    });
    // Unticked by mistake: booked again, who and when cleared.
    expect(
      await h.runTool("undoAttended", { bookingId: "bkg_1" }, { caller: STAFF }),
    ).toMatchObject({ result: "booked" });
    expect(h.calls.filter((c) => c.operation === "record.update").at(-1)?.input).toMatchObject({
      from: "attended",
      values: { state: "booked", markedAt: null, markedBy: null, markedByName: null },
    });
  });

  it("markAttended reports the host's refusals: a race lost, the list not open, not a booking that ticks", async () => {
    // Lost the race: the host refuses the conditional move, and the booking now says who won.
    let reads = 0;
    const raced = host({
      "record.get": (input) => {
        reads += 1;
        return {
          id: input.id,
          values:
            reads === 1
              ? { state: "booked" }
              : { state: "attended", markedByName: "Sam", markedAt: "2026-12-01T18:58:00.000Z" },
        };
      },
      "record.update": () => {
        throw new ExtensionToolError("conflict", "Moved meanwhile", { reason: "moved_meanwhile" });
      },
    });
    expect(
      await raced.runTool("markAttended", { bookingId: "bkg_1" }, { caller: STAFF }),
    ).toMatchObject({ result: "already", markedBy: "Sam", markedAt: "2026-12-01T18:58:00.000Z" });
    // Before the list opens (an hour before the class): the host's window.
    const early = host({
      "record.update": () =>
        refusal("state_window_not_open", { opensAt: "2026-12-01T18:00:00.000Z" }),
    });
    expect(
      await early.runTool("markAttended", { bookingId: "bkg_1" }, { caller: STAFF }),
    ).toMatchObject({
      result: "refused",
      reason: "not_started",
      opensAt: "2026-12-01T18:00:00.000Z",
    });
    // A booking the gym cancelled with its class: nothing to tick, and nothing asked of the host.
    const gone = host({
      "record.get": (input) => ({ id: input.id, values: { state: "cancelled_by_us" } }),
    });
    expect(
      await gone.runTool("markAttended", { bookingId: "bkg_1" }, { caller: STAFF }),
    ).toMatchObject({ result: "refused", reason: "not_booked", state: "cancelled_by_us" });
    expect(gone.calls.some((c) => c.operation === "record.update")).toBe(false);
    // A no-show ticked later (a late correction) moves from no_show.
    const late = host({
      "record.get": (input) => ({ id: input.id, values: { state: "no_show" } }),
      "record.update": () => ({ id: "bkg_1", values: { state: "attended" } }),
    });
    await late.runTool("markAttended", { bookingId: "bkg_1" }, { caller: STAFF });
    expect(late.calls.find((c) => c.operation === "record.update")?.input).toMatchObject({
      from: "no_show",
    });
  });

  it("markNoShow and markAll mark from where each booking is", async () => {
    const h = host();
    expect(await h.runTool("markNoShow", { bookingId: "bkg_1" }, { caller: STAFF })).toMatchObject({
      result: "no_show",
    });
    const all = host();
    expect(await all.runTool("markAll", { classId: "cls_1" }, { caller: STAFF })).toEqual({
      result: "marked",
      classId: "cls_1",
      ticked: 1,
      already: 0,
      skipped: 0,
    });
    expect(all.calls.find((c) => c.operation === "record.list")?.input).toMatchObject({
      object: "bookings.booking",
      filter: {
        and: [
          { field: "class", value: "cls_1" },
          { field: "state", value: "booked" },
        ],
      },
    });
  });

  it("roster shows the coach names and marks, and nothing of what anyone paid with", async () => {
    const out = await host().runTool<{ bookings: Record<string, unknown>[] }>(
      "roster",
      { classId: "cls_1" },
      { caller: STAFF },
    );
    expect(out.bookings).toEqual([
      {
        id: "bkg_1",
        person: { id: "per_ann", name: "Ann" },
        state: "booked",
        markedAt: null,
        markedBy: null,
        promotedAt: null,
        healthNote: true,
      },
    ]);
    // A list the host gives no mark for (the assistant reading it): no mark, the list as before.
    const unmarked = await host({
      "agreement.listHealthNotes": () => {
        throw new ExtensionToolError("forbidden", "A health note is for a person on the staff");
      },
    }).runTool<{ bookings: Record<string, unknown>[] }>(
      "roster",
      { classId: "cls_1" },
      { caller: STAFF },
    );
    expect(unmarked.bookings[0]?.healthNote).toBeNull();
  });

  it("move makes the new booking naming the old one, so the host moves both in one batch", async () => {
    const h = host();
    expect(
      await h.runTool(
        "move",
        { bookingId: "bkg_1", toClassId: "cls_2", note: "Asked at the desk" },
        { caller: STAFF },
      ),
    ).toMatchObject({ result: "moved", fromBookingId: "bkg_1", classId: "cls_2" });
    expect(h.calls.find((c) => c.operation === "record.create")?.input).toEqual({
      object: "bookings.booking",
      values: {
        class: "cls_2",
        person: "per_ann",
        movedFrom: "bkg_1",
        bookedBy: "usr_desk",
        note: "Asked at the desk",
      },
    });
    // Nothing is asked of the host for the same class, or for a booking that is not booked.
    expect(
      await host().runTool("move", { bookingId: "bkg_1", toClassId: "cls_1" }, { caller: STAFF }),
    ).toMatchObject({ result: "refused", reason: "same_class" });
    const waiting = host({
      "record.get": (input) => ({ id: input.id, values: { state: "waiting", class: "cls_1" } }),
    });
    expect(
      await waiting.runTool("move", { bookingId: "bkg_1", toClassId: "cls_2" }, { caller: STAFF }),
    ).toMatchObject({ result: "refused", reason: "not_booked" });
    // The host's refusals, refused whole: full, no use, the old class started.
    for (const [rule, reason] of [
      ["capacity", "full"],
      ["allowance", "no_use"],
      ["unique", "already_booked"],
      ["state_closed", "not_running"],
      ["state_window_closed", "started"],
    ] as const) {
      const r = host({ "record.create": () => refusal(rule) });
      expect(
        await r.runTool("move", { bookingId: "bkg_1", toClassId: "cls_2" }, { caller: STAFF }),
      ).toMatchObject({ result: "refused", reason });
    }
  });

  it("cancelClass cancels from scheduled with the reason, and says how many bookings went with it", async () => {
    const h = host({
      "record.list": () => ({
        items: [
          { id: "bkg_1", values: { state: "cancelled_by_us" } },
          { id: "bkg_2", values: { state: "cancelled_by_us" } },
        ],
      }),
    });
    expect(
      await h.runTool("cancelClass", { classId: "cls_1", reason: "Coach ill" }, { caller: STAFF }),
    ).toEqual({ result: "cancelled", classId: "cls_1", bookingsCancelled: 2 });
    expect(h.calls.find((c) => c.operation === "record.update")?.input).toEqual({
      object: "bookings.class",
      id: "cls_1",
      from: "scheduled",
      values: { state: "cancelled", cancelledReason: "Coach ill" },
    });
    const done = host({
      "record.update": () => {
        throw new ExtensionToolError("conflict", "Not scheduled", { reason: "not_in_position" });
      },
    });
    // A refusal fails the call (an approved request then shows it did not apply).
    await expect(
      done.runTool("cancelClass", { classId: "cls_1", reason: "Again" }, { caller: STAFF }),
    ).rejects.toMatchObject({ details: { reason: "not_scheduled" } });
    const ended = host({ "record.update": () => refusal("state_window_closed") });
    await expect(
      ended.runTool("cancelClass", { classId: "cls_1", reason: "Late" }, { caller: STAFF }),
    ).rejects.toMatchObject({ details: { reason: "ended" } });
    // A race is tried once more from a fresh read; twice, it fails.
    let tries = 0;
    const raced = host({
      "record.update": () => {
        tries += 1;
        if (tries === 1) {
          throw new ExtensionToolError("conflict", "Stale", { rule: "recurring_stale" });
        }
        return { id: "cls_1", values: { state: "cancelled" } };
      },
      "record.list": () => ({ items: [] }),
    });
    expect(
      await raced.runTool("cancelClass", { classId: "cls_1", reason: "Race" }, { caller: STAFF }),
    ).toMatchObject({ result: "cancelled" });
    expect(tries).toBe(2);
  });

  it("a class the gym cancels takes every booking holding a place or a use, and only before it ends", () => {
    const m = host().manifest;
    const states = m.objects.booking?.states;
    expect(states?.follows?.from).toEqual([
      "booked",
      "waiting",
      "pending",
      "attended",
      "no_show",
      "late_cancelled",
    ]);
    // A late cancel is not final: the class's cancel gives its kept use back.
    expect(states?.moves.find((x) => x.to === "late_cancelled")?.final).toBeUndefined();
    expect(m.objects.class?.fields.endsAt?.required).toBe(true);
    expect(m.objects.class?.states?.moves.find((x) => x.to === "cancelled")).toMatchObject({
      window: { until: "endsAt" },
      bindsStaff: true,
    });
    expect(m.roles?.coach?.today).toEqual({
      "bookings.class": { at: "startsAt", until: "endsAt", zone: "timezone" },
      "bookings.booking": { at: "class.startsAt", until: "class.endsAt", zone: "class.timezone" },
    });
  });

  it("move reports a booking that moved on meanwhile as changed, not as a fault", async () => {
    const r = host({ "record.create": () => refusal("state_final") });
    expect(
      await r.runTool("move", { bookingId: "bkg_1", toClassId: "cls_2" }, { caller: STAFF }),
    ).toMatchObject({ result: "refused", reason: "changed" });
    // A move the declaration does not allow is a fault, never reported as a race.
    const wrong = host({ "record.create": () => refusal("state_move_not_declared") });
    await expect(
      wrong.runTool("move", { bookingId: "bkg_1", toClassId: "cls_2" }, { caller: STAFF }),
    ).rejects.toThrow();
  });
});
