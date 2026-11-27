// Stage 49 step 5 (ADR 0764): appointments, booked by staff, against the SDK's test host. The
// manifest declares what the host enforces (the coach's shift with the service's buffer and a
// required account, the room it occupies, the states with their windows, the session a pass pays
// for and when it is given back, who may excuse or cancel for the business), and every appointment
// tool asks the host what it should and passes on what it answered. The rules themselves are tested
// against the real host in apps/runner/test/bookings-appointments.test.ts.
import { createTestHost, ExtensionToolError } from "@composable-os/sdk/testing";
import { describe, expect, it } from "vitest";
import bookings from "../index.ts";

const STAFF = { kind: "staff", userId: "usr_desk", name: "Desk" } as const;
const APPT = "bookings.appointment";

const refusal = (code: string, rule: string, extra: Record<string, unknown> = {}) => {
  throw new ExtensionToolError(code, `Refused: ${rule}`, { rule, ...extra });
};

const AHEAD = "2030-06-03T09:00:00.000Z";

function host(operations: Record<string, (input: Record<string, unknown>) => unknown> = {}) {
  return createTestHost(bookings, {
    records: {
      "bookings.service": [{ id: "svc_pt", title: "Personal training", length: 60 }],
      "bookings.coach": [
        { id: "coach_a", name: "Ada", user: "usr_a", active: true },
        { id: "coach_b", name: "Bo", user: "usr_b", active: true },
      ],
      "bookings.room": [{ id: "room_1", name: "Treatment" }],
      "bookings.appointment": [
        {
          id: "apt_1",
          service: "svc_pt",
          person: "per_ann",
          coach: "coach_a",
          room: "room_1",
          startsAt: AHEAD,
          endsAt: "2030-06-03T10:00:00.000Z",
          state: "booked",
          holder: "pass_1",
        },
      ],
      person: [{ id: "per_ann", displayName: "Ann" }],
    },
    operations: {
      "person.get": (input) =>
        input.id === "per_ann" ? { id: "per_ann", displayName: "Ann" } : null,
      ...operations,
    },
  });
}

