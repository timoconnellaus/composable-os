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
      "staffOnly",
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
      horizonDays: 56,
      horizonAtLeast: { object: "programs.classtype", field: "opensDays" },
    });
  });

  it("declares a booking's place, one per person per class, and its windows from the class type or the org", () => {
    const booking = host().manifest.objects.booking;
    expect(booking?.claims).toEqual({
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
    expect(states?.create?.staffOnly).toEqual(["class.classType.staffOnly", "class.closed"]);
    // Nothing a customer does creates a booking waiting or held (steps 5 and 8).
    expect(states?.create?.in).toEqual({ waiting: ["host"], pending: ["host"] });
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
        returnIn: ["cancelled", "cancelled_by_us", "moved"],
        at: "class.startsAt",
        copy: { classType: "class.classType" },
        local: { weekday: "weekday", minute: "minute", zone: "class.timezone" },
        movedFrom: { field: "movedFrom", state: "moved" },
        paidBy: ["memberships.membership", "memberships.pass"],
        waived: "paidOtherwise",
      },
    });
    // A member writes the class, the state (a cancel) and the holder they choose; never what
    // pays for it or whether it spends.
    expect(booking?.customer?.write).toEqual(["class", "state", "holder"]);
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
      ["cancel", ["customer"], "write"],
      ["mine", ["customer"], "read"],
    ]);
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
    });
    expect(await dup.runTool("book", { classId: "cls_1" }, { caller: MEMBER })).toMatchObject({
      reason: "already_booked",
    });
  });

  it("cancel previews the host's pick, then cancels into what the member was told", async () => {
    const writes: Record<string, unknown>[] = [];
    const h = host({
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
    const late = host({ "my.update": () => refusal("state_window_closed") });
    expect(
      await late.runTool(
        "cancel",
        { bookingId: "bkg_1", confirm: true, expect: "cancelled" },
        { caller: MEMBER },
      ),
    ).toMatchObject({ result: "refused", reason: "changed" });
    // After the start nothing can be cancelled.
    const started = host({ "state.resolve": () => refusal("state_window_closed") });
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
  });

  it("bookFor books a walk-in as staff, paid at the desk, and records who booked", async () => {
    const h = host({
      "person.create": (input) => ({ id: "per_walkin", ...input }),
    });
    const out = await h.runTool(
      "bookFor",
      { classId: "cls_1", newPerson: { givenName: "Wal" }, paidAtDesk: true, note: "cash" },
      { caller: STAFF },
    );
    expect(out).toMatchObject({ result: "booked", personId: "per_walkin", classId: "cls_1" });
    const created = h.calls.find((c) => c.operation === "record.create");
    expect(created?.input).toEqual({
      object: "bookings.booking",
      values: {
        class: "cls_1",
        person: "per_walkin",
        paidOtherwise: true,
        bookedBy: "usr_desk",
        note: "cash",
      },
    });
    await expect(h.runTool("bookFor", { classId: "cls_1" }, { caller: STAFF })).rejects.toThrow(
      /personId/,
    );
  });

  it("cancelFor cancels from booked, giving the use back or keeping it", async () => {
    const h = host();
    expect(
      await h.runTool("cancelFor", { bookingId: "bkg_1", keepUse: true }, { caller: STAFF }),
    ).toEqual({ result: "late_cancelled", bookingId: "bkg_1" });
    const update = h.calls.find((c) => c.operation === "record.update");
    expect(update?.input).toMatchObject({ from: "booked", values: { state: "late_cancelled" } });
    // Already moved on: the host's conflict, reported as changed.
    expect(await h.runTool("cancelFor", { bookingId: "bkg_1" }, { caller: STAFF })).toMatchObject({
      result: "refused",
      reason: "changed",
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
      },
    ]);
  });
});