describe("the appointment (manifest)", () => {
  it("declares services and appointments with the host's behaviours", () => {
    const h = host();
    expect(h.issues).toEqual([]);
    const { service, appointment } = h.manifest.objects;
    expect(Object.keys(service?.fields ?? {})).toEqual(
      expect.arrayContaining(["length", "bufferBefore", "bufferAfter", "rooms", "step", "price"]),
    );
    // The coach's shift: the service is the kind (qualifications say who gives it), its buffer
    // in the claim, an account required, the client kept off the roster and the feed.
    expect(appointment?.staffed).toMatchObject({
      who: { field: "coach", account: "user" },
      kind: "service",
      live: ["pending", "unpaid", "booked", "attended", "no_show"],
      claimBefore: { field: "service.bufferBefore" },
      claimAfter: { field: "service.bufferAfter" },
      account: "required",
      private: true,
      open: { length: { field: "service.length" }, rooms: { field: "service.rooms" } },
    });
    // Its room, when the room takes one booking at a time, with the buffer.
    expect(appointment?.occupies).toMatchObject({
      thing: "room",
      only: "exclusive",
      before: { field: "service.bufferBefore" },
    });
    // A spender of Memberships' holders by its service; paid at the desk spends nothing.
    expect(appointment?.allowance).toMatchObject({
      spends: {
        spendIn: ["booked"],
        returnIn: ["cancelled", "excused", "cancelled_by_us", "moved"],
        copy: { serviceId: "service.id" },
        paidBy: ["memberships.membership", "memberships.pass"],
        waived: "paidOtherwise",
      },
    });
  });

  it("keeps a late cancel and a no-show used until a person excuses them (decision 1)", () => {
    const states = host().manifest.objects.appointment?.states;
    const into = (to: string) => states?.moves.filter((m) => m.to === to) ?? [];
    // In time binds staff too: giving a session back late is a person's tool alone.
    expect(into("cancelled")).toEqual([
      expect.objectContaining({
        from: "booked",
        bindsStaff: true,
        window: {
          until: {
            // Counted from the anchor: its start, or the start of the one it was moved from.
            at: "lateAnchor",
            minutesBefore: { field: "service.lateMinutes", setting: "appointmentLateMinutes" },
          },
        },
      }),
    ]);
    expect(into("excused")).toEqual([
      expect.objectContaining({
        from: ["late_cancelled", "no_show"],
        by: ["host"],
        tools: ["excuseAppointment"],
      }),
    ]);
    expect(into("cancelled_by_us")).toEqual([
      expect.objectContaining({ by: ["host"], tools: ["cancelAppointmentByUs"] }),
    ]);
    // Never an appointment whose coach left (no coach).
    expect(states?.after).toEqual([
      { from: "booked", to: "attended", at: "endsAt", minutesAfter: 30, ifSet: ["coach"] },
    ]);
    // Times and service change only by a move, which keeps the late point (ADR 0764); a client
    // is required when it is made, never by the field (erase keeps it).
    const spends = host().manifest.objects.appointment?.allowance;
    expect(spends).toMatchObject({
      spends: {
        movedFrom: {
          fixed: ["startsAt", "endsAt", "service"],
          anchor: { field: "lateAnchor", from: "startsAt" },
        },
      },
    });
    expect(states?.create?.requires).toEqual(["person"]);
    expect(host().manifest.objects.appointment?.fields.person?.required).toBeUndefined();
    expect(host().manifest.settings).toMatchObject({
      appointmentOpensDays: { default: 28 },
      appointmentClosesMinutes: { default: 720 },
      appointmentLateMinutes: { default: 1440 },
    });
  });

  it("opens nothing of appointments to customers or the public in this step", () => {
    const { service, appointment } = host().manifest.objects;
    expect(service?.public).toBeUndefined();
    expect(appointment?.public).toBeUndefined();
    expect(appointment?.customer).toBeUndefined();
    const tools = host().manifest.tools;
    for (const name of [
      "bookAppointment",
      "moveAppointment",
      "cancelAppointment",
      "cancelAppointmentByUs",
      "markAppointment",
      "excuseAppointment",
      "reassignAppointment",
      "coachDay",
    ]) {
      expect(tools[name]?.audiences ?? ["staff"], name).toEqual(["staff"]);
    }
    expect(tools.excuseAppointment).toMatchObject({ humanOnly: true, risk: "destructive" });
    expect(tools.cancelAppointmentByUs).toMatchObject({
      personApproves: true,
      risk: "destructive",
    });
    expect(tools.reassignAppointment).toMatchObject({
      personApproves: true,
      permission: "bookings:appointments",
    });
    expect(host().manifest.grantable).toEqual(["bookings:desk", "bookings:appointments"]);
  });
});

describe("the appointment tools", () => {
  it("bookAppointment makes it for the service's length, with the staff member and the warnings", async () => {
    const h = host({
      "record.create": (input) => ({
        id: "apt_new",
        values: { ...(input.values as Record<string, unknown>), room: "room_1", holder: "pass_1" },
        warnings: [{ code: "outside_hours", message: "Outside Ada's open hours" }],
      }),
    });
    const out = await h.runTool(
      "bookAppointment",
      { serviceId: "svc_pt", startsAt: AHEAD, personId: "per_ann", coachId: "coach_a" },
      { caller: STAFF },
    );
    expect(out).toEqual({
      result: "booked",
      appointmentId: "apt_new",
      coachId: "coach_a",
      roomId: "room_1",
      startsAt: AHEAD,
      endsAt: "2030-06-03T10:00:00.000Z",
      holderId: "pass_1",
      paidAtDesk: false,
      warnings: [{ code: "outside_hours", message: "Outside Ada's open hours" }],
    });
    // No room named: the host chooses; who booked it is the caller.
    expect(h.calls.find((c) => c.operation === "record.create")?.input).toEqual({
      object: APPT,
      values: {
        service: "svc_pt",
        person: "per_ann",
        coach: "coach_a",
        startsAt: AHEAD,
        endsAt: "2030-06-03T10:00:00.000Z",
        bookedBy: "usr_desk",
      },
    });
  });

  it("bookAppointment with any coach asks the host who is free; refusals are passed on", async () => {
    const h = host({
      "staffing.free": () => ({
        times: [{ startsAt: AHEAD, endsAt: "", providers: ["coach_b", "coach_a"], room: null }],
      }),
    });
    const out = await h.runTool(
      "bookAppointment",
      { serviceId: "svc_pt", startsAt: AHEAD, personId: "per_ann", paidAtDesk: true },
      { caller: STAFF },
    );
    expect(out).toMatchObject({ result: "booked", coachId: "coach_b", paidAtDesk: true });
    expect(h.calls.find((c) => c.operation === "staffing.free")?.input).toMatchObject({
      object: APPT,
      kind: "svc_pt",
      client: "per_ann",
    });
    const nobody = host({ "staffing.free": () => ({ times: [] }) });
    expect(
      await nobody.runTool(
        "bookAppointment",
        { serviceId: "svc_pt", startsAt: AHEAD, personId: "per_ann" },
        { caller: STAFF },
      ),
    ).toMatchObject({ result: "refused", reason: "no_coach_free" });
    for (const [code, rule, reason] of [
      ["conflict", "double_booked", "double_booked"],
      ["conflict", "room_taken", "room_taken"],
      ["invalid_input", "staffed_account", "no_account"],
      ["invalid_input", "allowance", "no_use"],
      ["invalid_input", "state_closed", "not_offered"],
    ] as const) {
      const r = host({ "record.create": () => refusal(code, rule) });
      expect(
        await r.runTool(
          "bookAppointment",
          { serviceId: "svc_pt", startsAt: AHEAD, personId: "per_ann", coachId: "coach_a" },
          { caller: STAFF },
        ),
      ).toMatchObject({ result: "refused", reason });
    }
  });

  it("moveAppointment makes the new one naming the old, in its room first", async () => {
    const h = host();
    const out = await h.runTool(
      "moveAppointment",
      { appointmentId: "apt_1", startsAt: "2030-06-03T11:00:00.000Z" },
      { caller: STAFF },
    );
    expect(out).toMatchObject({ result: "booked", fromAppointmentId: "apt_1" });
    expect(h.calls.find((c) => c.operation === "record.create")?.input).toEqual({
      object: APPT,
      values: {
        service: "svc_pt",
        person: "per_ann",
        coach: "coach_a",
        startsAt: "2030-06-03T11:00:00.000Z",
        endsAt: "2030-06-03T12:00:00.000Z",
        movedFrom: "apt_1",
        bookedBy: "usr_desk",
        room: "room_1",
      },
    });
    // Its room taken then: asked again with the room left to the host.
    let tries = 0;
    const taken = host({
      "record.create": (input) => {
        tries += 1;
        if ((input.values as Record<string, unknown>).room) refusal("conflict", "room_taken");
        return { id: "apt_2", values: input.values };
      },
    });
    expect(
      await taken.runTool(
        "moveAppointment",
        { appointmentId: "apt_1", startsAt: "2030-06-03T11:00:00.000Z" },
        { caller: STAFF },
      ),
    ).toMatchObject({ result: "booked", appointmentId: "apt_2" });
    expect(tries).toBe(2);
    expect(
      await host().runTool(
        "moveAppointment",
        { appointmentId: "apt_1", startsAt: AHEAD },
        { caller: STAFF },
      ),
    ).toMatchObject({ result: "refused", reason: "same_time" });
  });

  it("cancelAppointment previews the host's pick, then asks it to cancel (or keeps the session)", async () => {
    const h = host({ "state.resolve": () => ({ state: "late_cancelled" }) });
    expect(
      await h.runTool("cancelAppointment", { appointmentId: "apt_1" }, { caller: STAFF }),
    ).toMatchObject({ result: "preview", state: "late_cancelled", late: true });
    await h.runTool(
      "cancelAppointment",
      { appointmentId: "apt_1", confirm: true },
      { caller: STAFF },
    );
    expect(h.calls.find((c) => c.operation === "record.update")?.input).toMatchObject({
      from: "booked",
      values: { state: "cancel" },
    });
    const keep = host();
    expect(
      await keep.runTool(
        "cancelAppointment",
        { appointmentId: "apt_1", confirm: true, keepUse: true },
        { caller: STAFF },
      ),
    ).toMatchObject({ result: "late_cancelled" });
  });

  it("cancelAppointmentByUs cancels for the business with the reason, failing when it cannot", async () => {
    const h = host();
    expect(
      await h.runTool(
        "cancelAppointmentByUs",
        { appointmentId: "apt_1", reason: "Coach ill" },
        { caller: STAFF },
      ),
    ).toEqual({ result: "cancelled_by_us", appointmentId: "apt_1" });
    expect(h.calls.find((c) => c.operation === "record.update")?.input).toMatchObject({
      from: "booked",
      values: { state: "cancelled_by_us", cancelledReason: "Coach ill" },
    });
    await expect(
      h.runTool(
        "cancelAppointmentByUs",
        { appointmentId: "apt_1", reason: "Again" },
        { caller: STAFF },
      ),
    ).rejects.toThrow(/only one still to come/);
  });

  it("markAppointment marks from where it is, with who marked it; excuseAppointment gives it back", async () => {
    const h = host();
    expect(
      await h.runTool(
        "markAppointment",
        { appointmentId: "apt_1", mark: "no_show" },
        { caller: STAFF },
      ),
    ).toMatchObject({ result: "no_show" });
    expect(h.calls.find((c) => c.operation === "record.update")?.input).toMatchObject({
      from: "booked",
      values: { state: "no_show", markedBy: "usr_desk", markedByName: "Desk" },
    });
    expect(
      await h.runTool(
        "excuseAppointment",
        { appointmentId: "apt_1", reason: "Was ill" },
        { caller: STAFF },
      ),
    ).toEqual({ result: "excused", appointmentId: "apt_1" });
    // Excused now: neither marked nor excused again.
    expect(
      await h.runTool(
        "markAppointment",
        { appointmentId: "apt_1", mark: "attended" },
        { caller: STAFF },
      ),
    ).toMatchObject({ result: "refused", reason: "not_booked" });
    const early = host({
      "record.update": () => refusal("invalid_input", "state_window_not_open"),
    });
    expect(
      await early.runTool(
        "markAppointment",
        { appointmentId: "apt_1", mark: "attended" },
        { caller: STAFF },
      ),
    ).toMatchObject({ result: "refused", reason: "not_started" });
  });

  it("reassignAppointment changes the coach only, and passes on a clash", async () => {
    const h = host();
    expect(
      await h.runTool(
        "reassignAppointment",
        { appointmentId: "apt_1", coachId: "coach_b" },
        { caller: STAFF },
      ),
    ).toMatchObject({ result: "booked", coachId: "coach_b" });
    expect(h.calls.find((c) => c.operation === "record.update")?.input).toEqual({
      object: APPT,
      id: "apt_1",
      values: { coach: "coach_b" },
    });
    const busy = host({ "record.update": () => refusal("conflict", "double_booked") });
    expect(
      await busy.runTool(
        "reassignAppointment",
        { appointmentId: "apt_1", coachId: "coach_b" },
        { caller: STAFF },
      ),
    ).toMatchObject({ result: "refused", reason: "double_booked" });
  });

  it("coachDay lists each coach's appointments with the client, and their other shifts", async () => {
    const h = host({
      "staffing.week": () => ({
        zone: "UTC",
        shifts: [
          {
            object: "rostering.shift",
            id: "sh_1",
            title: "Front desk",
            startsAt: "2030-06-03T06:00:00.000Z",
            endsAt: "2030-06-03T08:00:00.000Z",
            place: "Desk",
            account: "usr_a",
          },
          {
            object: APPT,
            id: "apt_1",
            title: "Personal training",
            startsAt: AHEAD,
            endsAt: null,
            place: null,
            account: "usr_a",
          },
        ],
      }),
    });
    const out = await h.runTool<{
      coaches: { coachId: string; items: Record<string, unknown>[] }[];
    }>("coachDay", { date: "2030-06-03", coachId: "coach_a" }, { caller: STAFF });
    expect(out.coaches).toHaveLength(1);
    expect(out.coaches[0]?.items).toEqual([
      expect.objectContaining({ kind: "shift", title: "Front desk", room: "Desk" }),
      expect.objectContaining({
        kind: "appointment",
        id: "apt_1",
        room: "Treatment",
        service: "Personal training",
        client: { id: "per_ann", name: "Ann" },
      }),
    ]);
  });
});
